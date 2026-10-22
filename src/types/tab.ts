import type { SessionSortKey } from '@/core/sessionSort';

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

  /**
   * 本设备打不开这个地址，但数据本身是有效保存的（2026-10-05）。
   *
   * 典型来源：`file://` 本地 PDF、`blob:` 站内临时链接、`devtools:`。
   * 它们**能存进数据库**（保存时用户确实打得开），但不能交给浏览器导航。
   * UI 应据此降级显示（"此标签在当前设备无法打开"）而不是隐藏——
   * 修复前这类行被直接丢弃，导致「存得下、回不来」，且无回收站模型下不可逆。
   *
   * 只在读取侧产生，不上云（TabData 里没有这个字段）：它是「本设备的判断」，
   * 换一台设备（比如装了浏览器的那台）同一个 URL 可能是能打开的。
   */
  unopenable?: true;
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
  user_id?: string; // 关联用户ID
  device_id?: string; // 创建设备ID
  last_sync?: string; // 最后同步时间

  /**
   * 版本号，每次修改时递增，用于检测冲突。
   *
   * 【为什么这里只剩 version，没有 displayOrder】—— 2026-10-20 审计 A-10 收敛。
   *
   * `displayOrder`（曾注释「显示顺序，用户手动拖动时更新」）曾经是**存着但
   * 从不被读来排序**的死字段：列表排序三处（`TabList.tsx`、`tabSlice.ts` 的
   * loadGroups / saveGroup.fulfilled）全按 `createdAt` 倒序；会话组级拖拽排序
   * 早已下线（提交 545f67d，`moveGroup` / `applyMoveGroup` / `updateDisplayOrder`
   * 全部退场）。于是它只是每次同步都在往返一个**永远无效**的字段 ——
   * 数据模型在骗人。
   *
   * 更糟的是**两条后端形状不一致**：WebDAV 的 `encodeGroup` 把它写进分片、
   * `decodeGroup` 把它读回来；Supabase 侧从不上传（数据库里也没有
   * `display_order` 列）。同一份数据在两条路径上解出来的形状不同。
   *
   * 按「删除优于添加」处理：**收敛掉，而不是给它补一个读取方。**
   * 要真正实现「用户手动拖动时更新顺序」，等于要引入一整套排序语义
   * （拖到第几位、与其他设备如何合并、删除后如何重排）—— 那是**产品决策**，
   * 不在修一个死字段的范围里；而现在它连「用户手动拖动」这个入口都没有，
   * 是纯粹的残骸。
   *
   * ⚠️ 老用户本地存储里可能还留着 `displayOrder` 这个键：**无害**（多余字段
   * 被忽略）。刻意**不**写「启动时清掉它」的迁移 —— 那是在给一个没人读的字段
   * 做无用功。
   */
  version?: number; // 版本号，每次修改时递增，用于检测冲突

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

/**
 * 下载侧「读不出来而被整组跳过」的原因（2026-10-20 D-6）。
 *
 * 这些原因**不是**错误码，是**用户需要知道的事实**：
 * 「云端有 N 个会话读不出来」和「云端有 N 个会话被删了」对用户是天壤之别。
 */
export type DownloadSkipReason =
  /** 解密失败 / tabs_data 形状不可恢复（整行读不出来） */
  | 'unreadable_shape'
  /** 还原率低于 MIN_RESTORABLE_TAB_RATIO：部分标签过不了安全校验 */
  | 'restore_ratio'
  /** 老版本 tabs 表回填被网关 db-max-rows 静默截断 */
  | 'tabs_table_truncated'
  /** tabs 表回填的还原率不达标 */
  | 'tabs_table_ratio'
  /** 单组处理抛错（字段形状异常等） */
  | 'processing_error';

/**
 * 一个被整组跳过的会话（2026-10-20 D-6）。
 *
 * ── 不变式：跳过 ≠ 云端没有 ──────────────────────────────────────────
 * 被跳过的组：
 *   · **云端行仍在**，一个字节都没被动过；
 *   · **没有**进入本次下载结果 ⇒ 没有参与合并、没有被登记进删除广播队列；
 *   · 下次下载（修好后）会自然重新出现。
 */
