export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: string;
  lastAccessed: string;
  group_id?: string; // 关联标签组ID

  /** 是否为固定标签页，默认 false */
  pinned: boolean;

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  /** @deprecated 无墓碑模型（2026-09-29）新写入不再产生；仅为读取老版本设备数据保留 */
  isDeleted?: boolean;
  /** @deprecated 同上（老数据兼容读取） */
  deletedAt?: string;

  // 阶段二·§4.1：操作印记（写入者）。merge 时按全序决胜。
  lastOp?: { d: string; s: number };
}

// 用于存储到 Supabase 的标签数据格式
export interface TabData {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  created_at: string;
  last_accessed: string;
  /** 是否为固定标签页，默认 false（向后兼容，可选） */
  pinned?: boolean;
  /** 软删除墓碑标记：true 表示该标签已被删除，同步时删除意图跨设备传播（向后兼容，可选） */
  is_deleted?: boolean;
  /** D3：删除时刻 ISO（随 tabs_data JSON 往返；缺失回退 last_accessed/组 updatedAt） */
  deleted_at?: string;
  // 阶段二·§5.3：tab 级操作印记随 tabs_data JSON 上云往返（NULL = 最小值，老数据/老客户端兼容）
  last_op_device?: string | null;
  last_op_seq?: number | null;
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
  // 阶段二·§6.1：操作印记列。客户端带 stamp 上传；老客户端不带时为 NULL（视为最小值）。
  last_op_device?: string | null;
  last_op_seq?: number | null;
  // 保留兼容（阶段二·§11 冻结 version 字段）；不再用于冲突裁决。
  version?: number | null;
  /** D3：组级删除时刻（需云端 deleted_at 列，见迁移；缺失回退 updated_at） */
  deleted_at?: string | null;
}

export interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
  notes?: string;
  isFavorite?: boolean;
  user_id?: string; // 关联用户ID
  device_id?: string; // 创建设备ID
  last_sync?: string; // 最后同步时间

  // 版本控制和排序
  version?: number; // 版本号，每次修改时递增，用于检测冲突
  displayOrder?: number; // 显示顺序，用户手动拖动时更新

  // 同步相关字段
  syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';
  lastSyncedAt?: string | null;
  /** @deprecated 无墓碑模型（2026-09-29）本地新写入不再产生；云端 is_deleted 行为删除广播载体，读路径防御保留 */
  isDeleted?: boolean;
  /** @deprecated 同上（老数据兼容读取） */
  deletedAt?: string;

  // 阶段二·§4.1：操作印记（写入者）。merge 时按全序决胜。
  lastOp?: { d: string; s: number };
}

/** deleteTabAndSync 单项乐观备份（key 化槽位的值类型） */
export interface OptimisticTabBackup {
  groupId: string;
  tabId: string;
  /** 被移除 tab 的深拷贝（回滚时单项重插用） */
  tab: Tab;
  /** 移除前在组内的下标（回滚时尽量原位插回） */
  index: number;
  /** pending 发起时整组的深拷贝（组被拿空时的恢复基线） */
  snapshot: TabGroup;
}

export interface TabState {
  groups: TabGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  syncStatus: 'idle' | 'syncing' | 'success' | 'error'; // 同步状态
  lastSyncTime: string | null; // 最后同步时间
  lastLoadedAt: string | null; // 本地数据最近一次成功加载时间（hydration 判断）
  lastSyncStatus: 'local' | 'cloud' | null; // 最近一次数据来源

  // 定义压缩统计信息类型（虽然已废弃，但保留类型定义以保持向后兼容）
  compressionStats?: {
    originalSize?: number;
    compressedSize?: number;
    ratio?: number;
    savedBytes?: number;
  } | null;
  backgroundSync: boolean; // 是否在后台同步
  syncProgress: number; // 同步进度（0-100）
  syncOperation: 'none' | 'upload' | 'download'; // 当前同步操作类型
  // deleteTabAndSync 乐观更新的回滚备份：按 `${groupId}:${tabId}` key 化。
  // 单槽位在快速连点不同 tab 时会被后一次 pending 覆盖，导致 rejected 错位回滚；
  // key 化后 fulfilled/rejected 只处理对应项，互不干扰。
  // （pending 写入对应项，fulfilled 清对应项，rejected 只回滚对应项）
  optimisticBackups?: Record<string, OptimisticTabBackup>;
  // 回环代际 guard：deleteTabAndSync.pending 自增 mutationEpoch；
  // loadGroups.pending 快照发起时 epoch，fulfilled 时若快照
  // 落后于当前 epoch（mutation 在途期读到的旧快照）则忽略，避免覆盖乐观态。
  // 与发起时 epoch 相等则接受——外部变更（他端同步）触发的新回环不受影响，不饿死。
  mutationEpoch?: number;
  pendingLoadGuards?: Record<string, number>;
}

// 布局模式枚举
export type LayoutMode = 'single' | 'double';

// 主题风格类型（2026-09-28 收敛：8 → 4，砍 classic/mint/pink/cyberpunk；
// 存量用户由 storage.validateThemeStyle 的迁移映射归入气质最近的保留主题）
export type ThemeStyle = 'legacy' | 'creamy' | 'prism' | 'apple' | 'chrome' | 'claude';

export interface UserSettings {
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  allowDuplicateTabs: boolean;
  syncEnabled: boolean; // 是否启用同步
  layoutMode: LayoutMode; // 布局模式：单栏、双栏、三栏
  showNotifications: boolean; // 是否显示通知

  // 是否在收集/保存时包含固定标签页（pinned tabs）
  collectPinnedTabs: boolean;

  // 新增同步策略设置
  syncStrategy: 'newest' | 'local' | 'remote' | 'ask'; // 冲突解决策略
  deleteStrategy: 'everywhere' | 'local-only'; // 删除策略

  // 新增主题设置
  themeMode: 'light' | 'dark' | 'auto'; // 主题模式
  themeStyle?: ThemeStyle; // 主题风格

  reorderMode?: boolean; // 新增：全局重新排序模式

  // 保持向后兼容性的字段（已废弃，但保留以支持旧版本）
  useDoubleColumnLayout?: boolean;
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
