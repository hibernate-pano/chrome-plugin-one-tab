/**
 * 双栏必须**不留结构性空白**（2026-10-24 产品负责人判定的缺陷）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 1.26.0–1.28.0 的双栏是「卡片直接当网格子项、行主序摆放」：
 *
 *   左侧：卡片1（矮）        右侧：卡片2（高）
 *          ← 174px 空白 →          ← 顶到卡片3 →
 *
 * 同一行两张卡高度不同 ⇒ 短的那张下面**必然**空一块。真机实测：
 * 卡片底边 `[246, 420, 549, 723, 852, 1026]`，每行差 174px。
 * 产品负责人原话：「双栏的标签组没有对齐，比如左边长右边短，或者右边长左边短，
 * 会导致大量空白，这肯定有问题。之前的模式就挺好的。」
 *
 * ── 修法 ─────────────────────────────────────────────────────────────────
 * 回到「两栏各自纵向堆叠」（v1.25.1 的形状），但**分栏方式不同**：
 * 连续切一刀（`splitIntoTwoColumns`），切点取「两栏估计高度差最小」。
 * ⇒ 卡片不再两两配对，结构性的洞没了；同时左栏在前、右栏在后保持排序序
 * （v1.25.1 的贪心轮流放会打乱顺序，见 doubleColumnOrderHonesty.test.ts）。
 *
 * ── 这条守卫钉的是两条性质 ───────────────────────────────────────────────
 *
 * ① **切点取最齐的那一刀**
 *   穷举所有连续切法，取两栏估计高度差最小者。若有人改回「按卡片张数对半分」，
 *   在 `[5,1,1,1]` 这种形状上就会露馅（对半分 = 8 vs 4，最优 = 6 vs 6）。
 *
 * ② **界面真的用了这个切点**
 *   判据层算对了、界面没接上，是本仓反复栽的坑（L-10 / R-6 / R-11）
 *   ⇒ 必须把渲染产物摊开，读出每一栏里实际有哪几张卡，与判据逐张比对。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeGroups, renderTabList } from '../_helpers/tabListHarness.ts';
import { commonAncestor, findAll, classList, type HtmlElement } from '../_helpers/htmlTree.ts';
import { estimateCardWeight, splitIntoTwoColumns } from '@/components/tabs/doubleColumnSplit';
import { sortSessions } from '@/core/sessionSort';
import type { TabGroup } from '@/types/tab';

/** 会话卡标题元素（DOM 事实：仓库里的真机脚本也按它定位）。 */
function isGroupTitle(element: HtmlElement): boolean {
  const id = element.attrs['id'];
  if (!id || !id.startsWith('tab-group-title-')) return false;
  return !id.slice('tab-group-title-'.length).includes('hint');
}

/**
 * 形状**故意**是「张数对半分 ≠ 高度最齐」：
 * 一张大卡 + 三张小卡 ⇒ 张数对半分是 2v2（估计高度 8 vs 4），
 * 最优的一刀是 1v3（6 vs 6）。
 */
const LOPSIDED = makeGroups([
  { id: 'big', name: 'Alpha', tabCount: 5, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 's1', name: 'Bravo', tabCount: 1, createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 's2', name: 'Charlie', tabCount: 1, createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 's3', name: 'Delta', tabCount: 1, createdAt: '2026-01-04T00:00:00.000Z' },
]);

/** 交替高矮 —— 就是真机复现缺陷时用的形状（4/1/4/1/4/1）。 */
const ALTERNATING = makeGroups([
  { id: 'a1', name: 'Alpha', tabCount: 4, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'a2', name: 'Bravo', tabCount: 1, createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'a3', name: 'Charlie', tabCount: 4, createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'a4', name: 'Delta', tabCount: 1, createdAt: '2026-01-04T00:00:00.000Z' },
  { id: 'a5', name: 'Echo', tabCount: 4, createdAt: '2026-01-05T00:00:00.000Z' },
  { id: 'a6', name: 'Foxtrot', tabCount: 1, createdAt: '2026-01-06T00:00:00.000Z' },
]);

/** 一栏的估计高度（与判据层同一个权重函数，守卫不另算一套）。 */
function columnWeight(groups: readonly TabGroup[]): number {
  return groups.reduce((sum, group) => sum + estimateCardWeight(group), 0);
}

