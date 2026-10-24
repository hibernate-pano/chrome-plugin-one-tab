/**
 * 变异自证：双栏「不留结构性空白」这条守卫必须真的看得见破口。
 *
 * 两条变异分别打**判据层**和**接线**（本仓栽过的两种死法）：
 *
 * · 变异一 —— 切点退回「按卡片张数对半分」
 *   ⇒ 判据层算出来的两栏高度差不再是那个最小值，守卫必须变红。
 * · 变异二 —— 判据层不动，界面把切点忽略掉（整列表塞进左栏）
 *   ⇒ 「判据算对了、界面没接上」那类缺陷，守卫必须变红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/doubleColumnBalance.test.ts';
const SPLIT_FILE = 'src/components/tabs/doubleColumnSplit.ts';

/** 「按卡片张数对半分」—— 张数均匀 ≠ 高度均匀，正是本守卫要挡的那一刀。 */
const HALF_BY_COUNT_BODY = `
export function splitIntoTwoColumns(groups) {
  const half = Math.ceil(groups.length / 2);
  return { left: groups.slice(0, half), right: groups.slice(half) };
}
`;

/** 界面把切点忽略掉：两张判定不出来的卡全塞进左栏，右栏空着。 */
const IGNORE_SPLIT_BRANCH = `const { left, right } = splitIntoTwoColumns(filteredGroups);`;
const IGNORES_SPLIT = `const { left } = splitIntoTwoColumns(filteredGroups); const right = [];`;

describe('变异自证：双栏均衡这条守卫必须看得见破口', () => {
  it('变异一：切点退回「按张数对半分」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '切点按张数对半分',
        testFile: GUARD,
        targets: [
          {
            path: SPLIT_FILE,
            mutate: source => {
              const start = source.indexOf('export function splitIntoTwoColumns');
              if (start < 0) throw new Error('变异前提没成立：找不到 splitIntoTwoColumns');
              return source.slice(0, start) + HALF_BY_COUNT_BODY;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '大卡必须独占一栏',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '切点按张数对半分');
  });

  it('变异二：判据层不动、界面忽略切点（全塞左栏）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '界面忽略切点',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            mutate: source => {
              if (!source.includes(IGNORE_SPLIT_BRANCH)) {
                throw new Error('变异前提没成立：找不到双栏的切栏调用');
              }
              return source.replace(IGNORE_SPLIT_BRANCH, IGNORES_SPLIT);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '界面真的用上了这个切点',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '界面忽略切点');
  });

  it('等价改写：两栏一起渲染但顺序不变 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '先复制一份再切',
        testFile: GUARD,
        targets: [
          {
            path: SPLIT_FILE,
            mutate: source =>
              source.replace(
                'groups.map(estimateCardWeight)',
                '[...groups].map(estimateCardWeight)'
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '先复制一份再切（结果一模一样）');
  });
});
