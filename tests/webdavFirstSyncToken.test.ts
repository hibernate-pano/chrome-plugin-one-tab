// A 组 A2/A3/A4：归属待决令牌（firstSyncPending）与下载失败路径的行为级回归。
//
// ── 这三条是同一处代码的三个面 ────────────────────────────────────────────
// `src/components/sync/WebDavSettings.tsx` 里 :649 附近以前是这样写的：
//
//     showToast('推送完成', 'success');                 // A4：成功先报了
//     await storage.setFirstSyncPending(false);        // A4：KV 写失败 ⇒ 被外层 catch
//                                                      //     报成「推送失败」
// 而 handlePullFromCloud 是：
//
//     setFirstPush({ kind: 'pulling' });
//     const dl = await sendSyncCommand('download', …); // A2：**零** try/catch
//     …
//     await storage.setFirstSyncPending(false);
//
// 三个缺陷各自的后果：
//   A2  sendSyncCommand 在 MV3 SW 被回收后 **reject**（message channel closed）
//       ⇒ firstPush 永远停在 'pulling' ⇒ isFirstPushBusy 恒真 ⇒ 两个推送按钮
//       永久禁用，用户只能重开页面；同时令牌泄漏。
//   A3  令牌置 true 之后，saveError 分支 / handleSwitchBack / handleForget
//       **四处都没有**清它。令牌留着 ⇒ syncEngine 的 suppressFullUpload 恒真
//       ⇒ 历史会话被永久排除在上传之外，界面上零提示（fail-closed 但没有
//       任何路径能让用户发现它）。
//   A4  解除令牌排成功 toast 之后且裸 await 在 try 内 ⇒ KV 写失败被报成
//       「推送失败：<存储错误>。本地数据未受影响。」—— 而合并其实已经成功了。
//
// ── 为什么这样测 ──────────────────────────────────────────────────────────
// 本仓库没有 jsdom / happy-dom / @testing-library，也不为此装依赖
// （见 tests/a11yDialogs.test.ts 顶部注释）。所以「行为级」的可行形态是把
// 三条决策都抽成不依赖 DOM、**写入器可注入**的纯异步函数
// （`firstSyncDecision.ts`），这里直接对它们做行为断言：注入会抛/会成功的
// 假写入器，看输出状态与调用次数。源码字符串断言只作补充护栏。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clearFirstSyncPendingBestEffort,
  completeFirstSyncSuccess,
  isFirstPushBusy,
  releaseFirstSyncPendingOnSaveFailure,
  runPullCommand,
} from '@/sync-backend/webdav/firstSyncDecision';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 记录所有写入的假令牌写入器（可注入一次失败）。 */
const makeWriter = (opts: { fail?: boolean } = {}) => {
  const calls: boolean[] = [];
  const write = async (pending: boolean): Promise<void> => {
    calls.push(pending);
    if (opts.fail) throw new Error('simulated KV write failure');
  };
  return { calls, write };
};