describe('双栏：切点必须取「两栏高度最齐」的那一刀', () => {
  it('切完仍然是原来那个顺序（连续切一刀，不重排）', () => {
    for (const groups of [LOPSIDED, ALTERNATING]) {
      const { left, right } = splitIntoTwoColumns(groups);
      assert.deepEqual(
        [...left, ...right].map(group => group.id),
        groups.map(group => group.id),
        '两栏拼回来必须还是原列表的顺序 —— 这是「先读完左栏再读右栏 == 排序序」的前提'
      );
    }
  });

  it('张数对半分不等于高度最齐：一张大卡 + 三张小卡 ⇒ 必须切在 1v3', () => {
    const { left, right } = splitIntoTwoColumns(LOPSIDED);
    assert.deepEqual(left.map(group => group.id), ['big'], '大卡必须独占一栏');
    assert.deepEqual(right.map(group => group.id), ['s1', 's2', 's3']);
    assert.equal(
      columnWeight(left),
      columnWeight(right),
      `两栏估计高度必须相等（实际 ${columnWeight(left)} vs ${columnWeight(right)}）—— ` +
        '按张数对半分会是 8 vs 4，右栏比左栏矮一半 ⇒ 底部一大块空白'
    );
  });

  it('穷举：任何一种形状，切完的两栏高度差都必须是最小的那个', () => {
    const shapes: number[][] = [
      [1],
      [1, 1],
      [4, 1, 4, 1, 4, 1],
      [1, 1, 1, 1, 1],
      [9, 1, 1, 1, 1, 1],
      [2, 8, 2],
      [3, 3, 3],
      [],
    ];
    for (const shape of shapes) {
      const groups = makeGroups(
        shape.map((tabCount, index) => ({
          id: `g${index}`,
          name: `S${index}`,
          tabCount,
          createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        }))
      );
      const { left, right } = splitIntoTwoColumns(groups);
      const actual = Math.abs(columnWeight(left) - columnWeight(right));

      // 独立再算一遍所有连续切法的最优值（不复用实现）。
      const weights = groups.map(group => estimateCardWeight(group));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let best = Number.POSITIVE_INFINITY;
      let prefix = 0;
      for (let split = 1; split < groups.length; split += 1) {
        prefix += weights[split - 1] ?? 0;
        best = Math.min(best, Math.abs(total - 2 * prefix));
      }
      if (groups.length <= 1) best = total;

      assert.equal(
        actual,
        best,
        `形状 [${shape.join(',')}] 的切点不是最优的：实际高度差 ${actual}，最优是 ${best}`
      );
    }
  });

  it('界面真的用上了这个切点（不是判据层算完就撂下）', async () => {
    for (const groups of [LOPSIDED, ALTERNATING]) {
      const rendered = await renderTabList({
        groups,
        layoutMode: 'double',
        sessionSort: 'name',
      });
      const titles = findAll(rendered.tree, isGroupTitle);
      assert.ok(titles.length > 0, '前置：双栏视图必须真的渲染出会话卡');
      const container = commonAncestor(titles);
      assert.ok(container, '会话卡必须有一个共同的容器（网格）');
      assert.equal(container.children.length, 2, '前置：网格必须恰好有两个栏容器');

      const renderedColumns = container.children.map(column => {
        assert.ok(
          classList(column).includes('session-grid-column'),
          '前置：网格的直接子项必须是 .session-grid-column'
        );
        return column.children.flatMap(card =>
          findAll(card, isGroupTitle).map(title =>
            String(title.attrs['id']).slice('tab-group-title-'.length)
          )
        );
      });

      const sorted = sortSessions(groups, 'name');
      const expected = splitIntoTwoColumns(sorted);
      assert.deepEqual(
        renderedColumns,
        [
          expected.left.map(group => group.id),
          expected.right.map(group => group.id),
        ],
        '界面上每一栏实际装了哪几张卡，必须与判据层算出的切点逐张一致 ——\n' +
          '  否则「不留空白」只是判据层的一句空话，界面照旧两两配对。\n' +
          `  实际：${renderedColumns.map(column => column.join('+')).join(' | ')}\n` +
          `  应为：${[expected.left, expected.right].map(column => column.map(g => g.id).join('+')).join(' | ')}`
      );
    }
  });
});
