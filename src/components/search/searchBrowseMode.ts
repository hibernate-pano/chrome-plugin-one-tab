/**
 * 「筛选浏览」模式 —— 空搜索词时也能用筛选器找会话。
 *
 * ── 缺陷（2026-10-20 审计 A-14）──────────────────────────────────────────
 *
 * README / 商店页 / 引导页三处都把「按域名过滤」「按时间过滤」当成**独立能力**
 * 宣传给用户，但实现上这三个筛选器只存在于 `SearchResultList`，而它只在
 * **有搜索词**时才被渲染（`TabList` 里 `{searchQuery ? <SearchResultList/> : ...}`）。
 *
 * 于是用户想做的事（「我记得是某个网站的那些标签，但记不清网址」）被卡在
 * 「必须先输入一个搜索词」上 —— 而他正因为记不清网址才搜不出来。
 * 「按域名过滤」被降级成了「搜索结果的二次收窄器」，不再是文档承诺的检索入口。
 *
 * ── 三种修法的取舍 ──────────────────────────────────────────────────────
 *
 * ① 空搜索词也可进入搜索面板（本模块的实现方向）：筛选器成为独立检索入口，
 *    与文档承诺一致。代价是要处理「没有搜索词时不能说『没找到与 X 相关』」
 *    这类文案诚实度问题。
 * ② 给筛选器单独开一个顶栏入口（第二套面板）：UI 变两套，状态要同步两份，
 *    文案也要双份维护 —— 违反「修法要最小」。
 * ③ 改文档，声明筛选必须在搜索之后用：等于承认文档承诺的功能做不到。
 *    引导页那两张卡片仍然在骗新用户。
 *
 * ── 为什么结果集必须是「全部标签」 ──────────────────────────────────────
 *
 * 三个筛选器的作用层级**不一样**：
 *
 *   | 筛选器     | 层级  | 判据作用在        |
 *   |------------|-------|-------------------|
 *   | 域名       | 标签级 | `tab.url`         |
 *   | 固定标签   | 标签级 | `tab.pinned`      |
 *   | 会话名称   | 会话级 | `group.name`      |
 *   | 保存时间   | 会话级 | `group.createdAt` |
 *
 * 会话级筛选的判据作用在**会话**上。若结果集只含「命中搜索词的标签」，
 * 那么当搜索词为空（或没有命中任何标签）时，会话级筛选**没有判据可作用** ——
 * 「按会话名找」会永远筛不出东西。
 *
 * 所以空搜索词下的结果集必须是**全部标签**：会话级筛选让整个会话入选，
 * 标签级筛选再在会话内挑出具体标签。这与有搜索词时的语义一致
 * （`applySearchFilters` 本来就是「会话级条件筛会话、标签级条件筛标签」）。
 *
 * ── 判据从哪来 ──────────────────────────────────────────────────────────
 *
 * 全部来自**代码里的事实**（`resolveEffectiveSearchFilters` 的有效性判定、
 * `applySearchFilters` 的过滤语义），不来自文档。本模块只负责
 * 「界面该显示什么」这一层决策，不重新实现任何匹配判据。
 */
import type { TabGroup } from '@/types/tab';
import type { SearchFilters, SearchResult } from '@/utils/search';
import { resolveEffectiveSearchFilters } from './searchFilterAvailability';

/**
 * 界面该显示什么。
 *
 * · `list`   —— 没有搜索词、也没有生效的筛选条件 ⇒ 显示主列表（首页性质）。
 * · `browse` —— 没有搜索词、但有生效的筛选条件 ⇒ 显示「筛选浏览」视图。
 * · `search` —— 有搜索词 ⇒ 显示搜索结果（既有形态，不变）。
 */
export type SearchViewMode = 'list' | 'browse' | 'search';

/**
 * 决定界面形态。
 *
 * @param query 搜索词（内部按去空白判断）
 * @param hasActiveFilters 当前是否有**生效中**的筛选条件
 */
export const resolveSearchViewMode = (
  query: string,
  hasActiveFilters: boolean
): SearchViewMode => {
  if (query.trim()) return 'search';
  return hasActiveFilters ? 'browse' : 'list';
};

/**
 * 生效中的筛选维度个数（与组件内的判空口径一致：纯空白不算生效）。
 *
 * 「N 个筛选」徽章与「是否进入筛选浏览视图」都用它 —— 两处口径必须同源，
 * 否则会出现「徽章说 0 个筛选、视图却已经按条件筛过了」。
 */
export const countActiveSearchFilters = (filters: SearchFilters): number =>
  [
    !!filters.domain?.trim(),
    !!filters.groupName?.trim(),
    !!filters.savedWithin,
    filters.pinned === 'only' || filters.pinned === 'exclude',
  ].filter(Boolean).length;

export interface ActiveFilterState {
  /** 真正参与过滤的条件（设置关闭时固定标签条件已作废）。 */
  effectiveFilters: SearchFilters;
  /** 生效中的筛选维度数。 */
  activeFilterCount: number;
}

/**
 * 一次性算出「生效条件 + 生效维度数」。
 *
 * 结果视图与列表视图都要用这两个值（前者算徽章与结果集，后者决定形态），
 * 所以收在一个纯函数里 —— 两处各算一遍必然漂移。
 */
export const resolveActiveFilterState = (
  filters: SearchFilters,
  collectPinnedTabs: boolean
): ActiveFilterState => {
  const effectiveFilters = resolveEffectiveSearchFilters(filters, collectPinnedTabs);
  return {
    effectiveFilters,
    activeFilterCount: countActiveSearchFilters(effectiveFilters),
  };
};

