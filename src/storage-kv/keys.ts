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
  // ── 2026-10-18 P1#4：WebDAV 首次同步归属决策是否仍未完成 ──────────────
  // 问题：切到自带存储后，本地已有会话不会自动上传（正确，由用户决定归属），
  // 但 `TabManager` 保存新会话时的 `scheduleUpload` 仍会置 pending_upload，
  // 而适配器在「远端还没有 manifest」时走 firstSync = 全量上传
  // （adapter.uploadGroups：`firstSync || overwriteRemote` ⇒ 全量）。
  // 于是「配好但没点检查并推送，随后保存一个标签页」⇒ **全部旧会话被自动推上去**，
  // B7 的三选一归属决策被完全绕过 —— 用户从没问过，决策替他做了。
  //
  // 语义：`true` = 归属未定，自动上传必须被挡住（只允许显式的首次推送走全量）；
  //       `false`/缺失 = 决策已完成（或从未进入 WebDAV），恢复正常自动上传。
  // 不存在 = 已完成：这样老用户升级后不会被无端挡住同步。
  //
  // ⚠️ 2026-10-20：**值**的形状从「全局单值」改成「按库寻址的记录」
  // （`{ 库身份: 是否待决 }`），判据与取值规则见
  // `storage-kv/firstSyncPendingRecord.ts`（纯函数，可直接做行为断言）。
  // 键名**不变** —— 它仍是单键（`storage.clear()` 的键清单由
  // `Object.values(STORAGE_KEYS)` 派生，动态键派生不出来 ⇒ 动态键会变成
  // 清不掉的孤儿待决位，而它会把同步永久降级成增量）。
  // 旧格式（全局布尔值）的迁移语义也在那个模块里写明。
  FIRST_SYNC_PENDING: 'webdav_first_sync_pending',
  // ── 2026-10-24 审计 DS-43-20：账号归属账本 ──────────────────────────────
  // 本机那批会话「归哪个账号」的账本（记着 ownerUserId 与逐会话的例外归属）。
  //
  // 【为什么它必须与本机会话在同一个库里】它原先落在 chrome.storage.local
  // 的独立键里，而会话本体在 KV 层（IndexedDB）⇒ **两个库各活各的** ⇒
  // 只要 chrome.storage.local 被整片清掉（浏览器清扩展数据、或任何新增的
  // 「重置一切」路径）：
  //   ① 归属账本没了（ownerUserId 变 null）；
  //   ② 会话还在（KV 没动）；
  //   ③ 下一次登录走 decideAccountBind 的 first-bind 分支 ⇒
  //      **本机残留的会话被静默认领给新登录的账号** ⇒ 跨账号泄露
  //      （DS-1 的原始后果被完整重开；数据安全审计 DS-43-20，条件性 P0）。
  //
  // ⇒ 搬进 KV 层后，「会话还在 ⇒ 账本还在」成为**结构事实**：
  //  · 清 chrome.storage.local 动不了它（登录态与云盘凭据还在那儿）；
  //  · 「清除本地数据」（storage.clear，键清单由 Object.values(STORAGE_KEYS)
  //    派生）会把两者**一起**清掉 —— 那时会话也没了，无可归属，不亏。
  //
  // ⚠️ 搬动它 = 一条**数据迁移**（读旧键 → 写 KV → 删旧键）。迁移在
  // `utils/authCache.ts` 的 accountScopeStore.read() 里做**一次性**补搬
  // （不能靠 chrome.storage→KV 那次通用迁移：它对存量用户早已跑过，
  //  标志位 chromeStorageMigrated 为真 ⇒ 不会再跑一遍）。
  ACCOUNT_SCOPE: 'local_account_scope',
  // ── 2026-10-18 P1#4 第二半：「本次操作改动过的会话 id」队列 ──────────────
  // 上面那个标志只说了「待决期不许全量」，而适配器降级后用的判据是
  // `selectDirty(groups, 水位)` —— 远端还没有 manifest 时水位恒为 0，
  // 于是**全部历史会话**都被判成脏，「抑制」成了死代码（实测抑制前后上传内容逐字相同）。
  // 判据改成写方一路记下来的 id：保存路径知道它刚写了哪个组，mutation 命令本身
  // 也带着受影响的 id（见 core/mutationAffectedGroups）。
  //
  // 语义：`string[]` = 待决期唯一允许上传的会话 id；读不到 ⇒ 空数组 ⇒ 什么都
  // 不上传（fail-closed —— 待决期少传只是「留在本机等用户决定」，多传才是违约）。
  // 清队时机：上传成功之后、或归属决策完成时（setFirstSyncPending(false)）。
  PENDING_UPLOAD_GROUP_IDS: 'pending_upload_group_ids',
  // ── 2026-10-20 D-3：增量白名单的登记**曾经失败过** ──────────────────────
  // 上面那个队列是「本轮登记了哪些会话要传」。登记本身是**写操作**，
  // 会失败（quota、死句柄看门狗、事务 abort）。
  // 失败的后果不是「少传几个」而是「**不知道漏了哪几个**」——
  // 于是「队列与上行集合对得上账」这件事已经**不能**作为清 pending_upload
  // 的依据（对得上只说明「登记到的都传了」，没说明「没登记的也没漏」）。
  //
  // 语义：`true` = 有过登记失败 ⇒ 本轮**不得**宣称「全部同步」，
  // 也不得清 pending_upload（保留它让下一轮继续尝试）。
  // 读不到 ⇒ false（fail-closed 方向：读不到不代表失败过，
  // 把它当 true 会让上传永远清不掉标志 ⇒ 无限重试）。
  PENDING_UPLOAD_REGISTRY_UNRELIABLE: 'pending_upload_registry_unreliable',
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

