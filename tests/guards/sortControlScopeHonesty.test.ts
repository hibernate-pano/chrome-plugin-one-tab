/**
 * 排序控件只允许出现在**真的按它排序**的视图里（2026-10-23 审计 R-6）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 「排序方式」下拉住在 `SearchFilterSection` 里，而它有**两个**渲染点：
 *
 *   · `TabList.tsx` —— 主列表视图：**会**按 `sortSessions(groups, sessionSort)` 排；
 *   · `SearchResultList.tsx` —— 搜索结果 / 筛选浏览视图：**不按** `sessionSort` 排
 *     （搜索按相关度、浏览按会话更新时间，`buildSessionSearchResults` 是唯一的排序依据）。
 *
 * 修复前两个渲染点都摆着那个下拉 ⇒ 用户在结果视图里选「按名称」，
 * 顺序**一动不动** ⇒ 一个「能选、选了没反应」的控件在骗人。
 *
 * ── 这条守卫钉的是**性质**，不是长相 ──────────────────────────────────────
 *
 *   **排序控件出现在哪里，哪里就必须真的按它排序。**
 *
 * 之所以钉成这个性质（而不是「搜索视图不许有下拉」这种逐视图的规定）：
 *   · 「不许有」会随产品演进变僵 —— 哪天结果视图真的支持排序了，守卫会误报；
 *   · 「有下拉就必须真的排」是**任何时候都成立**的那句话：
 *     控件要么在、且有效；要么不在。
 *
 * 判据从**渲染产物**上取（`renderToStaticMarkup` 的 HTML）：
 * 「这个视图的顺序会不会随 `sessionSort` 变」是**行为**，
 * 「有没有下拉」也是**行为** —— 两者对齐，才是「控件不骗人」。
 *
 * ── 为什么必须渲染一遍而不是读源码 ────────────────────────────────────────
 * 本仓在 L-10 上栽过一次：判据层（`core/sessionSort.ts`）、设置层、持久化层
 * 全做完、守卫全绿，而**列表侧根本没接线** —— 排序控件能选，顺序不动。
 * 「控件存在」与「控件被用上」是两件事，只有渲染能同时看见这两件事。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeGroups, renderTabList } from '../_helpers/tabListHarness.ts';
import { SESSION_SORT_OPTIONS } from '@/core/sessionSort';

/**
 * 判据用的会话。
 *
 * 形状说明：名字按字母序、创建时间**也**按字母序 ⇒
 * 「按名称」与「按最近保存」给出**不同**的顺序 ⇒
 * 「这个视图会不会随排序键变」这件事在 fixture 上是**可分辨**的。
 */
const GROUPS = makeGroups([
  { id: 'g1', name: 'Alpha', tabCount: 3, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g2', name: 'Bravo', tabCount: 1, createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'g3', name: 'Charlie', tabCount: 3, createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'g4', name: 'Delta', tabCount: 1, createdAt: '2026-01-04T00:00:00.000Z' },
  { id: 'g5', name: 'Echo', tabCount: 3, createdAt: '2026-01-05T00:00:00.000Z' },
  { id: 'g6', name: 'Foxtrot', tabCount: 1, createdAt: '2026-01-06T00:00:00.000Z' },
]);

/** 三种界面形态（判据来自 `resolveSearchViewMode`）。 */
const VIEWS = [
  {
    name: '主列表',
    options: { searchQuery: '', filters: {} },
    // 主列表按 sessionSort 排 ⇒ 控件必须在场。
    sortsBySessionSort: true,
  },
  {
    name: '筛选浏览',
    options: { searchQuery: '', filters: { domain: 'example.com' } },
    // 筛选浏览按会话更新时间排 ⇒ 控件必须不在。
    sortsBySessionSort: false,
  },
  {
    name: '搜索结果',
    options: { searchQuery: 'page', filters: {} },
    // 搜索结果按相关度排 ⇒ 控件必须不在。
    sortsBySessionSort: false,
  },
] as const;

/** 渲染一个视图在四种排序键下的顺序。 */
async function renderOrders(
  options: { searchQuery: string; filters: Record<string, string> }
): Promise<{ orders: string[][]; hasSortControl: boolean }> {
  const orders: string[][] = [];
  let hasSortControl = false;
  for (const option of SESSION_SORT_OPTIONS) {
    const rendered = await renderTabList({
      groups: GROUPS,
      searchQuery: options.searchQuery,
      filters: options.filters,
      sessionSort: option.value,
    });
    orders.push(rendered.sessionNameOrder);
    hasSortControl = hasSortControl || rendered.hasSortControl;
  }
  return { orders, hasSortControl };
}

/** 这些顺序里出现了几种不同的排法？（>1 = 顺序确实随排序键变） */
function distinctOrderCount(orders: string[][]): number {
  return new Set(orders.map(order => order.join('|'))).size;
}

describe('排序控件不许骗人：有控件的视图必须真的按它排序', () => {
  for (const view of VIEWS) {
    it(`${view.name}：控件在不在，必须与「这个视图排不按 sessionSort」一致`, async () => {
      const { orders, hasSortControl } = await renderOrders(view.options);
      const responds = distinctOrderCount(orders) > 1;

      assert.equal(
        hasSortControl,
        responds,
        `${view.name}：排序控件${hasSortControl ? '在' : '不在'}，` +
          `而这个视图的顺序${responds ? '会' : '不会'}随 settings.sessionSort 变化 —— ` +
          '两者必须一致：\n' +
          '  · 控件在、顺序不动 ⇒ 用户「选了没反应」（控件说谎）；\n' +
          '  · 控件不在、顺序会动 ⇒ 用户改不了顺序（能力不可达）。\n' +
          `实际顺序（依次为 ${SESSION_SORT_OPTIONS.map(o => o.value).join(' / ')}）：\n` +
          orders.map(order => `  ${order.join(' → ')}`).join('\n')
      );
    });
  }

  it('主列表：排序控件必须在场（排序是这个视图的主入口，不许被顺手删掉）', async () => {
    const rendered = await renderTabList({
      groups: GROUPS,
      sessionSort: 'saved',
    });
    assert.ok(
      rendered.hasSortControl,
      '主列表按 sessionSort 排 ⇒ 必须给用户一个换顺序的入口。' +
        '这条不能只靠上面的等价关系兜底：万一「控件没了」与「顺序也不变了」同时发生，' +
        '等价关系会自洽而放行 —— 所以这里显式要求控件在。'
    );
  });

  it('主列表：控件提供的排序项必须与判据层支持的排序键一致', async () => {
    const rendered = await renderTabList({ groups: GROUPS, sessionSort: 'saved' });
    const offered = [...rendered.html.matchAll(/<option[^>]*value="([^"]*)"/g)].map(m => m[1]);
    const expected = SESSION_SORT_OPTIONS.map(option => option.value);
    assert.deepEqual(
      [...offered].sort(),
      [...expected].sort(),
      '下拉里的排序项必须与 `core/sessionSort.ts` 支持的排序键一致 —— ' +
        '少了哪一项，用户就少了哪种排法；多了哪一项，选了也不认。'
    );
  });
});
