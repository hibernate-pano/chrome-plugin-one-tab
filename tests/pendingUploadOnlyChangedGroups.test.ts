// WebDAV「归属待决」期只上传本次操作改动过的会话（2026-10-18 round 30）。
//
// 背景：`webdav_first_sync_pending` 期间自动上传必须只传本次改动，而适配器降级后
// 用的判据是 `selectDirty(groups, 水位)` —— 远端还没有 manifest 时水位恒为 0，
// 全部历史会话都被判成脏 ⇒ 抑制前后上传内容逐字相同（死代码，2026-10-18 实测）。
// 判据改成写方一路记下来的 id：保存路径知道它刚写了哪个组，mutation 命令本身
// 也带着受影响的 id（core/mutationAffectedGroups）。
//
// 真机复现见 /tmp/one-tab-loop/verify-round30.mjs（dufs 独立 WebDAV + 全新远端）。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const read = (rel: string) =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

const g = (id: string) => ({ id, name: id, tabs: [], createdAt: '', updatedAt: '', version: 1, isLocked: false }) as unknown as TabGroup;

describe('affectedGroupIdsOf：命令 → 受影响的会话 id', () => {
  it('覆盖全部 9 种命令，且不靠 stamp / 水位去猜', async () => {
    const { affectedGroupIdsOf } = await import('@/core/mutationAffectedGroups');
    assert.deepEqual(affectedGroupIdsOf({ op: 'saveGroup', group: g('new') }), ['new']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'removeTab', groupId: 'a', tabId: 't' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'deleteGroup', groupId: 'a' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'renameGroup', groupId: 'a', name: 'n' }), ['a']);
    assert.deepEqual(affectedGroupIdsOf({ op: 'toggleGroupLock', groupId: 'a' }), ['a']);
    assert.deepEqual(
      affectedGroupIdsOf({ op: 'importGroups', groups: [g('i1'), g('i2')] }),
      ['i1', 'i2']
    );
    assert.deepEqual(
      affectedGroupIdsOf({
        op: 'moveTab', sourceGroupId: 's', sourceIndex: 0, targetGroupId: 't', targetIndex: 0,
      }),
      ['s', 't'],
      '搬动的两端都算改动（源组少一条、目标组多一条）'
    );
  });

  it('deleteAllGroups / cleanDuplicates 返回空集（fail-closed，不会顺带把历史全传上去）', async () => {
    const { affectedGroupIdsOf } = await import('@/core/mutationAffectedGroups');
    assert.deepEqual(affectedGroupIdsOf({ op: 'deleteAllGroups' }), []);
    assert.deepEqual(affectedGroupIdsOf({ op: 'cleanDuplicates' }), []);
  });
});

