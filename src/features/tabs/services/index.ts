/**
 * 标签管理领域服务导出
 */
export { TabGroupService, tabGroupService } from './TabGroupService';
export { SearchService, searchService } from './SearchService';
export { SearchHistoryService, searchHistoryService } from './SearchHistoryService';
export { DragDropService, dragDropService } from './DragDropService';
export { TabCleanupService, tabCleanupService } from './TabCleanupService';

// 导出类型
export type { SearchQuery, SearchResult, SearchMode } from './SearchService';
export type { SearchHistoryItem, SearchStatistics } from './SearchHistoryService';
export type { DragOperation, DragResult, DragValidation } from './DragDropService';
export type { CleanupRules, CleanupResult, CleanupProgressCallback } from './TabCleanupService';
