/**
 * 标签管理领域组件导出
 */

// 核心标签组件
export { TabGroup } from './TabGroup';
export { TabItem } from './TabItem';
export { TabList } from './TabList';

// 搜索和过滤组件
export { SearchBar } from './search/SearchBar';
export { FilterPanel } from './search/FilterPanel';
export { AdvancedSearch } from './search/AdvancedSearch';
export { AdvancedSearchPanel } from './search/AdvancedSearchPanel';
export { SearchHistoryPanel } from './search/SearchHistoryPanel';

// 虚拟化组件
export { VirtualizedTabGroupList, VirtualizedTabGroupGrid } from './VirtualizedTabGroupList';

// 拖拽组件
export { DraggableTabGroup } from './dnd/DraggableTabGroup';
export { SimpleDraggableTabGroup } from './dnd/SimpleDraggableTabGroup';
export { DragDropProvider } from './dnd/DragDropProvider';

// 性能测试组件
export { PerformanceTest } from './performance/PerformanceTest';
