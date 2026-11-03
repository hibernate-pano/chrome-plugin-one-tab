/**
 * 变异自证：「清理旧会话」这条链上的守卫必须真的看得见破口（2026-11-03）。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这些变异分别证明什么 ──────────────────────────────────────────────────
 *
 *   M1 时间档不再跳过锁定          ⇒ 判据层那条「锁定的跳过并计数」变红
 *   M2 日历月钳制被去掉（溢出回来）⇒ 判据层那条「3 月 31 日」变红
 *   M3 执行时不再跳过已锁定的      ⇒ 执行层那条「此刻已锁定的跳过」变红
 *   M4 回执对锁定情形改说「已被移除」⇒ 文案那条「不许说其余已被移除」变红
 *   M5 行模型不再过滤 0 条的档位   ⇒ 行模型那条「只有算出来有东西的档位才出现」变红
 *   M6 两档「全部」的小字说反了    ⇒ 行模型那条「说的正好相反」变红
 *   M7 界面不按 path 分派（都走 deleteGroups）⇒ 接线守卫那条「必须按 path 分派」变红
 *   M8 界面读磁盘失败还继续删      ⇒ 接线守卫那条「读失败必须中止」变红
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const PLAN_TEST = 'tests/cleanupPlan.test.ts';
const OPS_TEST = 'tests/cleanupDeleteGroups.test.ts';
const MESSAGES_TEST = 'tests/cleanupMessages.test.ts';
const MODEL_TEST = 'tests/cleanupMenuModel.test.ts';
const MENU_GUARD = 'tests/guards/cleanupMenu.test.ts';

describe('变异自证：清理旧会话的判据 / 执行 / 文案 / 界面都必须看得见破口', () => {
  it('M1：时间档不再跳过锁定 ⇒ 判据层必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '时间档把锁定的也算进待删清单',
        testFile: PLAN_TEST,
        targets: [
          {
            path: 'src/core/cleanupPlan.ts',
            mutate: source => {
              const next = source.replace(
                / {6}if \(group\.isLocked\) \{\n {8}lockedSkippedCount \+= 1;\n {8}continue;\n {6}\}/,
                ''
              );
              if (next === source) throw new Error('变异前提没成立：找不到时间档跳过锁定那段');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '锁定的会话不得进入待删清单',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让时间档把锁定的会话也算进待删清单');
  });

  it('M2：日历月钳制被去掉（日期溢出回来）⇒ 判据层必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'monthsBefore 不再把日钳到目标月最后一天',
        testFile: PLAN_TEST,
        targets: [
          {
            path: 'src/core/cleanupPlan.ts',
            mutate: source => {
              const next = source.replace(
                'result.setDate(Math.min(now.getDate(), daysInTargetMonth));',
                'result.setDate(now.getDate());'
              );
              if (next === source) throw new Error('变异前提没成立：找不到日钳制那一行');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '日历月钳制：3 月 31 日退回 2 月 28 日',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '去掉日历月钳制（截止点变晚 ⇒ 多删）');
  });

  it('M3：执行时不再跳过已锁定的 ⇒ 执行层必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'applyDeleteGroups 硬删已锁定的会话',
        testFile: OPS_TEST,
        targets: [
          {
            path: 'src/core/mutationOps.ts',
            mutate: source => {
              const next = source.replace(
                / {4}if \(target\.isLocked\) \{\n {6}if \(!skippedLocked\.includes\(id\)\) skippedLocked\.push\(id\);[\s\S]*?\n {4}\}/,
                ''
              );
              if (next === source) throw new Error('变异前提没成立：找不到执行时跳过锁定那段');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '执行时刻被锁定的必须单列出来',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让执行层硬删执行时刻被锁定的会话');
  });

  it('M4：回执对锁定情形改说「已被移除」⇒ 文案层必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'cleanupSuccessMessage 不再区分锁定跳过',
        testFile: MESSAGES_TEST,
        targets: [
          {
            path: 'src/components/layout/deleteAllMessages.ts',
            mutate: source => {
              const next = source.replace(
                'if (skippedLocked > 0) {',
                'if (false) {'
              );
              if (next === source) throw new Error('变异前提没成立：找不到跳过锁定那个分支');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '锁定跳过必须说出真实原因',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让回执对锁定情形说「已被移除」');
  });

  it('M5：行模型不再过滤 0 条的档位 ⇒ 行模型必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'cleanupMenuRows 把 0 条的档位也摆出来',
        testFile: MODEL_TEST,
        targets: [
          {
            path: 'src/components/layout/cleanupMenuModel.ts',
            mutate: source => {
              const next = source.replace(
                '    if (plan.groupCount === 0) continue;',
                ''
              );
              if (next === source) throw new Error('变异前提没成立：找不到 0 条过滤那一行');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '六个月前那一档没货 ⇒ 不得出现',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让行模型把 0 条的档位也摆出来');
  });

  it('M6：两档「全部」的小字说反了 ⇒ 行模型必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「保留锁定」那行改用「含锁定」的小字',
        testFile: MODEL_TEST,
        targets: [
          {
            path: 'src/components/layout/cleanupMenuModel.ts',
            mutate: source => {
              const next = source.replace(
                'warning: deleteAllKeepLockedMenuWarning({',
                'warning: deleteAllMenuWarning({'
              );
              if (next === source) throw new Error('变异前提没成立：找不到「保留锁定」的小字');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '「保留锁定」那行必须说清锁定的会留下',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把两档「全部」的小字说反');
  });

  it('M7：界面不按 path 分派（两档「全部」都走 deleteGroups）⇒ 接线守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '界面忽略 row.path，一律走 deleteGroups',
        testFile: MENU_GUARD,
        targets: [
          {
            path: 'src/components/layout/HeaderDropdown.tsx',
            mutate: source => {
              const next = source.replace(
                "if (row.path === 'deleteAll') {",
                'if (false) {'
              );
              if (next === source) throw new Error('变异前提没成立：找不到按 path 分派那段');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须按 row.path 分派',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让界面不按 path 分派');
  });

  it('M8：读磁盘失败还继续删（fail closed 被破）⇒ 接线守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '读磁盘失败时不中止',
        testFile: MENU_GUARD,
        targets: [
          {
            path: 'src/components/layout/HeaderDropdown.tsx',
            mutate: source => {
              const next = source.replace(
                "      showToast(CLEANUP_READ_FAILED_MESSAGE, 'error');\n      return;",
                '      showToast(CLEANUP_READ_FAILED_MESSAGE, \'error\');'
              );
              if (next === source) throw new Error('变异前提没成立：找不到读失败中止那段');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '读失败必须中止',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让读磁盘失败时不中止');
  });
});
