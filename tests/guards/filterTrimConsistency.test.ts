/**
 * F2：文本型筛选条件的 trim 口径必须**只有一处**（2026-10-24 审计）。
 *
 * ── 缺陷 ────────────────────────────────────────────────────────────────
 *
 * 三处「这个维度是否在筛」的判定（计数 / 徽章 / chip）都做 `trim()`，
 * 而真正过滤的 `applySearchFilters` 拿的是**原始值**：
 *
 *   用户输入「 调研 」（带尾随/前导空格）
 *   ⇒ `group.name.includes(' 调研 ')` 一条都匹配不上
 *   ⇒ 列表被筛空，徽章却说「0 个筛选」
 *
 * 条件失配与条件生效，界面上长得一模一样（都是「没有结果」）——
 * 用户没有任何线索知道那是空格造成的。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * 把归一化收敛到 `resolveEffectiveSearchFilters`（唯一入口）：
 * 去首尾空白；只剩空白 ⇒ 条件消失。过滤 / 徽章 / chip / 埋点全部只读
 * `effectiveFilters`，口径天然同源。
 *
 * ── 这个守卫为什么能证明它接上了 ────────────────────────────────────────
 *
 * 不只测纯函数：用 `renderSearchResultList` **真渲染结果视图**
 * （它内部与生产一致，经 `resolveActiveFilterState` 拿到 `effectiveFilters`，
 * 再交给 `applySearchFilters`）。若哪天组件改回读原始 `filters`，
 * 带空白的用例立刻变红。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEffectiveSearchFilters } from '../../src/components/search/searchFilterAvailability.ts';
import {
  countActiveSearchFilters,
  resolveActiveFilterState,
} from '../../src/components/search/searchBrowseMode.ts';
import {
  makeSearchGroups,
  renderSearchResultList,
} from '../_helpers/searchResultListHarness.ts';

// ─────────────────────────────────────────────────────────────────────────
// 1. 纯函数：唯一入口的归一化
// ─────────────────────────────────────────────────────────────────────────

describe('resolveEffectiveSearchFilters：文本条件在唯一入口去空白', () => {
  it('会话名去首尾空白', () => {
    const effective = resolveEffectiveSearchFilters({ groupName: '  调研  ' }, false);
    assert.equal(
      effective.groupName,
      '调研',
      '会话名必须按 trim 后的值参与过滤，否则「 调研 」一条都筛不出来'
    );
  });

  it('域名去首尾空白', () => {
    const effective = resolveEffectiveSearchFilters({ domain: '  example.com  ' }, false);
    assert.equal(
      effective.domain,
      'example.com',
      '域名必须按 trim 后的值参与过滤（埋点 / chip 也读这个值）'
    );
  });

  it('只由空白组成 ⇒ 条件消失（undefined，而不是空串）', () => {
    const effective = resolveEffectiveSearchFilters({ domain: '   ', groupName: '\t' }, false);
    assert.equal(effective.domain, undefined, '纯空白不是筛选条件');
    assert.equal(effective.groupName, undefined, '纯空白不是筛选条件');
    assert.equal(
      countActiveSearchFilters(effective),
      0,
      '归一化之后计数必须与过滤口径一致（0 个生效条件）'
    );
  });

  it('没有空白可去时返回原对象（不制造无谓的新引用）', () => {
    const filters = { domain: 'example.com', groupName: '调研' };
    assert.equal(
      resolveEffectiveSearchFilters(filters, false),
      filters,
      '每次渲染都造新对象 ⇒ useMemo 永远失效 ⇒ 搜索管线全量重算'
    );
  });

  it('不修改入参', () => {
    const filters = { groupName: '  调研  ' };
    resolveEffectiveSearchFilters(filters, false);
    assert.equal(filters.groupName, '  调研  ', '不得就地改调用方的对象');
  });

  it('trim 与「固定标签条件作废」同时生效', () => {
    const { effectiveFilters, activeFilterCount } = resolveActiveFilterState(
      { groupName: '  调研  ', pinned: 'only' },
      false
    );
    assert.equal(effectiveFilters.groupName, '调研');
    assert.equal(effectiveFilters.pinned, undefined);
    assert.equal(activeFilterCount, 1, '只剩会话名一个维度生效');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 端到端：真渲染结果视图
// ─────────────────────────────────────────────────────────────────────────

const GROUPS = makeSearchGroups([
  { id: 'g1', name: '调研', tabCount: 2, tabTitlePrefix: 'page' },
  { id: 'g2', name: '工作', tabCount: 2, tabTitlePrefix: 'page' },
]);

/** 两个会话都命中（`AdvancedSearch` 按标题匹配 'page'）。 */
const SUMMARY_ALL = '共 2 个匹配会话，4 个匹配标签页';
/** 只有「调研」命中。 */
const SUMMARY_RESEARCH = '共 1 个匹配会话，2 个匹配标签页';

const restoreIds = (rendered: { restoreButtons: Array<{ groupId: string }> }) =>
  rendered.restoreButtons.map(button => button.groupId).sort();

describe('结果视图：带空白的筛选值与去空白完全同效', () => {
  it('会话名带首尾空白 ⇒ 结果与去掉空白一致（不是「一条都筛不出」）', async () => {
    const padded = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { groupName: '  调研  ' },
    });
    const exact = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { groupName: '调研' },
    });

    assert.ok(
      padded.text.includes(SUMMARY_RESEARCH),
      `会话名筛选必须按 trim 后的值匹配；实际渲染文字：\n${padded.text}`
    );
    assert.deepEqual(
      restoreIds(padded),
      restoreIds(exact),
      '带空白的条件与去空白后的条件必须选中同一批会话'
    );
    assert.equal(padded.text, exact.text, '两种写法在界面上的产出必须逐字相同');
  });

  it('只有空白的会话名 ⇒ 不算筛选：结果一条不少、徽章也不出现', async () => {
    const rendered = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { groupName: '   ' },
    });

    assert.ok(
      rendered.text.includes(SUMMARY_ALL),
      `纯空白不是筛选条件，不得筛掉任何结果；实际渲染文字：\n${rendered.text}`
    );
    assert.ok(
      !rendered.text.includes('个筛选'),
      '纯空白条件不得在徽章上出现（徽章说「在筛」而实际没筛，是另一个方向的谎话）'
    );
  });

  it('只有空白的域名 ⇒ 与没有域名条件同效', async () => {
    const blank = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { domain: '   ' },
    });
    const none = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: {},
    });

    assert.ok(blank.text.includes(SUMMARY_ALL), '纯空白域名不得筛掉任何结果');
    assert.deepEqual(restoreIds(blank), restoreIds(none));
  });

  it('带空白的域名 ⇒ 与去空白后选中同一批会话', async () => {
    const padded = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { domain: '  example.com  ' },
    });
    const exact = await renderSearchResultList({
      groups: GROUPS,
      searchQuery: 'page',
      filters: { domain: 'example.com' },
    });

    assert.deepEqual(restoreIds(padded), restoreIds(exact));
    assert.equal(padded.text, exact.text, '两种写法在界面上的产出必须逐字相同');
  });
});
