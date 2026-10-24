/**
 * 「点扩展图标 = 保存并关闭」守卫的**变异自证**（2026-10-24）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 不按「点的那一个窗口」查（退回 currentWindow）⇒ 「① 存的是点的那一个窗口」变红
 *   M2 管理器不限定在同一个窗口              ⇒ 「② 管理器开在同一个窗口」变红
 *   M3 管理器失败时报「无法保存」（谎报）     ⇒ 「④ 说的是『已保存』」变红
 *   M4 等价改写（同一个判据换个写法）          ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/iconClickSavesWindow.test.ts';
const SOURCE = 'src/background/iconClickAction.ts';

const QUERY_BLOCK = `    tabs = await deps.queryTabs(
      windowId === undefined ? { currentWindow: true } : { windowId }
    );`;

const MANAGER_CALL = '    await deps.openTabManager(true, windowId);';

const LIE_MESSAGE =
  "    await deps.notify('已保存当前窗口，但没能打开会话管理器。', 'error');";

const WINDOW_ID_BODY = `  const windowId = clickedTab?.windowId;
  return typeof windowId === 'number' ? windowId : undefined;`;

const WINDOW_ID_BODY_EQUIVALENT = `  const windowId = clickedTab?.windowId;
  return typeof windowId === 'number' ? windowId : undefined; // 等价写法`;

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
    name: 'M4 等价改写（同一个判据换个写法）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(WINDOW_ID_BODY, WINDOW_ID_BODY_EQUIVALENT);
          assert.notEqual(next, source, 'M4 变异没有生效');
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