export interface DownloadSkippedGroup {
  /** 云端那一行的会话 id。 */
  id: string;
  /** 为什么读不出来。 */
  reason: DownloadSkipReason;
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
  /**
   * error 的来源标注（1.22.12）。error 是共享字段：loadGroups.rejected 与
   * 列表内写操作（删除/重命名/清理…）的 rejected 都会写它，不标来源时
   * 消费方只能猜 —— 线上日志里一次 removeTab 超时被打成「加载会话列表失败」
   * 就是这么来的。'load'=读路径失败；'action'=列表内写操作失败；null/缺省=无错误。
   */
  errorSource?: 'load' | 'action' | null;
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
  // deleteGroup 乐观删除的回滚基线：groupId → 删除前的整组快照与位置。
  // pending 移除、rejected 按此还原（与 deleteTabAndSync 的 optimisticBackups 同一思路，
  // 但备份粒度是整组）。fulfilled 后清除（磁盘已删，无需回滚基线）。
  deletedGroupBackups?: Record<string, { group: TabGroup; index: number }>;
  // 清理重复标签的收敛基线：pending 时抓取的「清理前活跃视图」快照。
  // fulfilled 用它 + SW 回传的权威计划重推（见 tabSliceHelpers 的 planOptimisticClean
  // 注释：叠加乐观结果无法纠正「本地误删」，只有从快照重推才无条件等于磁盘真值）；
  // rejected 用它整段还原。null = 当前没有在途清理。
  cleanDuplicatesSnapshot?: TabGroup[] | null;
}

// 布局模式枚举
export type LayoutMode = 'single' | 'double';

// 主题风格（2026-09-28 收敛：8 → 6，砍 classic/mint/pink/cyberpunk；
// 存量用户由 storage.validateThemeStyle 的迁移映射归入气质最近的保留主题）
//
// ── 2026-10-09 架构 P2-3：类型从常量派生，不再手抄 ──────────────────────
// 原先这里是 `export type ThemeStyle = 'legacy' | … | 'claude'`，而
// storage.ts 的 VALID_THEME_STYLES 另抄一份同样的数组。两份手抄清单之间
// **没有编译期关联**：给联合类型加一个新成员，运行时校验数组不会跟着更新，
// 于是合法值被判为无效并静默回落 legacy —— 一个不报错的坑。
// 现在方向反过来了：常量是唯一真相源，类型由它派生，加主题只改一处。
export const THEME_STYLES = [
  'legacy',
  'creamy',
  'prism',
  'apple',
  'chrome',
  'claude',
] as const;

export type ThemeStyle = (typeof THEME_STYLES)[number];

export interface UserSettings {
  /**
   * 是否在标签行上显示网站图标（2026-10-20 审计 A-9：从「有设置、无入口、无读取方」
   * 变成**真被读**的开关）。关掉时整行不渲染图标（不是换成占位球 ——
   * 换占位球等于「图标还在」，那是对开关的另一种撒谎）。
   */
  showFavicons: boolean;
  /**
   * 是否显示标签数量（会话卡片徽章 / 搜索结果徽章 / 顶栏「N 标签」）。
   * 同一个字段、同一个含义，三处渲染点共用一个开关。
   */
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
  syncEnabled: boolean; // 是否启用同步
  /**
   * 用哪个后端做同步（2026-10-13，WebDAV 自带存储改造）。
   *
   * 【为什么与 syncEnabled 分开而不是合并成一个枚举】
   * `syncEnabled` 回答「要不要自动同步」，`syncBackend` 回答「跟谁同步」。
   * 合成一个字段（`'off' | 'supabase' | 'webdav'`）看起来更干净，
   * 但会造成一次**静默语义迁移**：存量用户的 `syncEnabled: true` 该映射成
   * `'supabase'` 还是 `'webdav'`？两个都「合理」，而选错的后果是老用户
   * 突然被指向一个没配过的后端。分开后，`syncEnabled` 的语义一个字没变，
   * 存量值天然落回 `supabase`（见 storage 层的 validateSyncBackend）。
   *
   * 【这个字段会被上传到云端吗】会（它在 UserSettings 里）。
   * 所以 **WebDAV 的凭据绝不能放进 UserSettings** —— 那会把应用密码
   * 上传到 Supabase / 用户自己的云盘。凭据走独立的本地键，见
   * `sync-backend/webdav/config.ts` 的文件头。
   */
  syncBackend: 'supabase' | 'webdav';
  /**
   * 自动同步轮询间隔（分钟）。仅 syncEnabled=true 时生效。
   *
   * 2026-10-11（1.23.0）：自动同步默认关闭，用户在菜单中开启后四选一。
   * 取值收敛到 SYNC_INTERVAL_CHOICES（5/10/30/60），非法值由 storage 层
   * validateSyncIntervalMinutes 回落到默认 10 —— 与 themeMode 的校验同纪律：
   * 云端/手工编辑可能带回任意值，读路径必须 fail-safe（回落），不能抛错
   * （抛错会让 getSettings 整条失败，进而阻塞所有读设置的路径）。
   */
  syncIntervalMinutes: number;
  layoutMode: LayoutMode; // 布局模式：单栏、双栏、三栏
  showNotifications: boolean; // 是否显示通知

