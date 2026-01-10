/**
 * Tab Slice 类型定义
 * 集中管理所有与标签页状态相关的类型
 */

import { TabState, TabGroup, UserSettings } from '@/types/tab';

// 同步操作类型
export type SyncOperation = 'none' | 'upload' | 'download';

// 同步状态类型
export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

// 同步选项
export interface SyncToCloudOptions {
  background?: boolean;
  overwriteCloud?: boolean;
}

export interface SyncFromCloudOptions {
  background?: boolean;
  forceRemoteStrategy?: boolean;
}

// 同步结果
export interface SyncToCloudResult {
  syncTime: string;
  stats: CompressionStats | null;
}

export interface SyncFromCloudResult {
  groups: TabGroup[];
  syncTime: string;
  stats: CompressionStats | null;
}

// 压缩统计
export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  ratio: number;
}

// 移动操作参数
export interface MoveGroupParams {
  dragIndex: number;
  hoverIndex: number;
}

export interface MoveTabParams {
  sourceGroupId: string;
  sourceIndex: number;
  targetGroupId: string;
  targetIndex: number;
  updateSourceInDrag?: boolean;
}

// 删除标签页参数
export interface DeleteTabParams {
  groupId: string;
  tabId: string;
}

// 更新组名参数
export interface UpdateGroupNameParams {
  groupId: string;
  name: string;
}

// 清理重复标签结果
export interface CleanDuplicateResult {
  removedTabsCount: number;
  removedGroupsCount: number;
  updatedGroups: TabGroup[];
}

// Redux State 类型
export interface RootState {
  tabs: TabState;
  auth: { isAuthenticated: boolean };
  settings: UserSettings;
}

// 进度更新参数
export interface SyncProgressPayload {
  progress: number;
  operation: SyncOperation;
}

// 重新导出基础类型
export type { TabState, TabGroup, UserSettings };
