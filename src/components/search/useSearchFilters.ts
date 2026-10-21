/**
 * 筛选状态的**持有者**（列表层）。
 *
 * ── 为什么状态住在列表层而不是结果视图里 ────────────────────────────────
 *
 * 修复前筛选条件是 `SearchResultList` 的内部 `useState`，而该组件只在
 * **有搜索词**时才挂载 ⇒ 清空搜索词就把用户设好的条件一起清掉
 * （2026-10-20 审计 A-14）。
 *
 * 状态搬到列表层之后：
 *   · 清空搜索词 ⇒ 结果视图卸载，但**筛选条件与面板展开状态仍在**；
 *   · 再输入关键词 ⇒ 条件**自动生效**，用户不用重设。
 *
 * ── 为什么用 reducer ────────────────────────────────────────────────────
 *
 * 「搜索词变化不影响筛选条件」这条不变量，只有在状态机里**没有**对应动作时
 * 才是结构性保证 —— 而不是「我们记得别清它」的自觉。
 * 动作集合只有三个，全部来自用户的显式操作（见 searchFilterState）。
 */
import { useCallback, useMemo, useReducer, useTransition } from 'react';
import { useAppSelector } from '@/store/hooks';
import type { SearchFilters } from '@/utils/search';
import {
  SearchFilterState,
  initialSearchFilterState,
  searchFilterReducer,
} from './searchFilterState';
import { resolveActiveFilterState } from './searchBrowseMode';
import type { SearchFilterControls } from './searchFilterState';

/**
 * 持有筛选状态，并给出视图层要用的全部接口。
 *
 * @returns 筛选控件接口（条件、有效性、计数、三个动作）
 */
export const useSearchFilters = (): SearchFilterControls => {
  const [state, dispatch] = useReducer(searchFilterReducer, initialSearchFilterState);
  const [isFilterPending, startFilterTransition] = useTransition();
  const collectPinnedTabs = useAppSelector(state => state.settings.collectPinnedTabs);

  // 条件与它的有效性必须**同源**：
  // 设置里关掉「保存固定标签页」时，残留的固定标签条件一并作废
  // （否则用户看不到筛选项却被它筛掉了结果 —— 最坏的隐形行为）。
  const { effectiveFilters, activeFilterCount } = useMemo(
    () => resolveActiveFilterState(state.filters, collectPinnedTabs),
    [collectPinnedTabs, state.filters]
  );

  const updateFilters = useCallback((updater: (current: SearchFilters) => SearchFilters) => {
    startFilterTransition(() => {
      dispatch({ type: 'filters/update', updater });
    });
  }, []);

  const clearFilters = useCallback(() => {
    startFilterTransition(() => {
      dispatch({ type: 'filters/clear' });
    });
  }, []);

  const toggleFilters = useCallback(() => {
    startFilterTransition(() => {
      dispatch({ type: 'filters/togglePanel' });
    });
  }, []);

  return useMemo<SearchFilterControls>(
    () => ({
      filters: state.filters,
      effectiveFilters,
      activeFilterCount,
      showFilters: state.showFilters,
      isFilterPending,
      updateFilters,
      clearFilters,
      toggleFilters,
    }),
    [
      activeFilterCount,
      clearFilters,
      effectiveFilters,
      isFilterPending,
      state.filters,
      state.showFilters,
      toggleFilters,
      updateFilters,
    ]
  );
};

export type { SearchFilterState };
