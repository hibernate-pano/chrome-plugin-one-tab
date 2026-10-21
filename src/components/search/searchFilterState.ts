/**
 * 筛选条件的**状态容器**（纯 reducer，可直接单测）。
 *
 * ── 缺陷（2026-10-20 审计 A-14）──────────────────────────────────────────
 *
 * 筛选条件（域名 / 会话名称 / 固定标签 / 保存时间）与「筛选面板是否展开」
 * 原先是 `SearchResultList` 的**内部 `useState`**。而 `SearchResultList`
 * 只在**有搜索词**时才被渲染（`TabList` 里 `{searchQuery ? <SearchResultList/> : ...}`）。
 *
 * ⇒ 清空搜索词 ⇒ `SearchResultList` 卸载 ⇒ **筛选条件与面板展开状态全部丢失**。
 *
 * 用户场景：搜「react」→ 展开筛选 → 选「7 天内」→ 搜错了 → 清空搜索词重搜
 * 「redux」⇒ 筛选条件没了，用户得从头再设一遍。而「换个关键词继续筛」是
 * 搜索的**主用法**。
 *
 * ── 为什么做成 reducer 而不是散在组件里 ──────────────────────────────────
 *
 * ① **不变量要能被测**。「清空搜索词不丢条件」本质是「**搜索词不是筛选状态
 *    的一部分，且没有任何动作会因为搜索词变化而重置条件**」。
 *    这条不变量只有把状态收敛到一个纯 reducer 里才说得清、也才测得动 ——
 *    用 `useState` 散在组件里就只能靠「源码里没有 useEffect 清条件」这种
 *    间接断言来近似。
 * ② **状态必须活得比结果视图久**。reducer 放在**视图之外**（列表层），
 *    结果视图卸载不影响它 —— 这正是修复的要点。
 *
 * ── 动作集合刻意很小 ────────────────────────────────────────────────────
 *
 * 只有三种动作，全部来自**用户的显式操作**：
 *   · `filters/update` —— 改了某个筛选控件
 *   · `filters/clear`  —— 用户点了「清空筛选」
 *   · `filters/togglePanel` —— 用户点了「显示筛选 / 隐藏筛选」
 *
 * **没有**「重置」「搜索词变化」这类动作 ⇒ 搜索词变化在结构上就不可能
 * 影响筛选条件。这不是「我们记得别清它」，是「它压根不在状态机里」。
 */
import type { SearchFilters } from '@/utils/search';

export interface SearchFilterState {
  /** 用户设定的筛选条件（原始值，尚未按设置作废）。 */
  filters: SearchFilters;
  /** 筛选面板是否展开。 */
  showFilters: boolean;
}

export const initialSearchFilterState: SearchFilterState = {
  filters: {},
  showFilters: false,
};

export type SearchFilterAction =
  | { type: 'filters/update'; updater: (current: SearchFilters) => SearchFilters }
  | { type: 'filters/clear' }
  | { type: 'filters/togglePanel' };

/**
 * 筛选状态的 reducer（纯函数）。
 *
 * 【刻意不做的事】
 * · 不按搜索词重置条件 —— 搜索词根本不是这个状态的一部分；
 * · 不因「清空条件」而折叠面板 —— 用户刚清空条件，通常是要马上重设，
 *   面板一收起来就得再点一次「显示筛选」；
 * · 不就地修改入参 —— 返回新对象，避免引用比较失灵。
 */
export const searchFilterReducer = (
  state: SearchFilterState,
  action: SearchFilterAction
): SearchFilterState => {
  switch (action.type) {
    case 'filters/update':
      return { ...state, filters: action.updater(state.filters) };
    case 'filters/clear':
      return { ...state, filters: {} };
    case 'filters/togglePanel':
      return { ...state, showFilters: !state.showFilters };
    default:
      return state;
  }
};

/**
 * 视图层要用的筛选控件接口。
 *
 * 单一真相源：条件、有效性、计数、三个动作全在这里，
 * 谁渲染筛选面板谁消费它 —— 两处各算一遍必然漂移。
 */
export interface SearchFilterControls {
  /** 用户设定的原始条件。 */
  filters: SearchFilters;
  /** 真正参与过滤的条件（固定标签条件在设置关闭时已作废）。 */
  effectiveFilters: SearchFilters;
  /** 生效中的筛选维度数（「N 个筛选」徽章）。 */
  activeFilterCount: number;
  /** 筛选面板是否展开。 */
  showFilters: boolean;
  /** 是否正在提交筛选变更（用于「更新结果中…」提示）。 */
  isFilterPending: boolean;
  /** 修改筛选条件。 */
  updateFilters: (updater: (current: SearchFilters) => SearchFilters) => void;
  /** 清空全部筛选条件。 */
  clearFilters: () => void;
  /** 展开 / 收起筛选面板。 */
  toggleFilters: () => void;
}
