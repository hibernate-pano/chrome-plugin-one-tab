/**
 * Tab Slice - 向后兼容的重新导出
 *
 * 注意: 此文件已被模块化重构，实际实现位于 ./tabs/ 目录下
 * 保留此文件是为了向后兼容现有的导入路径
 *
 * 新的模块结构:
 * - tabs/types.ts: 类型定义
 * - tabs/initialState.ts: 初始状态
 * - tabs/reducers.ts: 同步 reducer
 * - tabs/crudThunks.ts: CRUD 异步操作
 * - tabs/syncThunks.ts: 同步相关异步操作
 * - tabs/dndThunks.ts: 拖拽相关异步操作
 * - tabs/selectors.ts: 记忆化选择器
 * - tabs/index.ts: 统一导出
 */

// 从模块化结构重新导出所有内容
export {
  // Slice
  tabSlice,
  // Actions
  setActiveGroup,
  updateGroupName,
  toggleGroupLock,
  setSearchQuery,
  setSyncStatus,
  moveGroup,
  moveTab,
  updateSyncProgress,
  setGroups,
  // CRUD Thunks
  loadGroups,
  saveGroup,
  updateGroup,
  deleteGroup,
  deleteAllGroups,
  importGroups,
  deleteTabAndSync,
  cleanDuplicateTabs,
  // Sync Thunks
  syncTabsToCloud,
  syncTabsFromCloud,
  syncLocalChangesToCloud,
  updateGroupNameAndSync,
  toggleGroupLockAndSync,
  // DnD Thunks
  moveGroupAndSync,
  moveTabAndSync,
  // Selectors
  selectFilteredGroups,
  selectSortedGroups,
  selectTotalTabCount,
  selectLockedGroups,
  selectGroupCount,
  selectSyncStatus,
  selectIsLoading,
  selectError,
  selectGroupById,
  selectActiveGroup,
} from './tabs';

// 默认导出 reducer
export { default } from './tabs';