  /**
   * 会话列表的排序键（2026-10-22 审计 L-10）。
   *
   * 【它是什么】`core/sessionSort.ts` 里的四种排序键之一：
   * `'saved'`（最近保存，默认）/ `'accessed'`（最近活动）/ `'name'`（名称）/
   * `'size'`（会话大小 = 标签数）。
   *
   * 【为什么是界面偏好而不是「仅本机」】它描述的是「用户的会话列表怎么摆」，
   * 与 `layoutMode`（界面布局）、`themeMode`（主题明暗）同一性质 ⇒ 允许随设置
   * 一起跨设备漫游（见 `types/tab.ts` 的 `DEVICE_LEVEL_SETTING_KEYS`：那三个
   * 才是「以本机为准」的设备级字段）。**不新增第三类处理**。
   *
   * 【存量用户】升级后这个键在存储里**不存在** ⇒ 读路径合并
   * `{...DEFAULT_SETTINGS, ...stored}` 后落到默认 `'saved'` ⇒ 列表顺序与升级前
   * 完全一致（默认键就是旧版写死的 `createdAt` 倒序）。
   */
  sessionSort: SessionSortKey;

  // 是否在收集/保存时包含固定标签页（pinned tabs）
  collectPinnedTabs: boolean;

  // 新增主题设置
  themeMode: 'light' | 'dark' | 'auto'; // 主题模式
  themeStyle?: ThemeStyle; // 主题风格

  // 保持向后兼容性的字段（已废弃，但保留以支持旧版本）
  useDoubleColumnLayout?: boolean;
}

/**
 * 2026-10-20 审计 A-9：**已下线的设置**（字段本身已从 UserSettings 删除）。
 *
 * 下面这些键曾经是「有设置、无入口、无读取方」——存着、上云着，但**没有任何
 * 代码读它们**。留着它们有两个害处：
 *   ① 上云的设置里带着用户从没设过的字段（`group_name_template: 'Group %d'`
 *      会随备份导出到别的设备），数据模型在骗人；
 *   ② 它们看起来像「可以调的东西」，但拨了没反应。
 *
 * 逐条结论（删除 or 接入口）：
 *   · groupNameTemplate —— 删。默认值是英文 `'Group %d'`，而真实命名走
 *     `deriveSessionNameFromChromeTabs`（按内容/域名派生），这个模板从未参与。
 *   · allowDuplicateTabs —— 删。它唯一的可能语义是「保存时去重」，而保存路径
 *     现在**不判重**（判重只发生在「清理重复」这个显式动作里）。接上入口就得
 *     改保存语义（把最贵的一个动作变成有损的），不在本轮范围。
 *   · deleteStrategy —— 删。删除永远走「到处删」，要做「只删本地」等于新增一套
 *     删除语义（墓碑/离线队列），风险远大于收益。
 *   · reorderMode —— 删。会话组级拖拽排序早已下线（提交 545f67d），只剩字段。
 *   · syncStrategy —— 删。**它没有任何读取方**：合并固定走组级 LWW
 *     （`mergeOpStamped`），backgroundSync 里只有注释提到它、代码从不读它。
 *     接上入口只会造出「又一个无效开关」。
 *
 * 云端列（`group_name_template` 等）在数据库里可能还留着 —— 下载侧把它们
 * 归入「已退役列」静默跳过，上传侧不再写。见 `supabase/download.ts`。
 */
