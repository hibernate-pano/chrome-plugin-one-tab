/**
 * 「保存整窗的占位新标签必须开在同一个窗口」守卫的**变异自证**（2026-10-24）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 占位新标签不限定窗口（退回 `tabs.create({url})`）
 *      ⇒ 「占位新标签带着那个窗口的 windowId」变红
 *   M2 换一个窗口号（等价于串到别处）
 *      ⇒ 同上变红
 *   M3 等价改写（同一个判据换个写法）⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/saveAllTabsWindowScope.test.ts';
const SOURCE = 'src/background/TabManager.ts';

const CREATE_BLOCK = `          await chrome.tabs.create(
            targetWindowId === undefined
              ? { url: 'chrome://newtab' }
              : { url: 'chrome://newtab', windowId: targetWindowId }
          );`;

const CREATE_BLOCK_NO_WINDOW = `          await chrome.tabs.create({ url: 'chrome://newtab' });`;

const CREATE_BLOCK_WRONG_WINDOW = `          await chrome.tabs.create(
            targetWindowId === undefined
              ? { url: 'chrome://newtab' }
              : { url: 'chrome://newtab', windowId: targetWindowId + 1 }
          );`;

const WINDOW_LOOKUP = `          const targetWindowId = tabs.find(
            tab => typeof tab.windowId === 'number'
          )?.windowId;`;

const WINDOW_LOOKUP_EQUIVALENT = `          const targetWindowId = tabs.find(
            tab => typeof tab.windowId === 'number'
          )?.windowId; // 等价写法`;

const cases: MutationCase[] = [
  {
    name: 'M1 占位新标签不限定窗口',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '占位新标签必须开在被关标签所在的那个窗口',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(CREATE_BLOCK, CREATE_BLOCK_NO_WINDOW);
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 占位新标签开到别的窗口',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '占位新标签必须开在被关标签所在的那个窗口',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(CREATE_BLOCK, CREATE_BLOCK_WRONG_WINDOW);
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 等价改写（同一个判据换个写法）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(WINDOW_LOOKUP, WINDOW_LOOKUP_EQUIVALENT);
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('占位新标签窗口作用域守卫的变异自证', () => {
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
