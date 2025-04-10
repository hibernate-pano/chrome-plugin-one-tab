export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: string;
  lastAccessed: string;
  group_id?: string; // 关联标签组ID

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean; // 软删除标记
}

export interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
  user_id?: string; // 关联用户ID
  device_id?: string; // 创建设备ID
  last_sync?: string; // 最后同步时间

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  isDeleted?: boolean; // 软删除标记
}

export interface TabState {
  groups: TabGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error'; // 新增：同步状态
  lastSyncTime: string | null; // 新增：最后同步时间
}

export interface UserSettings {
  autoCloseTabsAfterSaving: boolean;
  autoSave: boolean;
  autoSaveInterval: number;
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
  syncInterval: number; // 同步间隔（分钟）
  syncEnabled: boolean; // 是否启用同步

  // 新增同步策略设置
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask'; // 冲突解决策略
  deleteStrategy: 'everywhere' | 'local-only'; // 删除策略
}

export interface User {
  id: string;
  email: string;
  lastLogin: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface RootState {
  tabs: TabState;
  settings: UserSettings;
  auth: AuthState; // 新增：认证状态
}