export const RETIRED_SETTING_KEYS = [
  'groupNameTemplate',
  'allowDuplicateTabs',
  'deleteStrategy',
  'reorderMode',
  'syncStrategy',
] as const;

/**
 * 已退役设置在**云端列名**（snake_case）下的样子，附它们的历史默认值。
 *
 * ── 为什么要有这张表 ──────────────────────────────────────────────────────
 * 退役键在三处各有一份名单，而那三份**没有编译期关联**：
 *   · `RETIRED_SETTING_KEYS`（驼峰，本地设置模型）
 *   · `upload.ts` 的 `RETIRED_COLUMN_FALLBACKS`（云端列名 + 历史默认值）
 *   · `download.ts` 的 `retiredColumns`（云端列名）
 * 改一处忘另一处 ⇒ 要么把退役键又带上了云（数据模型在骗人），
 * 要么把一个**还活着的**列当成退役列静默跳过（设置悄悄丢了一项）。
 * 三份手抄清单之间没有编译期关联 ⇒ 这正是本仓反复修的那类「不报错的坑」。
 *
 * ── 为什么默认值不能省 ────────────────────────────────────────────────────
 * 这几列在数据库里可能还在，且可能是 **NOT NULL 且无默认值**。那样
 * Postgres 在 upsert 的 INSERT 阶段就抛 23502 ⇒ **整条设置同步直接断**。
 * 降级路径要用历史默认值把那一列补齐后重试（见 `supabase/upload.ts` 的
 * 23502 分支），而「历史默认值」只有这一处知道 —— 值必须与旧客户端
 * 曾经写入的一致（`DEFAULT_SETTINGS` 里的原值），这样降级写回云端的行
 * 与老客户端写出来的行没有区别。
 *
 * `reorderMode` 的历史值是 `false`（它当时是 `reorderMode?: boolean`，
 * 默认没写进 DEFAULT_SETTINGS，故落回 `undefined` ⇒ 写上去就是 false）。
 */
export const RETIRED_SETTING_COLUMN_DEFAULTS = {
  group_name_template: 'Group %d',
  allow_duplicate_tabs: false,
  delete_strategy: 'everywhere',
  sync_strategy: 'newest',
  reorder_mode: false,
} as const satisfies Record<string, unknown>;

/**
 * 已退役设置对应的**云端列名**集合（snake_case）。
 *
 * 下载侧用它把退役列静默跳过（不报 warning —— 它们是**已知**的历史遗留，
 * 不是「未知字段」；每次下载都刷一堆 warning 会把真正的未知字段淹没）。
 */
export const RETIRED_SETTING_COLUMNS: ReadonlySet<string> = new Set(
  Object.keys(RETIRED_SETTING_COLUMN_DEFAULTS)
);

/**
 * 驼峰 → snake_case（与 `supabase/upload.ts` 的转换规则一致）。
 *
 * 单点定义：上传侧把驼峰键转成列名、下载侧把列名转回驼峰键，
 * 两边必须用**同一个**规则 —— 两份手抄的转换函数迟早会漂移。
 */
