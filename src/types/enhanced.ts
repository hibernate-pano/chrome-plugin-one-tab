/**
 * 增强的类型定义
 * 提供更完善的类型支持
 */

import { TabGroup, Tab, UserSettings } from './tab';

// ==================== 泛型工具类型 ====================

/**
 * 使对象的所有属性变为可选且可为 null
 */
export type Nullable<T> = { [P in keyof T]: T[P] | null };

/**
 * 深度 Partial
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * 提取函数的返回类型
 */
export type AsyncReturnType<T extends (...args: unknown[]) => Promise<unknown>> =
  T extends (...args: unknown[]) => Promise<infer R> ? R : never;

// ==================== 状态相关类型 ====================

export type SyncStatusType = 'idle' | 'syncing' | 'success' | 'error';
export type SyncOperationType = 'none' | 'upload' | 'download';
export type SyncStrategyType = 'newest' | 'local' | 'remote' | 'ask';
export type ThemeModeType = 'light' | 'dark' | 'auto';
export type ThemeStyleType = 'classic' | 'refined' | 'aurora' | 'legacy';
export type LayoutModeType = 'single' | 'double';

// ==================== 事件类型 ====================

export interface TabEvent {
  type: 'created' | 'updated' | 'deleted' | 'moved';
  tabId: string;
  groupId: string;
  timestamp: string;
  data?: Partial<Tab>;
}

export interface GroupEvent {
  type: 'created' | 'updated' | 'deleted' | 'moved' | 'locked' | 'unlocked';
  groupId: string;
  timestamp: string;
  data?: Partial<TabGroup>;
}

export interface SyncEvent {
  type: 'started' | 'progress' | 'completed' | 'failed';
  operation: SyncOperationType;
  progress?: number;
  error?: string;
  timestamp: string;
}

// ==================== 操作结果类型 ====================

export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface BatchOperationResult {
  success: boolean;
  processed: number;
  failed: number;
  errors: string[];
  timestamp: string;
}

// ==================== 搜索相关类型 ====================

export interface SearchResult {
  group: TabGroup;
  tab: Tab;
  matchType: 'title' | 'url' | 'both';
  matchPositions?: {
    title?: [number, number][];
    url?: [number, number][];
  };
}

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  matchType?: 'any' | 'title' | 'url';
  limit?: number;
  offset?: number;
}

// ==================== 统计相关类型 ====================

export interface TabStats {
  totalGroups: number;
  totalTabs: number;
  lockedGroups: number;
  averageTabsPerGroup: number;
  oldestGroup?: {
    id: string;
    name: string;
    createdAt: string;
  };
  newestGroup?: {
    id: string;
    name: string;
    createdAt: string;
  };
  topDomains: Array<{
    domain: string;
    count: number;
  }>;
}

export interface SyncStats {
  lastSyncTime: string | null;
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  averageSyncDuration: number;
}

// ==================== 导入导出类型 ====================

export interface ExportData {
  version: string;
  exportedAt: string;
  groups: TabGroup[];
  settings?: UserSettings;
  metadata?: {
    totalTabs: number;
    totalGroups: number;
  };
}

export interface ImportOptions {
  merge?: boolean;
  overwrite?: boolean;
  includeSettings?: boolean;
}

export interface ImportResult {
  success: boolean;
  importedGroups: number;
  importedTabs: number;
  skippedDuplicates: number;
  errors: string[];
}

// ==================== 拖拽相关类型 ====================

export interface DragItem {
  type: 'tab' | 'group';
  id: string;
  groupId?: string;
  index: number;
}

export interface DropResult {
  targetGroupId: string;
  targetIndex: number;
  position: 'before' | 'after';
}

// ==================== 通知类型 ====================

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface NotificationOptions {
  type: NotificationType;
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// 重新导出基础类型
export type { TabGroup, Tab, UserSettings };
