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

// 用于存储到 Supabase 的标签数据格式
export interface TabData {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  created_at: string;
  last_accessed: string;
}

// 用于 Supabase 中的 tab_groups 表结构
export interface SupabaseTabGroup {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  is_locked: boolean;
  user_id: string;
  device_id: string;
  last_sync: string;
  tabs_data?: TabData[];
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
  syncStatus: 'idle' | 'syncing' | 'success' | 'error'; // 同步状态
  lastSyncTime: string | null; // 最后同步时间
  compressionStats?: any | null; // 压缩统计信息（已废弃）
  backgroundSync: boolean; // 是否在后台同步
}

export interface UserSettings {
  autoCloseTabsAfterSaving: boolean;
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
  syncEnabled: boolean; // 是否启用同步
  useDoubleColumnLayout: boolean; // 是否使用双栏布局
  showNotifications: boolean; // 是否显示通知

  // 新增同步策略设置
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask'; // 冲突解决策略
  deleteStrategy: 'everywhere' | 'local-only'; // 删除策略
}

export interface User {
  id: string;
  email: string;
  lastLogin: string;
  // 微信用户相关字段
  wechatInfo?: {
    nickname?: string;
    avatar?: string;
    openid?: string;
    unionid?: string;
  };
  // 登录方式
  loginProvider?: 'email' | 'google' | 'github' | 'wechat';
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  // 微信登录相关状态
  wechatLoginStatus?: 'idle' | 'pending' | 'scanning' | 'confirming' | 'success' | 'failed' | 'expired';
  wechatLoginTabId?: number; // 微信登录标签页ID
}

export interface RootState {
  tabs: TabState;
  settings: UserSettings;
  auth: AuthState; // 新增：认证状态
}