export function settingKeyToColumn(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * 设备级字段：不上云、不被云端覆盖，也不随备份文件跨设备（2026-10-18 产品定稿）。
 *
 * 这三个字段描述的是「**这台设备**拿哪个后端同步、要不要自动同步、多久一次」，
 * 而不是「用户长什么样、怎么用」：
 *   - `syncBackend`：WebDAV 的地址与口令本来就不进 UserSettings
 *     （见 sync-backend/webdav/config.ts 文件头）。把它带到别的设备，对端会指向
 *     一个它没有凭据的后端 ⇒ 同步直接坏掉，而用户只看到「同步失败/请先登录」，
 *     根本无从判断是自己的后端被换了。
 *   - `syncEnabled` / `syncIntervalMinutes`：描述本机的后台行为，alarm 与解锁态
 *     都是设备级的。在 A 机关掉自动同步、B 机开着，B 一次同步就把 A 的选择改回去。
 *
 * 云端与备份文件只承载外观与操作偏好（主题、布局、通知、固定标签等）。
 * 三条外来的设置路径都要剔除这三个键（只做一侧不够，另一侧会把值带回来）：
 *   - 上云：`settingsSyncService.toCloudSettings`
 *   - 云端合并：`syncEngine.mergeCloudSettingsIntoLocal`
 *   - 导入备份：`storage.importDetailed`
 * 键仍然留在本地存储与 UI 里 —— 它们只是「不跨设备」。
 */
export const DEVICE_LEVEL_SETTING_KEYS = [
  'syncBackend',
  'syncEnabled',
  'syncIntervalMinutes',
] as const;

/**
 * 剔除「不跨设备」与「已退役」的设置键。
 *
 * ── 为什么要有这个共用函数（2026-10-20 审计 A-21）────────────────────────
 *
 * 外来设置有**四条**路径，每条都必须剔除同一批键：
 *   · 上云：`settingsSyncService.toCloudSettings`
 *   · 云端合并：`syncEngine.mergeCloudSettingsIntoLocal`
 *   · **导入备份**：`storage.importDetailed`
 *   · **导出备份**：`storage.exportData` ← 2026-10-20 才发现漏了这条
 *
 * 前三条各自写了一遍剔除逻辑（写法还不完全一样），第四条**根本没写** ⇒
 * 导出的备份文件里躺着 `syncBackend` / `syncEnabled` / `syncIntervalMinutes`
 * 以及可能残留的已退役键。
 *
 * 【为什么导出侧也必须剔】
 * ① **语义一致**：备份文件在导入时会被剔掉这三个键 ⇒ 写在文件里就是
 *    **「文件内容在表达一个假承诺」** —— 用户打开备份看到
 *    `syncBackend: "supabase"`，理所当然以为「导入后同步设置也会跟着走」，
 *    而实际不会。
 * ② **已退役键**在本地也不生效（`setSettings` 会剔）⇒ 写进备份纯属噪声，
 *    而且会让「数据模型在假装它们存在」这件事扩散到用户手上的文件。
 *
 * ⇒ 规则只写这一个函数，四条路径共用。
 */
export function stripNonPortableSettings<T extends Partial<UserSettings>>(
  settings: T
): Partial<UserSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const key of DEVICE_LEVEL_SETTING_KEYS) delete out[key];
  for (const key of RETIRED_SETTING_KEYS) delete out[key];
  return out as Partial<UserSettings>;
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
  /**
   * 「云端项目被限制 / 服务端不可用」（2026-10-22，402 收口）。
   *
   * ── 为什么要有这个字段（而不是只靠 error 的文案）───────────────────────
   * 账号校验失败时有两类完全不同的成因，而它们需要的收尾动作正好相反：
   *   · **令牌过期 / 真没登录** ⇒ 登录态读成 false，界面引导去登录；
   *   · **服务端整体不可用**（项目被封禁）⇒ 用户**明明登录着**，只是服务端
   *     暂时确认不了 ⇒ 登录态必须**保留**，界面只能说「等我们恢复」。
   *
   * 后者若被读成「未登录」，用户看到的是「还没有登录 TapStack 云端」——
   * 一句比「请重试」更重的谎（他会去重新登录、重新输密码，而那毫无用处）。
   *
   * ⚠️ 这是一个**机器标记**：判据在 core/backendUnavailable.ts（HTTP 状态码 /
   * 报文标记），不靠文案匹配 —— 界面文案一改，判据不会漂。
   *
   * 字段缺失 ⇒ 本轮没有这件事。
   */
  backendUnavailable?: boolean;
}

export interface RootState {
  tabs: TabState;
  settings: UserSettings;
  auth: AuthState; // 新增：认证状态
}
