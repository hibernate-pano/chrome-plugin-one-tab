/**
 * 变异自证：DS-43-19 那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/registrySettleRace.test.ts` 钉的是「消费以快照为上界」「残余
 * 说了算」「登记必须 await」；`tests/pendingUploadRegistryRace.test.ts` 钉的
 * 是**运行时**的不变量（晚到的登记活下来、待传标志保留、界面不说「同步成功」）。
 * 听起来都扎实 —— 但一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 * 唯一的验证办法是**把实现改坏，看守卫会不会红**。
 *
 * ── 变异清单（每一条都必须是「真的会坏」）─────────────────────────────────
 *   ① 引擎把「按确认逐条消费」改回**整表清**（= 缺陷的原始形态）
 *   ② 引擎把残余也当成「已消费」（消费越过快照）
 *   ③ 纯函数：消费不再以快照为上界
 *   ④ 纯函数：残余判据不再保留待传
 *   ⑤ 存储层：「还有没传完的东西」退回只读标志（不看白名单）
 *   ⑥ 命令层：保存分支的登记去掉 await
 *   ⑦ 等价改写（局部变量改名）⇒ 必须**仍然绿**（守卫不许钉死字面量）
 *
 * 用法：直接 `node --test tests/guards/registrySettleRaceMutation.test.ts`。
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/registrySettleRace.test.ts';
const RUNTIME = 'tests/pendingUploadRegistryRace.test.ts';
const ENGINE = 'src/services/syncEngine.ts';
const CORE = 'src/core/uploadCoverage.ts';
const STORAGE = 'src/utils/storage.ts';
const HANDLERS = 'src/background/mutationHandlers.ts';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

/** 把源码里的一段文字**全部**换掉（改名类变异要换干净，否则等于改了实现而不是改写法）。 */
const replaceAllIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.split(from).join(to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：DS-43-19 的守卫必须看得见破口', () => {
  it('① 引擎把「按确认逐条消费」改回整表清 ⇒ 运行时守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '整表清白名单',
        testFile: RUNTIME,
        targets: [
          {
            path: ENGINE,
            mutate: source =>
              replaceIn(
                source,
                'residualIds = await storage.consumePendingUploadGroupIds(consumable);',
                'await storage.clearPendingUploadGroupIds();\n          residualIds = [];'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须留在待传队列里',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把按确认消费改回整表清');
  });

  it('② 存储层的消费无视点名清单（整队清空）⇒ 运行时守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '消费无视点名清单',
        testFile: RUNTIME,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                'const remaining = [...new Set(persisted.filter((id) => !settled.has(id)))];',
                'const remaining: string[] = [];'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须留在待传队列里',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让消费无视点名清单（整队清空）');
  });

  it('③ 纯函数：消费不再以快照为上界 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '消费不以上界为限',
        testFile: GUARD,
        targets: [
          {
            path: CORE,
            mutate: source =>
              replaceIn(
                source,
                '  const settled = new Set(unique(input.settledIds));\n  return snapshot.filter(id => settled.has(id));',
                '  const settled = new Set(unique(input.settledIds));\n' +
                  '  return unique([...snapshot, ...settled]);'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '绝不能被这一轮消费掉',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让消费越过快照上界');
  });

  it('④ 纯函数：残余判据不再保留待传 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '残余不再保留待传',
        testFile: GUARD,
        targets: [
          {
            path: CORE,
            mutate: source =>
              replaceIn(
                source,
                '  return { keepPending: unique(input.residualIds).length > 0 };',
                '  return { keepPending: false };'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须保留待传',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让残余判据不再保留待传');
  });

  it('⑤ 存储层：待传读法退回只读标志（不看白名单）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '待传不再派生自白名单',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                '    const flagged = (await kvGet<boolean>(STORAGE_KEYS.PENDING_UPLOAD)) === true;\n' +
                  '    if (flagged) return true;\n' +
                  '    return this.hasPendingUploadRegistryIds();',
                '    return (await kvGet<boolean>(STORAGE_KEYS.PENDING_UPLOAD)) === true;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '标志会被并发写覆盖',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让待传不再看白名单');
  });

  it('⑥ 命令层：保存分支的登记去掉 await ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '登记不 await',
        testFile: GUARD,
        targets: [
          {
            path: HANDLERS,
            mutate: source =>
              replaceIn(
                source,
                '        await scheduleUpload(DELETE_PRIORITY_MS);\n        // ── 2026-10-20 D-9',
                '        scheduleUpload(DELETE_PRIORITY_MS);\n        // ── 2026-10-20 D-9'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '登记必须 await',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把登记的 await 去掉');
  });

  it('⑦ 清位写死成 false（= 回到「无条件清」）⇒ 对账守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '清位写死 false',
        testFile: 'tests/backendParityDefects.test.ts',
        targets: [
          {
            path: ENGINE,
            mutate: source =>
              replaceIn(
                source,
                'await storage.setPendingUpload(settle.keepPending);',
                'await storage.setPendingUpload(false);'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '无条件清',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清位写死成 false');
  });

  it('⑧ 把清位挪到 canClearPending 守卫**外面** ⇒ 对账守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '清位挪出守卫',
        testFile: 'tests/backendParityDefects.test.ts',
        targets: [
          {
            path: ENGINE,
            mutate: source => {
              const removed = replaceIn(
                source,
                '        await storage.setPendingUpload(settle.keepPending);\n',
                ''
              );
              return replaceIn(
                removed,
                "      }\n      report(100, 'none');",
                "      }\n      await storage.setPendingUpload(settle.keepPending);\n      report(100, 'none');"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '守卫内必须重新置位 pending_upload',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清位挪到对账守卫外面');
  });

  it('⑨ 恢复整表清（DS-43-19 的本体）⇒ 对账守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '恢复整表清',
        testFile: 'tests/backendParityDefects.test.ts',
        targets: [
          {
            path: ENGINE,
            mutate: source =>
              replaceIn(
                source,
                'residualIds = await storage.consumePendingUploadGroupIds(consumable);',
                'await storage.clearPendingUploadGroupIds();\n' +
                  '          residualIds = await storage.consumePendingUploadGroupIds(consumable);'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '引擎里不许整表清增量白名单',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '恢复整表清白名单');
  });

  it('⑩ 等价改写（局部变量改名）⇒ 对账守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部变量改名',
        testFile: 'tests/backendParityDefects.test.ts',
        targets: [
          {
            path: ENGINE,
            // 只改**独立出现**的 settle（settledIds 这类带后缀的不动）。
            mutate: source => {
              const next = source.replace(/\bsettle\b/g, 'settlement');
              if (next === source) throw new Error('变异没有生效（源码没变）');
              return next;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部变量换个名字');
  });

  it('⑪ 等价改写（局部变量改名）⇒ 必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部变量改名',
        testFile: GUARD,
        targets: [
          {
            path: ENGINE,
            mutate: source => replaceAllIn(source, 'residualIds', 'leftoverIds'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部变量换个名字');
  });
});
