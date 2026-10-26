/**
 * 「点扩展图标 = 一定打开标签管理器」守卫的**变异自证**（2026-10-26）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 不按「点的那一个窗口」查（退回 currentWindow）⇒ 「必须按「点图标那一个窗口」查」变红
 *   M2 管理器不限定在同一个窗口                ⇒ 「管理器必须开在点图标那一个窗口」变红
 *   M3 管理器失败时报「无法保存」（谎报）      ⇒ 「保存已经成功了」变红
 *   M4 没有可收集的标签时照样进保存            ⇒ 「不许进保存」变红
 *   M5 没有可收集的标签时不打开管理器          ⇒ 「也必须打开管理器」变红
 *   M6 收集失败时不打开管理器                  ⇒ 「收集失败也要落到管理器上」变红
 *   M7 等价改写（同一个判据换个写法）           ⇒ 仍然全绿
 *
 * ⚠️ M4 与 M7 的区别只在一行：M4 把「没有可收集的标签」这个**提前返回**
 *   去掉（于是照样进保存）；M7 改的是同一处的**写法**（`=== 0` 换成
 *   `!collectable` **不行** —— `null`（判断失败）会被 `!` 判成真 ⇒ 那是
 *   行为变更，属于 M4 那一类）。
 *   ⇒ 这里用「查询参数的等价写法」做对照组，避免自己骗自己。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/iconClickAlwaysOpensManager.test.ts';
const SOURCE = 'src/background/iconClickAction.ts';

const QUERY_BLOCK = `    tabs = await deps.queryTabs(
      windowId === undefined ? { currentWindow: true } : { windowId }
    );`;

const MANAGER_CALL = '    await deps.openTabManager(true, windowId);';

const LIE_MESSAGE = `    await deps.notify(
      collected
        ? '已保存当前窗口，但没能打开会话管理器。'
        : '没能打开会话管理器。',
      'error'
    );`;

/** 「没有可收集的标签 ⇒ 直接打开管理器」这一段（提前返回）。 */
const NOTHING_TO_COLLECT_BLOCK = `  if (collectable === 0) {
    // 没有可收集的标签 ⇒ **不进保存**（也就不会弹「没有可保存的标签页」
    // 那条错误）⇒ 直接打开管理器。
    return { kind: 'nothing-to-collect', managerOpened: await openManager(deps, windowId, false) };
  }`;

/** 保存方抛错那一段。 */
const SAVE_THROWS_BLOCK = `  } catch {
    // 保存方（\`TabManager.saveAllTabs\`）在抛出前**自己报过**原因
    // （「保存标签页时发生错误，请重试」）⇒ 不再补第二条错误提示
    // （重复报会让人以为是两个故障）。
    return { kind: 'collect-failed', managerOpened: await openManager(deps, windowId, false) };
  }`;

const cases: MutationCase[] = [
  {
    name: 'M1 不按「点的那一个窗口」查（退回 currentWindow）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '必须按「点图标那一个窗口」查',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            QUERY_BLOCK,
            '    tabs = await deps.queryTabs({ currentWindow: true });'
          );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 管理器不限定在同一个窗口',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '管理器必须开在点图标那一个窗口',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(MANAGER_CALL, '    await deps.openTabManager(true);');
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 管理器失败时报「无法保存」（谎报）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '保存已经成功了',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            LIE_MESSAGE,
            "    await deps.notify('无法保存当前窗口，请重试。如果问题持续，请重启浏览器。', 'error');"
          );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M4 没有可收集的标签时照样进保存',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '**不许**进保存',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            NOTHING_TO_COLLECT_BLOCK,
            '  if (collectable === 0) {\n    // 变异：照样往下走（进保存）\n  }'
          );
          assert.notEqual(next, source, 'M4 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M5 没有可收集的标签时不打开管理器（退回 1.29.0 之前的行为）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '没有可收集的标签也必须打开管理器',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            NOTHING_TO_COLLECT_BLOCK,
            "  if (collectable === 0) {\n    return { kind: 'nothing-to-collect', managerOpened: false };\n  }"
          );
          assert.notEqual(next, source, 'M5 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M6 收集失败时不打开管理器',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '收集失败也要落到管理器上',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            SAVE_THROWS_BLOCK,
            SAVE_THROWS_BLOCK.replace(
              "return { kind: 'collect-failed', managerOpened: await openManager(deps, windowId, false) };",
              "return { kind: 'collect-failed', managerOpened: false };"
            )
          );
          assert.notEqual(next, source, 'M6 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M7 等价改写（同一个判据换个写法）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(
            QUERY_BLOCK,
            `    tabs = await deps.queryTabs(
      windowId === undefined ? { currentWindow: true } : { windowId: windowId }
    );`
          );
          assert.notEqual(next, source, 'M7 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('图标点击守卫的变异自证', () => {
  it('每条变异都落在预期的断言上（且等价改写不误报）', () => {
    const outcomes = runMutationCases(cases);
    assert.equal(outcomes.length, cases.length);
    outcomes.forEach((outcome, i) => {
      const testCase = cases[i];
      assertMutationOutcome(
        outcome,
        testCase.expectRed,
        `${testCase.name}（守卫：${testCase.testFile}）`
      );
    });
  });
});
