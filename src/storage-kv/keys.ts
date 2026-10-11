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
  // P1-6（历史）：本地 purge（物理移除）未同步的组 id 队列。无墓碑重写后废弃，
  // 残留值由迁移 purge_tombstones_v1 转入 PENDING_DELETE_IDS 后删除本键。
  PENDING_PURGE_IDS: 'pending_purge_ids',
  // 无墓碑模型：本地已物理删除、但云端行尚未标记 is_deleted 的组 id 队列。
  // 组删除的唯一跨设备广播载体（本地不留任何删除痕迹）：
  // mutation 登记 → upload 时 markCloudGroupsAsDeleted 成功（读回确认）后清队。
  PENDING_DELETE_IDS: 'pending_delete_ids',
  // 阶段二·§4.1：本设备 seq 单调计数器。SW 启动时由 seqRegistry 修复为
  // max(持久化, 实体印记中本设备 max s) + 100。
  DEVICE_SEQ: 'device_seq',
  // 阶段二·§4.3：journal write-ahead log（FIFO 上限 1000）。
  JOURNAL: 'journal',
  // 阶段二·§4.3：upload 成功后已确认的最大 seq，调试视图用。
  LAST_SYNCED_SEQ: 'last_synced_seq',
  // 阶段二·§7：存量数据迁移完成标记。
  OP_STAMP_MIGRATED: 'op_stamp_migrated',
  // 性能 span 环形缓冲（诊断观测用，见 @/utils/perfTrace）。
  // 不参与任何业务判定，因此不属于「数据键」；但同样必须走键常量单源，
  // 否则改名时新旧两份 trace 会各自累积、诊断导出只看到其中一份。
  PERF_SPANS: 'perf_spans',
  // ── 2026-10-10 F2 增量上传 ──────────────────────────────────────────────
  // **为什么这个键不在本文件**（打破「STORAGE_KEYS 是所有落盘键的唯一事实来源」
  // 的惯例，并且这是一次经过论证的打破，不是遗忘）：
  //
  // 1) 它不是**业务数据**，是「本设备最后确认上云的 max(seq)」——一个可以随时
  //    重建的推导量。把它当成用户数据会带来一个硬性代价：`storage.clear()`
  //    （清除本地数据）与 runMigrations 都按 `Object.values(STORAGE_KEYS)` 派生
  //    键清单；把推导量塞进去，用户「清除本地数据」后它也该清（没问题），但
  //    **换账号**时它也必须清 —— 而 STORAGE_KEYS 没有任何账号维度的概念，
  //    放进键表就等于让「按 user_id 隔离」的 RLS 语义与一个本地单值键纠缠。
  //    放在按账号寻址的 supabase 子目录里，用户隔离与失效语义都自洽。
  //
  // 2) 漏传的**方向性**要求（见 supabase/upload.ts selectDirtyGroupsForUpload）：
  //    水位丢失必须退化为全量上传。水位**只有**在「上行成功 + 读回校验通过」后
  //    才写，写失败抛错 ⇒ 下轮重试；读失败按 0 处理 ⇒ 全量。这三条纪律要求
  //    它由使用它的链路自己持有（上传.ts），而不是一个「谁都能清、谁都能改」
  //    的共享键表项。
  //
  // 3) 键名集中定义在 utils/supabase/syncWatermark.ts（单一真相），
  //    storageKvConvergence 的「MIGRATION_SCAN_KEYS 必须覆盖全部键」断言按
  //    STORAGE_KEYS 派生，这个键**故意不参与 chrome.storage → IndexedDB 的
  //    一次性迁移扫描**：它只在本机产生、只需跟随账号失效，从 chrome.storage
  //    迁进来一个旧账号的水位才是 bug（会把新账号的第一轮上传跳过整库）。
  //
  // 代价（如实记下）：「键单源」从此有一个显式例外，新增其它推导量时评审需要
  // 知道这条规则；本注释就是那条规则的载体。
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
 *
 * 【2026-10-07 专家团体检 P1-7】原先这张表是**手抄**的子集，只有 9 项，而
 * STORAGE_KEYS 已有 16 项。手抄的代价是：STORAGE_KEYS 每加一个业务键，这里
 * 就会静默漏一个，而漏掉的后果**不是少迁一个键，是丢一整个语义**：
 *   - PENDING_DELETE_IDS 漏 → 跨设备删除广播队列丢失，已删组在对端复活
 *   - DEVICE_SEQ 漏        → Lamport 时钟归零，换机/清数据后「改什么都存不住」
 *   - LAST_UPLOAD_TIME 漏  → downloadAndMerge 的保护窗口失效，刚上传完就下载
 *                            → 用云端旧数据覆盖本地
 * 这条路径只跑一次（flags.chromeStorageMigrated 为假时），所以对已经在用
 * IndexedDB 的用户无影响；但对**从 v1.21.x 直升上来的老用户**是真实的数据丢失，
 * 而仓库里有 13 个历史迁移文件证明这个升级路径是活的。
 *
 * 修法：不再手抄 —— 由 STORAGE_KEYS 全量派生（下方 migrationDerivedKeys），
 * 再并上 LEGACY_KEYS 那几个只存在于 chrome.storage 的历史键。
 */
export const MIGRATION_KEYS = {
  deviceId: LEGACY_KEYS.DEVICE_ID,
  legacyDeviceId: LEGACY_KEYS.LEGACY_DEVICE_ID,
  tabGroupPrefix: LEGACY_KEYS.TAB_GROUP_PREFIX,
  tabGroups: STORAGE_KEYS.GROUPS,
  legacyTabGroups: LEGACY_KEYS.LEGACY_TAB_GROUPS,
  // 迁移幂等标志：没有它，每次冷启动都会把旧值重新覆盖回 KV（见 storageAdapter）。
  // 它同时也在 STORAGE_KEYS 里，下面 MIGRATION_SCAN_KEYS 会一并扫到，
  // 这里单列一个别名只为让「读标志」这个语义在调用点自解释。
  migrationFlags: STORAGE_KEYS.MIGRATION_FLAGS,
} as const;

/**
 * 需要从 chrome.storage.local 扫进 KV 的**全部**键 = STORAGE_KEYS 的每个值
 * + LEGACY_KEYS 里的历史键名。
 *
 * 为什么用派生而不是再手抄一张表：这张表是「所有会落盘的键」的单一事实来源，
 * 新增业务键只改 STORAGE_KEYS 一处，迁移扫描自动跟上。守卫测试
 * （tests/storageKvConvergence.test.ts 的差集断言）会钉住这个不变量。
 */
export const MIGRATION_SCAN_KEYS: readonly string[] = [
  ...Object.values(STORAGE_KEYS),
  LEGACY_KEYS.DEVICE_ID,
  LEGACY_KEYS.LEGACY_DEVICE_ID,
  LEGACY_KEYS.TAB_GROUP_PREFIX,
  LEGACY_KEYS.LEGACY_TAB_GROUPS,
];
