/**
 * S2 存储 KV 收敛：KV 键常量单源。
 *
 * 收敛前同一批键字符串散在两处：
 * - src/utils/storage.ts 的 STORAGE_KEYS（门面读写用）
 * - src/storage/storageAdapter.ts 的 MIGRATION_KEYS（迁移扫描用）
 * 值相同、文本分叉——改键名只改一处即数据分叉（旧数据读不到）。
 * 本模块是唯一真相源：MIGRATION_KEYS 的每一项都直接引用 STORAGE_KEYS /
 * LEGACY_KEYS，保证编译期同源。STORAGE_VERSION 一并下沉。
 */

export const STORAGE_KEYS = {
  VERSION: 'storage_version',
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings',
  DELETED_GROUPS: 'deleted_tab_groups',
  DELETED_TABS: 'deleted_tabs',
  LAST_SYNC_TIME: 'last_sync_time',
  SYNC_SNAPSHOT: 'sync_snapshot',
  PRODUCT_EVENTS: 'product_events',
  MIGRATION_FLAGS: 'migration_flags',
  // ponytail: 本地是否有未上传变更。跨进程持久化——MV3 popup 失焦销毁后
  // 依然能从 chrome.storage / IndexedDB 读回。后续轮询 / 上传 alarm 唤醒 SW
  // 时检查此标志，未上传则先上传，避免云端旧版本覆盖本地新版本。
  PENDING_UPLOAD: 'pending_upload',
  // 最近一次成功上传的时间戳（独立于 last_sync_time，后者下载也会更新）。
  // 用于：1）downloadAndMerge 保护窗口 2）调试 / product_event 上报
  LAST_UPLOAD_TIME: 'last_upload_time',
  // P1-6：已在本地 purge（物理移除）但尚未同步到云端的组 id 队列。
  // purge 把内联墓碑从 groups 数组里彻底删掉后，upload 侧再也看不到删除意图——
  // 不记这个队列，云端墓碑行会永久残留，下次下载以 remote-only 复活。
  PENDING_PURGE_IDS: 'pending_purge_ids',
  // 阶段二·§4.1：本设备 seq 单调计数器。SW 启动时由 seqRegistry 修复为
  // max(持久化, 实体印记中本设备 max s) + 100。
  DEVICE_SEQ: 'device_seq',
  // 阶段二·§4.3：journal write-ahead log（FIFO 上限 1000）。
  JOURNAL: 'journal',
  // 阶段二·§4.3：upload 成功后已确认的最大 seq，调试视图用。
  LAST_SYNCED_SEQ: 'last_synced_seq',
  // 阶段二·§7：存量数据迁移完成标记。
  OP_STAMP_MIGRATED: 'op_stamp_migrated',
} as const;

export const STORAGE_VERSION = 5;

/** 历史遗留键：早期版本写在 chrome.storage.local / localStorage 里的旧键名。 */
export const LEGACY_KEYS = {
  /** 早期版本存放在 chrome.storage.local 的设备键 */
  LEGACY_DEVICE_ID: 'deviceId',
  /** 早期 service worker 使用的标签组键 */
  LEGACY_TAB_GROUPS: 'tabGroups',
  /** 逐组存储时代的前缀 */
  TAB_GROUP_PREFIX: 'tabGroup_',
  /** 现行设备键 */
  DEVICE_ID: 'tabvaultpro_device_id',
} as const;

/**
 * storageAdapter 迁移扫描用的键表（形状与旧内联 MIGRATION_KEYS 完全一致，
 * 值全部引用 STORAGE_KEYS / LEGACY_KEYS，杜绝分叉）。
 */
export const MIGRATION_KEYS = {
  deviceId: LEGACY_KEYS.DEVICE_ID,
  legacyDeviceId: LEGACY_KEYS.LEGACY_DEVICE_ID,
  tabGroupPrefix: LEGACY_KEYS.TAB_GROUP_PREFIX,
  tabGroups: STORAGE_KEYS.GROUPS,
  legacyTabGroups: LEGACY_KEYS.LEGACY_TAB_GROUPS,
  userSettings: STORAGE_KEYS.SETTINGS,
  deletedGroups: STORAGE_KEYS.DELETED_GROUPS,
  deletedTabs: STORAGE_KEYS.DELETED_TABS,
  lastSyncTime: STORAGE_KEYS.LAST_SYNC_TIME,
  migrationFlags: STORAGE_KEYS.MIGRATION_FLAGS,
} as const;