describe('写方把 id 一路传下来（保存路径 + mutation）', () => {
  it('保存路径登记新会话 id（两处调用点都传）', async () => {
    const src = await read('src/background/TabManager.ts');
    const calls = src.match(/syncEngine\.scheduleUpload\(UPLOAD_DEBOUNCE_MS[^)]*\)/g) ?? [];
    assert.equal(calls.length, 2, '保存当前窗口 / 保存当前标签两条路径都要传');
    for (const c of calls) assert.match(c, /\[safeGroup\.id\]/, `必须传改动 id：${c}`);
  });

  it('mutationHandlers 一处提取、所有分支都走它（含 deps 包装转发）', async () => {
    const src = await read('src/background/mutationHandlers.ts');
    assert.match(src, /const changedIds = affectedGroupIdsOf\(cmd\)/, '必须一处提取');
    assert.match(src, /const scheduleUpload = \(\s*delayMs: number,\s*ids: readonly string\[\] = changedIds/,
      '分支必须走带默认值的局部包装');
    const bare = src.match(/(?<!\.)\bd\.scheduleUpload\(/g) ?? [];
    assert.equal(bare.length, 1, '只许局部包装那一处直连 d.scheduleUpload（分支绕过去会丢掉改动集）');
    assert.match(src, /d\.scheduleUpload\(delayMs, ids\)/, '那一处必须把 ids 转发下去');
    assert.match(src, /deps\.scheduleUpload\(ms, ids\)/, 'deps 包装必须转发 ids，不能吞掉');
  });

  it('cleanDuplicates 用计划里的 id 显式覆盖（命令里没有 id 可提取）', async () => {
    const src = await read('src/background/mutationHandlers.ts');
    assert.match(src, /removedTabsByGroup\.map\(e => e\.groupId\)/,
      '改动集必须取自删除计划');
  });

  it('mutationService 把 id 透传给 syncEngine', async () => {
    const src = await read('src/background/mutationService.ts');
    assert.match(src, /scheduleUpload: \(ms, changedGroupIds\) => syncEngine\.scheduleUpload\(ms, changedGroupIds\)/);
  });
});

describe('syncEngine：待决期按 id 过滤，且 fail-closed', () => {
  it('抑制生效时用记下来的 id 过滤，而不是交给适配器按水位猜', async () => {
    const src = await read('src/services/syncEngine.ts');
    // 判据 2026-10-18 归入 decideSuppressFullUpload（纯函数，为的是能对它
    // 的每种后端组合打行为断言）；这里继续钉「那个判据存在且被用上」。
    const fnStart = src.indexOf('export function decideSuppressFullUpload');
    assert.ok(fnStart > 0, '找不到 decideSuppressFullUpload');
    assert.match(
      src.slice(fnStart),
      /args\.firstSyncPending &&\s*!args\.explicitFirstSync &&\s*!args\.overwriteCloud/,
      '三个前提缺一不可（待决 + 非显式 + 非覆盖）'
    );
    assert.match(src, /const suppressFullUpload = decideSuppressFullUpload\(\{/);
    assert.match(src, /new Set\(await storage\.getPendingUploadGroupIds\(\)\)/);
    assert.match(src, /activeGroups\.filter\(g => changedGroupIds\.has\(g\.id\)\)/);
    assert.match(src, /uploadTabGroups\(\s*groupsForUpload,/, '上传的必须是过滤后的清单');
  });

  it('白名单与 pending_upload 一起落盘，且快路径等它写完再上传', async () => {
    const src = await read('src/services/syncEngine.ts');
    assert.match(src, /storage\.noteGroupsChanged\(changedGroupIds\)/);
    const fast = src.match(/void noted\s*\n?\s*\.then\(\(\) => enqueue\('sync:upload'/g) ?? [];
    assert.equal(fast.length, 2, '快路径与 fallback 都要等 noted（否则可能读到没写全的白名单）');
  });

  it('上传成功后清白名单；进入/离开待决态时也清（防陈旧 id 把历史会话推上去）', async () => {
    const engine = await read('src/services/syncEngine.ts');
    assert.match(engine, /await storage\.clearPendingUploadGroupIds\(\)/);
    const storageSrc = await read('src/utils/storage.ts');
    // ⚠️ 2026-10-20：窗口从「固定 900 字符」改成「切到**下一个方法**为止」。
    //
    // 为什么必须改：待决位改成按库寻址后，`setFirstSyncPending` 前面多了一段
    // 读-改-写（把全局单值规范化成「作用域 → 布尔」的记录），于是那句
    // `clearPendingUploadGroupIds()` 被推到了 900 字符窗口**之外** ——
    // 守卫红了，但**它要守的不变量一点没变**（两个方向都要清）。
    //
    // 这就是本仓记忆 `stale-literal-guards-block-correct-fixes` 的形态：
    // 守卫钉的是「实现长什么样」，不是「行为对不对」。窗口越界是典型的
    // 误报 —— 修法是让窗口跟着**语义边界**走（下一个方法），
    // 而不是把数字调大（调大只是把同一个坑推远一点）。
    const start = storageSrc.indexOf('async setFirstSyncPending');
    assert.ok(start > 0, '找不到 setFirstSyncPending');
    const rest = storageSrc.slice(start);
    const nextMethod = rest.indexOf('\n  async ', 1);
    const fn = nextMethod > 0 ? rest.slice(0, nextMethod) : rest;
    assert.match(
      fn,
      /await this\.clearPendingUploadGroupIds\(\);/,
      'setFirstSyncPending 两个方向都要清：进待决态时清掉此前攒下的「历史」id，' +
        '否则刚切到 WebDAV 的那次自动上传照样会把历史会话推上去（抑制再次成为死代码）'
    );
  });

  it('抑制只对自带存储生效（残留标志不许把云端上传也按白名单过滤）', async () => {
    const src = await read('src/services/syncEngine.ts');
    // 2026-10-18 B 组：判据必须是 `!== 'supabase'` 而不是 `=== 'webdav'`。
    // 两个都对「读到了 supabase」成立（抑制关闭），但在**读不到设置**时反了：
    // `=== 'webdav'` 对 null 为 false ⇒ 抑制关闭 ⇒ 清单退回全量；而 `!== supabase`
    // 对 null 为 true ⇒ 保持抑制。后者才是安全方向（多传不可回滚）。
    assert.match(
      src,
      /configuredBackendId\s*!==\s*'supabase'/,
      '必须显式判后端，且写成 !==\'supabase\'（读不到设置时保持抑制）'
    );
    assert.doesNotMatch(
      src.slice(src.indexOf('export function decideSuppressFullUpload')),
      /configuredBackendId\s*===\s*'webdav'/,
      '不得写成 ===\'webdav\'：读不到设置时它会关掉抑制，让待决期历史会话整批上云'
    );
  });

  it('切到自带存储时，待决标志必须排在 resyncAlarm 之前落盘', async () => {
    const src = await read('src/components/sync/WebDavSettings.tsx');
    // ⚠️ 2026-10-20：置位调用从 `storage.setFirstSyncPending(true)` 变成
    // `writePending(true)`（写入器改成**按库寻址**，见 handleSave）。
    //
    // 不变量没变：**置位必须排在 resyncAlarm 之前**。所以这里钉的是
    // 「置位的那次调用」而不是「某个具体字面量」——
    // 否则下一次有人把写入器换个名字，这条守卫又会误报一遍
    // （本仓记忆 `stale-literal-guards-block-correct-fixes` 的形态）。
    //
    // 怎么认得「置位的那次调用」：它是**传入 true** 的那次置位。
    // 两个候选形态都认（直接调 storage 的、或经写入器的），
    // 取**最早**的那个 —— 那就是真正的置位点。
    const candidates = [
      src.indexOf('setFirstSyncPending(true)'),
      src.indexOf('writePending(true)'),
    ].filter(i => i >= 0);
    const flag = candidates.length > 0 ? Math.min(...candidates) : -1;
    const resync = src.indexOf("await sendSyncCommand('resyncAlarm')");
    assert.ok(flag > 0 && resync > 0, '两处都要在');
    assert.ok(
      flag < resync,
      'resyncAlarm 会让 SW 立刻补一次上传；标志若还没落盘，那次上传就是无抑制的全量 ' +
        '⇒ 刚切到自带存储、历史会话已经上了云盘（round 30 真机抓到）'
    );
  });

  it('读不到白名单就返回空集（fail-closed：待决期宁可不传，也不多传）', async () => {
    const storageSrc = await read('src/utils/storage.ts');
    const fn = storageSrc.slice(
      storageSrc.indexOf('async getPendingUploadGroupIds'),
      storageSrc.indexOf('async noteGroupsChanged')
    );
    assert.match(fn, /catch \{[\s\S]{0,80}return \[\];/, '读失败必须返回空数组');
    assert.match(fn, /if \(!Array\.isArray\(raw\)\) return \[\];/, '非数组一律当空');
  });
});
