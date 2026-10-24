/**
 * PERF-03 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 远卡也渲染真卡（去掉窗口化）        ⇒ ① 变红
 *      （这就是 2026-10-24 之前的实现：1000 张卡全部挂载）
 *   M2 标签数算错（占位高度与行数脱钩）    ⇒ ② 变红
 *   M3 等价改写（showCard 的布尔式换一种写法）⇒ 仍然全绿
 *
 * ⚠️ 守卫里另外两条（③ 降级路径、④ 提前量有界）不由这里的变异覆盖：
 *    它们防的是「把窗口化做成「列表空了」」这类反向事故，
 *    由守卫自身的断言守着（自证在守卫里已经成立）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/perf03CardWindowing.test.ts';
const DRAGGABLE = 'src/components/dnd/DraggableTabGroup.tsx';

const cases: MutationCase[] = [
  {
    name: 'M1 远卡也渲染真卡（去掉窗口化）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '窗口化失效：远离视口的卡必须只留等高占位',
    targets: [
      {
        path: DRAGGABLE,
        mutate: source => {
          const next = source.replace(
            'const showCard = isNearViewport || focused;',
            'const showCard = true;'
          );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 占位高度与标签数脱钩（恒按 0 行算）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '占位高度必须由「行数 × 量出来的行距」算出来',
    targets: [
      {
        path: DRAGGABLE,
        mutate: source => {
          const next = source.replace(
            'const cardHeight = cardHeightFor(group.tabs.length, headerHeight, rowStride, collapsed);',
            'const cardHeight = cardHeightFor(0, headerHeight, rowStride, collapsed);'
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 等价改写（showCard 的布尔式换一种写法）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: DRAGGABLE,
        mutate: source => {
          const next = source.replace(
            'const showCard = isNearViewport || focused;',
            'const showCard = focused ? true : isNearViewport;'
          );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('PERF-03 守卫的变异自证', () => {
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