// ══════════════════════════════════════════════════════════════════════════
// A2：下载失败必须收敛成可渲染状态（不得卡在 'pulling'）
// ══════════════════════════════════════════════════════════════════════════
describe('A2 下载命令 reject ⇒ 收敛成 blocked，不再卡在「下载中」', () => {
  const copyOf = (reason: string | undefined) => `（${reason ?? '无'}）`;

  it('命令 reject（SW 被回收）⇒ blocked，且**三个按钮都不再被判为忙**', async () => {
    const writer = makeWriter();
    const errors: unknown[] = [];
    const outcome = await runPullCommand({
      run: async () => {
        throw new Error('The message port closed before a response was received.');
      },
      complete: () => completeFirstSyncSuccess({ write: writer.write, notifySuccess: () => {} }),
      copyOf,
      onError: err => errors.push(err),
    });

    assert.equal(outcome.kind, 'blocked', 'reject 必须变成 blocked（原实现会让 Promise 漂出去）');
    assert.equal(writer.calls.length, 0, '失败时绝不能解除待决令牌（那会打开下一次的无抑制全量）');
    assert.equal(errors.length, 1, 'catch 分支至少要有一次日志出口（兜底纪律）');
    // 这条是缺陷的**直接**后果：'pulling' 是忙态，两个推送按钮都靠它禁用。
    assert.equal(isFirstPushBusy('pulling'), true, '前提：pulling 确实是忙态');
    assert.match(
      (outcome as { reason: string }).reason,
      /无法确认/,
      'SW 中途被杀时不能断言「本机数据未受影响」——页面无从得知合并落没落盘'
    );
    assert.match((outcome as { reason: string }).reason, /重新点一次/, '必须给出可操作的下一步');
  });

  it('命令返回 {ok:false} ⇒ blocked，并翻译机器码', async () => {
    const writer = makeWriter();
    const outcome = await runPullCommand({
      run: async () => ({ ok: false, error: 'recent_upload_guard' }),
      complete: () => completeFirstSyncSuccess({ write: writer.write, notifySuccess: () => {} }),
      copyOf,
    });
    assert.equal(outcome.kind, 'blocked');
    assert.equal(writer.calls.length, 0, '{ok:false} 也不得解除令牌');
    assert.match((outcome as { reason: string }).reason, /recent_upload_guard/, 'reason 必须经过翻译入口');
    assert.match((outcome as { reason: string }).reason, /本机数据未受影响/, '这一态确实没动数据，可以说');
  });

  it('成功 ⇒ done，且令牌**先清、后报成功**', async () => {
    const writer = makeWriter();
    const order: string[] = [];
    const outcome = await runPullCommand({
      run: async () => ({ ok: true }),
      complete: () =>
        completeFirstSyncSuccess({
          write: async p => {
            order.push('clear-token');
            await writer.write(p);
          },
          notifySuccess: () => order.push('toast'),
        }),
      copyOf,
    });
    assert.equal(outcome.kind, 'done');
    assert.equal((outcome as { pendingCleared: boolean }).pendingCleared, true);
    assert.deepEqual(writer.calls, [false], '成功后必须解除令牌（否则历史会话永久不上传）');
    assert.deepEqual(order, ['clear-token', 'toast'], 'A4：清令牌必须排在成功 toast 之前');
  });

  it('成功但 KV 写失败 ⇒ 仍然是 done，只走日志（A4 的核心）', async () => {
    const writer = makeWriter({ fail: true });
    const errors: unknown[] = [];
    let toasted = 0;
    const outcome = await runPullCommand({
      run: async () => ({ ok: true }),
      complete: () =>
        completeFirstSyncSuccess({
          write: writer.write,
          notifySuccess: () => {
            toasted += 1;
          },
          onError: err => errors.push(err),
        }),
      copyOf,
    });

    assert.equal(outcome.kind, 'done', '合并已经成功，KV 写失败不得把它改写成失败');
    assert.equal((outcome as { pendingCleared: boolean }).pendingCleared, false, '如实报告没清掉');
    assert.equal(toasted, 1, '成功提示必须照发 —— 数据真的合了');
    assert.equal(errors.length, 1, '写失败必须有日志出口（兜底纪律）');
  });

  it('失败路径不依赖 complete 是否被调用（原实现的死锁就在这）', async () => {
    // 反向守卫：若哪天有人在失败分支之外也调 complete，或让 runPullCommand
    // 在失败时抛错，上面四条会以不同形式变红。这里显式钉「失败 = 不 complete」。
    let completeCalls = 0;
    await runPullCommand({
      run: async () => ({ ok: false, error: 'precheck_unknown' }),
      complete: async () => {
        completeCalls += 1;
        return { pendingCleared: false };
      },
      copyOf,
    });
    assert.equal(completeCalls, 0, '下载失败时绝不能清令牌：用户还没拿到云端数据，归属仍未决');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A3：保存失败必须退掉**本次**置的令牌；别人的待决态不许动
// ══════════════════════════════════════════════════════════════════════════
describe('A3 保存失败 ⇒ 退掉本次置的令牌（否则历史会话永久不上传）', () => {
  it('本次置过位 ⇒ 保存失败时写回 false', async () => {
    const writer = makeWriter();
    const result = await releaseFirstSyncPendingOnSaveFailure({ setHere: true, write: writer.write });
    assert.deepEqual(writer.calls, [false], '必须显式退回一次');
    assert.deepEqual(result, { attempted: true, ok: true });
  });

  it('本次没置过位 ⇒ 一次写都不做（上一轮的待决态是真实未决的归属决策）', async () => {
    const writer = makeWriter();
    const result = await releaseFirstSyncPendingOnSaveFailure({ setHere: false, write: writer.write });
    assert.deepEqual(writer.calls, [], '清掉别人的待决位会让历史会话在下次自动上传时整批上云');
    assert.deepEqual(result, { attempted: false, ok: true });
  });

  it('写失败 ⇒ 不抛，只走日志（一次保存失败不该变成两条报错）', async () => {
    const writer = makeWriter({ fail: true });
    const errors: unknown[] = [];
    const result = await releaseFirstSyncPendingOnSaveFailure({
      setHere: true,
      write: writer.write,
      onError: err => errors.push(err),
    });
    assert.deepEqual(result, { attempted: true, ok: false });
    assert.equal(errors.length, 1, '必须有日志出口');
  });

  it('成功保存时**不能**走这条路（round 30 的竞态）', async () => {
    // 这条是方向性守卫：它断言的是「该函数只在失败分支被调用」。
    // 源码侧由下面的接线断言覆盖，这里钉住语义 —— 若有人把成功分支也接上，
    // 下一次设置保存后 3 秒的那次自动上传就会变成无抑制全量。
    const writer = makeWriter();
    // 成功的保存根本不该调用它：调用方传 setHere:false 也不够安全 ——
    // 所以真正的守卫是「成功分支里没有这个调用」（见接线断言）。
    await releaseFirstSyncPendingOnSaveFailure({ setHere: false, write: writer.write });
    assert.deepEqual(writer.calls, [], '未置位时零写入是唯一的正确行为');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A3（另一半）：切回云端 / 清除配置后的无条件解除
// ══════════════════════════════════════════════════════════════════════════
describe('A3 后端/配置已变 ⇒ 无条件解除待决令牌（安全方向）', () => {
  it('无条件写 false（这两条路径上待决态已无对象）', async () => {
    const writer = makeWriter();
    const result = await clearFirstSyncPendingBestEffort({ write: writer.write });
    assert.deepEqual(writer.calls, [false]);
    assert.deepEqual(result, { ok: true });
  });

  it('写失败 ⇒ 不抛，只走日志', async () => {
    const writer = makeWriter({ fail: true });
    const errors: unknown[] = [];
    const result = await clearFirstSyncPendingBestEffort({
      write: writer.write,
      onError: err => errors.push(err),
    });
    assert.deepEqual(result, { ok: false });
    assert.equal(errors.length, 1, '必须有日志出口');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 接线护栏（源码层面）：四条路径缺一条就会让令牌泄漏回来
// ══════════════════════════════════════════════════════════════════════════
describe('A2/A3/A4 组件接线', () => {
  const UI = read('src/components/sync/WebDavSettings.tsx');
  const CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const sliceOf = (from: string, to: string): string => {
    const start = CODE.indexOf(from);
    assert.ok(start > -1, `找不到锚点：${from}`);
    const end = CODE.indexOf(to, start);
    return CODE.slice(start, end > start ? end : CODE.length);
  };

  it('handlePullFromCloud 走 runPullCommand（不再裸 await sendSyncCommand）', () => {
    const body = sliceOf('const handlePullFromCloud = useCallback(', 'const handleSwitchBack = useCallback(');
    assert.match(body, /await runPullCommand\(/, '下载命令必须经收敛函数，否则 reject 会把 UI 卡在 pulling');
    assert.ok(
      !/const dl = await sendSyncCommand\('download'/.test(body),
      '裸 await 不得复活 —— 那正是 A2 的成因'
    );
  });

  it('runPush 与 handlePullFromCloud 都经 completeFirstSyncSuccess（A4 顺序在此落地）', () => {
    const push = sliceOf('const runPush = useCallback(', 'const downloadReasonCopy');
    const pull = sliceOf('const handlePullFromCloud = useCallback(', 'const handleSwitchBack = useCallback(');
    for (const [name, body] of [
      ['runPush', push],
      ['handlePullFromCloud', pull],
    ] as const) {
      assert.match(body, /completeFirstSyncSuccess\(/, `${name} 必须经收尾函数（先清令牌、再报成功）`);
      assert.ok(
        !/await storage\.setFirstSyncPending\(false\)/.test(body),
        `${name} 里不得再有裸 await 清令牌 —— KV 写失败会被外层 catch 报成「失败」`
      );
    }
  });

  it('保存失败的两条分支（return / throw）都要退令牌', () => {
    const body = sliceOf('const handleSave = useCallback(', 'const probeRemote = useCallback(');
    const occurrences = body.match(/releaseFirstSyncPendingIfSetHere\(/g) ?? [];
    assert.equal(occurrences.length, 2, 'saveError 分支与 catch 分支各需一次（漏一处就泄漏一次）');
    assert.match(body, /let firstSyncPendingSetHere = false/, '必须记录「本次有没有置位」');
    assert.match(body, /firstSyncPendingSetHere = true/, '置位时必须记下来');
  });

  it('切回云端与清除配置都要解除令牌；锁定**刻意不清**', () => {
    // 2026-10-19 审计 V-4：handleForget 现在是「确认框包装」，
    // 真正的执行体叫 runForget —— 下面断言的是**执行体**的行为。
    const switchBack = sliceOf('const handleSwitchBack = useCallback(', 'const runForget = useCallback(');
    const forget = sliceOf('const runForget = useCallback(', 'const handleLock = useCallback(');
    const lock = sliceOf('const handleLock = useCallback(', 'data-testid="webdav-settings"');
    assert.match(switchBack, /clearPendingToken\(/, '切回云端后待决态已无对象');
    assert.match(forget, /clearPendingToken\(/, '配置清空后待决态已无对象');
    assert.ok(
      !/clearPendingToken\(/.test(lock),
      '锁定时不得清：配置与后端都没变，退掉它会让解锁后第一次保存触发无抑制全量'
    );
  });

  it('成功保存分支里没有退令牌的调用（round 30 竞态）', () => {
    const body = sliceOf('const handleSave = useCallback(', 'const probeRemote = useCallback(');
    // 成功路径 = 从 `notifyWebDavConfigChanged()` 到函数结尾（catch 之前）。
    const successStart = body.indexOf('notifyWebDavConfigChanged()');
    // 外层的 catch 是**最后一个** `} catch (err) {`（前面还有一个内层 catch
    // 属于 resyncAlarm 的 try）。
    const catchAt = body.lastIndexOf('} catch (err) {');
    assert.ok(successStart > -1 && catchAt > successStart, '锚点漂了');
    const successBody = body.slice(successStart, catchAt);
    assert.ok(
      !/setFirstSyncPending|releaseFirstSyncPending|clearPendingToken/.test(successBody),
      '成功保存后 3 秒 autoSyncMiddleware 会排一次上传；此刻清令牌会让那次成为无抑制全量'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A5：切回云端必须 invalidate 后端缓存（否则下一次同步仍写向 WebDAV）
// ══════════════════════════════════════════════════════════════════════════
describe('A5 handleSwitchBack 必须 invalidateActiveSyncBackend', () => {
  const UI = read('src/components/sync/WebDavSettings.tsx');
  const CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const body = CODE.slice(
    CODE.indexOf('const handleSwitchBack = useCallback('),
    CODE.indexOf('const runForget = useCallback(')
  );

  it('clearSessionSecrets 之后必须 invalidate（清口令不够：旧 adapter 里的 Vault 还活着）', () => {
    const secretsAt = body.indexOf('await clearSessionSecrets()');
    const invalidateAt = body.indexOf('invalidateActiveSyncBackend()');
    assert.ok(secretsAt > -1, '应能找到 clearSessionSecrets');
    assert.ok(
      invalidateAt > secretsAt,
      'resyncAlarm 消息超时时 SW 里那个 adapter 不会被清，而 ensureBackendPrimed 对非空缓存早退'
    );
  });

  it('三个「后端已变」的 handler 都调了 invalidate（不留特例）', () => {
    for (const [name, from, to] of [
      ['handleSwitchBack', 'const handleSwitchBack = useCallback(', 'const runForget = useCallback('],
      ['handleForget', 'const runForget = useCallback(', 'const handleLock = useCallback('],
      ['handleLock', 'const handleLock = useCallback(', 'data-testid="webdav-settings"'],
    ] as const) {
      const slice = CODE.slice(CODE.indexOf(from), CODE.indexOf(to));
      assert.match(slice, /invalidateActiveSyncBackend\(\)/, `${name} 缺 invalidate ⇒ 旧后端阴魂不散`);
    }
  });
});