/**
 * 存储格式版本号 —— **它不是迁移闸门**（2026-10-20 升级路径审计 U-3 更正）。
 *
 * ── 它实际是什么 ──────────────────────────────────────────────────────────
 * 一个「本机最后一次写入时用的格式版本」的**标记字段**。唯一使用点
 * （utils/storage.ts 的 ensureVersion）只做两件事：
 *   1. 读出它；
 *   2. 若与当前值不同 ⇒ **写回当前值**。
 * 它**从不**比较 `stored < current`，也**从不**据此分支到任何迁移。
 *
 * ── 为什么不是「按版本迁移」 ──────────────────────────────────────────────
 * 本仓的迁移机制**另有其人**：`utils/migrationUtils.ts` 的**逐项迁移标志**
 * （`shouldRunMigration('favicon_urls_v1')` / `'tombstone_purge_v1'` …）。
 * 那种形态按「迁移项」而非「版本号」记账，天然做到：
 *   · 每个迁移**独立幂等**（跑过就跳过，没跑过就补跑）；
 *   · **不必**在两个版本之间做 diff（版本号模型要求「从 vN 到 vN+1 依次执行」，
 *     于是任何一次跳过都会把后面所有迁移永久错过）；
 *   · 加一条迁移 = 加一个标志，不动版本号（版本号模型要求 bump 版本号，
 *     而 bump 之后又必须记得补一条迁移 —— 两处都要改，容易只改一处）。
 *
 * 换句话说：**版本号模型在本仓是多余的闸门，而「看起来有个闸门」比「没有闸门」
 * 更危险** —— 后来的开发者会以为「数据形状变了只要 bump 版本号就有地方挂迁移」，
 * 而实际上那里什么都没挂。
 *
 * ── 为什么保留这个字段（而不是删掉） ──────────────────────────────────────
 * 它是一个**诊断量**：出问题时可以从用户磁盘上读出「这台机器最后写入时
 * 认为的格式版本」，与当前版本对照，判断是不是「从某个老版本直接跳过来」的。
 * 保留成本极低（一次读 + 一次写），诊断价值实在。
 *
 * ⚠️ 若将来真的要做「按版本迁移」，请**先**把它改成真正的闸门
 * （`stored < current` ⇒ 跑一张 version → migration 表），
 * 并**同步**把 utils/migrationUtils.ts 的逐项标志制改掉 —— 两套机制并存必然
 * 出现「某个版本号区间里的迁移，两套机制都以为对方会做」。
 */
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

/**
 * 源键 → 目标键的**改名表**（2026-10-20 审计 A-15 收口）。
 *
 * 【为什么需要它】`MIGRATION_SCAN_KEYS` 只保证「旧键会被扫到」，但
 * `migrateFromChromeStorage` 搬运时**沿用源键名**写入 KV ——
 * 于是 chrome.storage.local 里的 `tabGroups`（历史键）会被写进
 * IndexedDB 的 `tabGroups` 键，而应用只读 `tab_groups`（现行键）。
 * 结果：数据搬了，但**搬到了一个没人读的键上** ⇒ 用户看不到自己的会话，
 * 而存储层一路绿灯（没有报错、没有告警）。
 *
 * 【为什么以前没炸】历史上 chrome.storage.local 里的会话键**一直**是
 * `tab_groups`（`tabGroups` 只是更早的 service worker 读过一次就删的
 * 过渡键）。但这个"历史上没人写"不是可以依赖的保证 ——
 * 只要有一版把 `tabGroups` 真的写进去过（分叉分支、用户手改、
 * 未来的一次重构），迁移就会静默把它搬进死键。
 *
 * 【这里的取舍】改名表只登记**键名不同、数据同类**的迁移：
 * `tabGroups` → `tab_groups`。设备键（`deviceId` → `tabvaultpro_device_id`）
 * 不在表里 —— 它是**现行键**（LEGACY_KEYS.DEVICE_ID），源侧同名的
 * `deviceId` 是更早的历史键，同样按源键名搬走即可（`deviceUtils`
 * 读的是 `tabvaultpro_device_id`，历史 `deviceId` 值搬过去后仍是
 * 「另一个键上的旧值」，与本表无关）。
 */
export const MIGRATION_KEY_RENAMES: Readonly<Record<string, string>> = {
  [LEGACY_KEYS.LEGACY_TAB_GROUPS]: STORAGE_KEYS.GROUPS,
};