/**
 * 空搜索词下的结果集：**全部标签**。
 *
 * 见文件头「为什么结果集必须是全部标签」—— 会话级筛选（会话名 / 保存时间）
 * 的判据作用在会话上，结果集里必须含有这些会话的标签，它们才可能被选中。
 *
 * 排序：全部同分（0），随后由 `buildSessionSearchResults` 按会话更新时间倒序
 * 收敛（浏览态没有「相关度」可言，按最近动过的会话优先更贴近用户预期）。
 */
export const buildBrowseResults = (groups: TabGroup[]): SearchResult[] => {
  const results: SearchResult[] = [];
  for (const group of groups) {
    for (const tab of group.tabs) {
      results.push({ tab, group, score: 0, matches: [] });
    }
  }
  return results;
};

// ── 文案 ──────────────────────────────────────────────────────────────────
//
// 原则：**没有搜索词时不能说「搜索」**。没有搜索这件事，「搜索到 N 个」是假话，
// 「没有找到与 X 相关」也是假话（X 不存在）。筛选浏览态的文案必须说清
// 「是按筛选条件找到的」。

/** 筛选浏览态的结果计数。 */
export const browseSummaryCopy = (sessionCount: number, tabCount: number): string =>
  `按筛选条件找到 ${sessionCount} 个会话、${tabCount} 个标签页`;

/** 搜索态的结果计数（既有口径，不变）。 */
export const searchSummaryCopy = (sessionCount: number, tabCount: number): string =>
  `共 ${sessionCount} 个匹配会话，${tabCount} 个匹配标签页`;

/** 结果区的无障碍标签。 */
export const resultRegionLabel = (
  mode: 'search' | 'browse',
  sessionCount: number,
  tabCount: number
): string =>
  mode === 'browse'
    ? `筛选结果，${browseSummaryCopy(sessionCount, tabCount)}`
    : `搜索结果，共 ${sessionCount} 个匹配会话，${tabCount} 个匹配标签页`;

/** 筛选条标题。 */
export const resultViewTitle = (mode: 'search' | 'browse'): string =>
  mode === 'browse' ? '按条件筛选会话' : '会话搜索结果';

/**
 * 筛选区要不要显示标题。
 *
 * 【为什么 browse 形态下不显示标题】真机截图（outputs/prod-filter-browse/
 * 03-browse-filtered.png）暴露了一处**视觉冗余**：
 *
 *   卡片头：「符合条件的会话」
 *   筛选区：「按条件筛选会话」
 *
 * 两行都是标题级、说的是同一件事（这批会话是按条件筛出来的）⇒
 * 同一个信息在一屏里出现两次，且两行都长得像标题 ⇒ 视觉噪音。
 *
 * 更根本地说：筛选面板**就在标题正下方**，用户一眼就知道那是什么 ——
 * 标题在这里不提供任何新信息。
 *
 * 而 search 形态下不一样：那里筛选面板在**结果卡内部**，上方还有
 * 「会话搜索结果」这一层分区标识 ⇒ 标题有信息量，保留。
 *
 * ⇒ 判据放在这里（而不是散在组件里），是为了让「标题去留」与
 * 「形态判定」同源 —— 两处各判一遍必然漂移。
 */
export const showFilterSectionTitle = (mode: 'search' | 'browse'): boolean =>
  mode === 'search';

/** 结果卡标题。 */
export const resultCardTitle = (mode: 'search' | 'browse'): string =>
  mode === 'browse' ? '符合条件的会话' : '匹配会话';

/**
 * 批量操作的标题（「恢复/删除 搜索结果中的 N 个标签页？」）。
 *
 * ⚠️ 标题里**只许有一个问号**（2026-10-23 审计 P2-6）。
 * 修复前这个函数自带一个「？」，调用方又拼一个「…N 个标签？」⇒
 * 界面上出现「恢复搜索结果中的标签？5 个标签？？」这种拼接出来的标点。
 * ⇒ 条数由调用方传进来，**整句**在这里一次拼好。
 */
export const bulkActionTitle = (
  mode: 'search' | 'browse',
  action: '恢复' | '删除',
  count: number
): string =>
  mode === 'browse'
    ? `${action}筛选结果中的 ${count} 个标签页？`
    : `${action}搜索结果中的 ${count} 个标签页？`;

/** 筛选浏览态的空态标题（说清是**筛选条件**筛空了什么）。 */
export const browseEmptyTitle = '没有找到符合条件的会话';

/** 筛选浏览态的空态说明。 */
export const browseEmptyDescription =
  '当前筛选条件下没有会话。换个域名或时间范围试试，或清空筛选查看全部。';

/**
 * 什么都没给时的空态（既没有搜索词，也没有筛选条件）。
 *
 * 这一格在正常路径下**不该出现**（列表层有搜索词或有条件才渲染结果视图），
 * 但组件自己不能因此就说假话 —— 一旦哪天接线变了，界面上就会出现
 * 「没有找到与“”相关的会话或标签」（空引号 + 「请尝试其他关键词」）。
 * 那是**声称用户搜过、没搜到**，而他什么都没做。
 */
export const noCriteriaEmptyTitle = '请输入关键词或设置筛选条件';

export const noCriteriaEmptyDescription =
  '输入会话名、标签页标题或网址，或按域名、会话名称、保存时间筛选。';

/**
 * 筛选浏览态的截断提示。
 *
 * 与搜索态的提示**必须不同**：搜索态是「按相关度排序」，
 * 而浏览态没有相关度可言（全部同分，按最近更新的会话优先）——
 * 沿用搜索态的文案就是又一处「声明 ≠ 行为」。
 */
export const browseTruncationMessage = (hidden: number): string =>
  `还有 ${hidden} 条匹配结果未显示（按最近更新的会话优先显示）。` +
  `请调整筛选条件进一步缩小范围。`;
