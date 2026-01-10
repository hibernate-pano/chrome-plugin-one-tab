/**
 * Tab Slice Selectors
 * 使用 createSelector 创建记忆化选择器，避免不必要的重新计算
 */

import { createSelector } from '@reduxjs/toolkit';
import { TabState } from '@/types/tab';
import { sortGroupsByCreatedAt } from '@/utils/tabSortUtils';

type RootStateWithTabs = { tabs: TabState };

/**
 * 选择过滤后的标签组（根据搜索查询）
 */
export const selectFilteredGroups = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups, (state: RootStateWithTabs) => state.tabs.searchQuery],
  (groups, searchQuery) => {
    if (!searchQuery) return groups;

    const query = searchQuery.toLowerCase();
    return groups.filter(group => {
      // 先检查组名，这是一个快速检查
      if (group.name.toLowerCase().includes(query)) return true;

      // 然后检查标签，这可能更耗时
      return group.tabs.some(
        tab => tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)
      );
    });
  }
);

/**
 * 选择已排序的标签组（按创建时间倒序）
 */
export const selectSortedGroups = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups],
  groups => sortGroupsByCreatedAt(groups)
);

/**
 * 选择标签总数
 */
export const selectTotalTabCount = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups],
  groups => {
    return groups.reduce((total, group) => total + group.tabs.length, 0);
  }
);

/**
 * 选择已锁定的标签组
 */
export const selectLockedGroups = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups],
  groups => groups.filter(g => g.isLocked)
);

/**
 * 选择标签组数量
 */
export const selectGroupCount = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups],
  groups => groups.length
);

/**
 * 选择同步状态
 */
export const selectSyncStatus = createSelector(
  [(state: RootStateWithTabs) => state.tabs],
  tabs => ({
    status: tabs.syncStatus,
    lastSyncTime: tabs.lastSyncTime,
    progress: tabs.syncProgress,
    operation: tabs.syncOperation,
  })
);

/**
 * 选择是否正在加载
 */
export const selectIsLoading = createSelector(
  [(state: RootStateWithTabs) => state.tabs],
  tabs => tabs.isLoading
);

/**
 * 选择错误信息
 */
export const selectError = createSelector(
  [(state: RootStateWithTabs) => state.tabs],
  tabs => tabs.error
);

/**
 * 根据 ID 选择标签组
 */
export const selectGroupById = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups, (_: RootStateWithTabs, groupId: string) => groupId],
  (groups, groupId) => groups.find(g => g.id === groupId)
);

/**
 * 选择活动标签组
 */
export const selectActiveGroup = createSelector(
  [(state: RootStateWithTabs) => state.tabs.groups, (state: RootStateWithTabs) => state.tabs.activeGroupId],
  (groups, activeGroupId) => (activeGroupId ? groups.find(g => g.id === activeGroupId) : null)
);
