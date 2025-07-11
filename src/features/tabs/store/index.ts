/**
 * Tabs功能模块的Redux store配置
 */
export { default as tabsReducer } from './tabsSlice';
export { default as tabGroupsReducer } from './tabGroupsSlice';
export { default as dragOperationsReducer } from './dragOperationsSlice';

// 导出现有的actions
export {
  selectTab,
  deselectTab,
  selectAllTabs,
  clearSelection,
  setError as setTabsError,
} from './tabsSlice';

export {
  setActiveGroup,
  setSearchQuery,
  setError as setGroupsError,
  updateGroupNameLocal,
  toggleGroupLockLocal,
} from './tabGroupsSlice';

export {
  startDrag,
  updateDropTarget,
  endDrag,
  setProcessing,
  setError as setDragError,
  updateDragPreview,
} from './dragOperationsSlice';