import { TabGroup, UserSettings, LayoutMode, ThemeStyle, THEME_STYLES, RETIRED_SETTING_KEYS, RETIRED_SETTING_COLUMN_DEFAULTS, stripNonPortableSettings } from '@/types/tab';
import { parseOneTabFormat, formatToOneTabFormat } from '@/core/oneTabFormatParser';
import { secureStorage } from './secureStorage';
import { kvGet, kvSet, kvRemove } from '@/storage/storageAdapter';
import { notifyGroupsChanged, subscribeGroupsChanged } from '@/storage-kv/groupsChangedBus';
import { STORAGE_KEYS, STORAGE_VERSION } from '@/storage-kv/keys';
import {
  resolveCurrentLibraryScope,
  resolveFirstSyncPending,
  toPendingRecord,
} from '@/storage-kv/firstSyncPendingRecord';
import { cacheManager, cachedAsyncFn, debounceAsync } from './performance';
import { logError, logWarn } from './log';
// 导入路径需要与 SW 单写者同构的语义：盖印记（LWW 载体）+ URL 白名单 + 重排。
// 纯函数在 @/core/mutationOps，与 mutationHandlers 走的是同一份实现，
// 本地兜底（无 SW 语境）与 SW 语义不可能漂移。
import { applyImportGroups } from '@/core/mutationOps';
import { normalizeImportedGroup } from '@/core/normalizeTabsData';
import { sanitizeTabUrl } from './inputValidation';
import { createSeqRegistry } from './seqRegistry';
import { getDeviceId } from './deviceUtils';
import { sendMutation, TIMEOUT_REASON_PREFIX } from '@/shared/mutationProtocol';
import type { OpStamp } from '@/core/opStamp';
import { nanoid } from '@reduxjs/toolkit';

/**
 * 是否存在可接收 MUTATE 消息的 Service Worker。
 * 扩展运行时为真；网页版 / node:test 无 chrome 或无 runtime.sendMessage，为假。
 * 判定用 chrome.runtime.sendMessage 的**存在性**而非试发消息：试发失败无法区分
 * 「SW 暂时不可用」（此时必须让用户重试，绝不能退回本地直写把竞态请回来）
 * 与「根本没有 SW」（网页版，此时本地直写是唯一正确行为）。
 */
function hasMutationSender(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
}

/**
 * 删除广播队列的内存兜底（见 getPendingDeleteIds）。
 * 进程级状态，key = 组 id；只在 KV 写失败时兜住删除意图，不让删除被静默撤销。
 * 生命周期由 clearPendingDeleteIds 决定：只有被调用方点名「本轮已广播成功」的 id
 * 才会从这里消失——所以**不要**把它当成「一次上传周期结束就清空」的临时缓冲。
 */
const unsyncedDeleteIds = new Set<string>();

// S2 收敛：KV 键常量单源见 @/storage-kv/keys（与 storageAdapter 迁移键表同源）。
// 此处 re-export，保持既有调用方 import 路径兼容。
export { STORAGE_KEYS, STORAGE_VERSION };

// 缓存 TTL 配置常量
export const CACHE_TTL = {
  GROUPS: 30 * 1000,    // 30秒
  SETTINGS: 60 * 1000,  // 60秒
} as const;

/**
 * 使标签组缓存失效，下次 getGroups() 会从 chrome.storage 重新读取。
 * 在后台保存/收集标签页后，由标签管理器页面在刷新前调用，避免读到旧缓存。
 */
export function invalidateGroupsCache(): void {
  cacheManager.getCache('storage').delete('groups');
}

/**
 * 使设置缓存失效，下次 getSettings() 会从存储重新读取。
 *
 * 【为什么需要它】设置读路径带 60s 进程内缓存，而**写方可能在另一个执行上下文**：
 * 覆盖下载会在 SW 里把云端设置合并进存储（syncEngine.mergeCloudSettingsIntoLocal），
 * popup / options 各自的缓存副本不会因此失效。留在缓存里的旧值有两个后果：
 *   ① 界面继续显示旧主题 / 旧布局，用户以为覆盖下载没生效；
 *   ② 更贵的一条：popup 的 saveSettings 是**整份 state 盲写**，用户接下来随便改
 *      一项设置，就会把这份旧设置整份写回存储（并随自动上传推到云端），
 *      刚刚从云端落下来的那批值被静默回滚。
 * 因此覆盖下载成功后，本上下文必须「先失效、再重读」。
 */
export function invalidateSettingsCache(): void {
  cacheManager.getCache('storage').delete('settings');
}

// S2 收敛：STORAGE_KEYS / STORAGE_VERSION 已下沉至 @/storage-kv/keys（见文件顶部 import + re-export）。
// 门面双路径语义（防抖 setGroups / 直写 setGroupsImmediate）保持原地不动，行为零变化。

/**
 * 订阅 groups 变化（规格 §3.1 步骤3）：跨进程可靠对账，替代 REFRESH_TAB_LIST 手动广播。
 * 回调前自动失效本进程 groups 缓存。
 *
 * 【2026-09-30 修 P0：事件源从「存储后端事件」换成「写入口」】
 * 原来这里监听 chrome.storage.onChanged 的 tab_groups 键。但组数据早已迁到
 * IndexedDB（见 @/storage-kv/storageAdapter），生产写路径一个字节都不写
 * chrome.storage.local —— 该事件永不触发，于是 SW 在后台保存 / 导入 / 云端
 * 合并之后，已打开的管理页列表永不刷新。
 *
 * 现在订阅 @/storage-kv/groupsChangedBus：由 groups 的两个写入口
 * （debouncedPersistGroups / setGroupsImmediate）落盘后主动发事件，覆盖
 * 同进程订阅与跨上下文（chrome.runtime 消息）两种情形，所有写路径
 * （mutation / TabManager / 导入 / 三处迁移 / syncEngine 合并）都经过它们。
 *
 * 刻意**不再**监听 chrome.storage.onChanged：groups 已不在那里，除了
 * service-worker 的 migrateStorageKeys 残留写入（会伪造一次全量刷新）之外
 * 没有任何真实写方，纯属误导性的死监听。
 */
export function onGroupsChanged(cb: (originId?: string) => void): () => void {
  return subscribeGroupsChanged((originId) => {
    // 缓存失效与「要不要重载」是两件事：无论是不是自己写出的回声，本进程
    // 30s 缓存都必须失效（否则紧接着直接读存储的路径——上传/下载预览等——
    // 会读到旧值）。是否重载由订阅方按 originId 自行判断。
    invalidateGroupsCache();
    cb(originId);
  });
}

// 有效的主题风格值 —— 直接引用权威常量（2026-10-09 架构 P2-3）。
// 原先这里手抄一份数组、types/tab.ts 又手抄一份联合类型，两份之间没有编译期
// 关联：给类型加成员而忘了这里 ⇒ 合法主题被判无效、静默回落 legacy。
// 现在 THEME_STYLES 是唯一真相源（types/tab.ts 里 ThemeStyle 由它派生）。
const VALID_THEME_STYLES: readonly ThemeStyle[] = THEME_STYLES;

/**
 * 主题收敛迁移映射（2026-09-28：8 → 4）。
 * 被砍主题的存量设置按气质最近归宿迁移，而非一律回落 legacy：
 * classic（蓝系生产力）→ legacy；mint（冷调清新）→ apple（同为冷调系统感）；
 * pink（粉调柔和）→ creamy（同为暖调柔和）；cyberpunk（个性暗色）→ prism（个性渐变）。
 * 2026-10-02 二次收敛（7 → 6）：aurora（极光渐变/毛玻璃）→ prism（同为渐变玻璃系）。
 * 升级 supabase-js 等场景无关；下一次用户设置落盘时自动持久化为新值。
 */
const RETIRED_THEME_STYLES: Record<string, ThemeStyle> = {
  classic: 'legacy',
  mint: 'apple',
  aurora: 'prism',
  pink: 'creamy',
  cyberpunk: 'prism',
};

// 有效的主题模式值
const VALID_THEME_MODES: Array<'light' | 'dark' | 'auto'> = ['light', 'dark', 'auto'];

/**
 * 验证主题风格值
 * @param value 待验证的值
 * @returns 有效的主题风格值：保留值原样；被砍主题映射到保留主题；未知值回落 'legacy'
 */
export function validateThemeStyle(value: unknown): ThemeStyle {
  if (typeof value === 'string' && VALID_THEME_STYLES.includes(value as ThemeStyle)) {
    return value as ThemeStyle;
  }
  if (typeof value === 'string' && value in RETIRED_THEME_STYLES) {
    const migrated = RETIRED_THEME_STYLES[value];
    logWarn(`主题「${value}」已下线，迁移到「${migrated}」`);
    return migrated;
  }
  logWarn('无效的主题风格值，使用默认值:', value);
  return 'legacy';
}

/**
 * 验证主题模式值
 * @param value 待验证的值
 * @returns 有效的主题模式值，无效时返回默认值 'auto'
 */
export function validateThemeMode(value: unknown): 'light' | 'dark' | 'auto' {
  if (typeof value === 'string' && VALID_THEME_MODES.includes(value as 'light' | 'dark' | 'auto')) {
    return value as 'light' | 'dark' | 'auto';
  }
  logWarn('无效的明暗模式值，使用默认值:', value);
  return 'auto';
}

/**
 * 布局模式的校验单点（2026-10-18）。
 *
 * 与 `validateThemeMode` / `validateSyncIntervalMinutes` 同一纪律：**非法值 fail-safe
 * 回落，不抛错**（抛错会让 `getSettings` 整条失败，阻塞所有读设置的路径）。
 *
 * 【为什么它值得补】`layoutMode` 是唯一**被当作开关语义**使用却没校验的枚举字段：
 * 顶栏那个按钮读它来决定「点了会变成什么」（`Header.handleToggleLayout` 的 switch，
 * 以及图标的 aria-label / title），列表则只认 `'double'`（`TabList`）。
 * 值一旦落在 `'single' | 'double'` 之外（老版本写下的 `'triple'`、手改过的存储、
 * 另一台设备同步过来的旧行、导入的旧备份），后果是一组自相矛盾的表现：
 * 列表按单栏渲染、顶栏却显示「切换为单栏布局」（等于说现在是双栏），
 * 而点一下按钮走 switch 的 default 分支又落回 `'single'` —— 列表毫无变化。
 * 用户看到的是「布局开关第一下没反应，得再点一次」。
 *
 * 回落方向取 `'single'`（= DEFAULT_SETTINGS.layoutMode）：与其它校验一致，
 * 回落值必须对「存储里已有脏值」的用户最安全 —— 单栏是列表的默认呈现，
 * 不会因为一次校验就把用户的布局放大成双栏。
 */
export const VALID_LAYOUT_MODES = ['single', 'double'] as const;

export function validateLayoutMode(value: unknown): LayoutMode {
  if (typeof value === 'string' && (VALID_LAYOUT_MODES as readonly string[]).includes(value)) {
    return value as LayoutMode;
  }
  logWarn('无效的布局模式，使用默认值:', value);
  return 'single';
}

/**
 * 自动同步间隔档位（分钟）。2026-10-11（1.23.0）：用户在菜单中四选一。
 *
 * 【为什么收敛到固定四档而不是任意数字】alarm 的 periodInMinutes 是 Chrome
 * 侧的调度承诺：任意数字（如 7）会让「用户选了什么」与「实际跑什么」之间
 * 多一层解释成本，且排障时无法一眼判断间隔是否合法。 illegal 值一律回落
 * 默认档（fail-safe，不抛错 —— 见 UserSettings.syncIntervalMinutes 注释）。
 */
export const SYNC_INTERVAL_CHOICES = [5, 10, 30, 60] as const;

/** 开启自动同步时的默认档位（四档居中偏低：比 60s 省 10 倍，跨端延迟仍可接受）。 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 10;

export function validateSyncIntervalMinutes(value: unknown): number {
  if (typeof value === 'number' && (SYNC_INTERVAL_CHOICES as readonly number[]).includes(value)) {
    return value;
  }
  logWarn('无效的自动同步间隔，使用默认值:', value);
  return DEFAULT_SYNC_INTERVAL_MINUTES;
}

/**
 * 同步后端标识的校验单点（2026-10-13，WebDAV 自带存储改造）。
 *
 * 与 `validateSyncIntervalMinutes` 同一纪律：**非法值 fail-safe 回落，不抛错**。
 * 抛错会让 `getSettings` 整条失败，进而阻塞所有读设置的路径
 * （主题、布局、通知……全部读不出来），代价与收益完全不成比例。
 *
 * ── 回落方向为什么是 `supabase` 而不是 `webdav` ────────────────────────
 * 存量用户的存储里**没有**这个键（它是新增字段），合并 `{...DEFAULT_SETTINGS, ...stored}`
 * 之后落到默认值。若默认是 `webdav`，则所有升级用户会在**没配过任何 WebDAV**
 * 的情况下被切到新后端 ⇒ 打开扩展就报「请先配置云盘」，而他们本来在用的
 * Supabase 同步被无声停掉。这是「升级即失能」。
 * 默认 `supabase` ⇒ 老用户零行为变化，只有主动去设置里切换的人才走 WebDAV。
 *
 * 反过来「新增用户默认 WebDAV」这个诉求由别处满足（首次安装引导），
 * 不该由「存量数据的回落值」承担——回落值必须对存量用户最安全。
 */
export const VALID_SYNC_BACKENDS = ['supabase', 'webdav'] as const;

export function validateSyncBackend(value: unknown): 'supabase' | 'webdav' {
  if (typeof value === 'string' && (VALID_SYNC_BACKENDS as readonly string[]).includes(value)) {
    return value as 'supabase' | 'webdav';
  }
  logWarn('无效的同步后端标识，使用默认值:', value);
  return 'supabase';
}

// 默认设置
export const DEFAULT_SETTINGS: UserSettings = {
  // ── 2026-10-20 审计 A-9：showFavicons / showTabCount 从「死设置」变成
  // **真被读**的开关（设置页有入口，UI 真按它渲染）。见 types/tab.ts 的注释。
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
  // ── 2026-10-11（1.23.0）：自动同步默认关闭 ──────────────────────────
  // 自动同步每轮都是出站流量（Supabase egress 配额），而 60s 全量轮询是配额
  // 见底的主因。默认关闭后：后台 alarm 不注册、打开 popup 不再自动拉取，
  // 用户点「同步」按钮手动获取；本地改动的上传保持事件驱动（只在真有改动时
  // 才传，F2 增量后极小），不受本开关影响 —— 关掉上传省不下什么，反而会把
  // 编辑困在本机且无声（失败要出声：困住必须有信号，而上传路径没有）。
  //
  // 【存量用户受影响吗？——要分开说，2026-10-20 升级路径审计 U-2 更正】
  // getSettings 是 {...DEFAULT_SETTINGS, ...stored}：
  //   · **已存过该键的用户**：stored 里自带 syncEnabled:true（1.22.12 时代
  //     打开过管理页 / 存过会话 / 登录过的用户都会在磁盘上留下一份整份落盘的
  //     设置，其中 syncEnabled 是 1.22.12 的默认值 true）⇒ 合并后仍是 true，
  //     **不受影响**。
  //   · **该键从不存在的老用户**：落到这里的 false。
  //     ⚠️ 这一格**不等于「只有新用户」** —— 装了 1.22.12 但**从未打开过
  //     管理页、从未保存过会话、也没登录**的纯旁观用户，磁盘上根本没有设置
  //     这一份 blob，升级后自动同步**静默从「开」变「关」**（1.22.12 的后台
  //     alarm 是无条件注册的）。
  //     受影响面很窄（绝大多数真实用户都打开过页面或存过东西），但它是**真的**
  //     存在，不能像旧注释那样断言「不会发生」。
  // 绝不在此做「把存量 true 强制改 false」的迁移 —— 那是静默改用户设置，
  // 正是 1.22.16「设置被静默重置」修掉的那类 bug。
  //
  // 「默认关闭」本身是 1.23.0 的产品决策（数据默认自动同步关闭），不是缺陷；
  // 缺陷在于**旧注释把一个不成立的不变量写成了断言**，会误导后来的改动。
  syncEnabled: false, // 默认关闭自动同步（用户在菜单中开启）
  syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES, // 默认 10 分钟档
  // 默认走 Supabase：存量用户零行为变化（见 validateSyncBackend 的完整论证）。
  // 新用户想用 WebDAV 由首次安装引导 / 设置页显式切换，而不是靠这个默认值。
  syncBackend: 'supabase',
  layoutMode: 'single' as LayoutMode, // 默认使用单栏布局
  showNotifications: false, // 默认关闭通知
  themeMode: 'auto', // 默认使用自动模式（跟随系统）
  themeStyle: 'legacy', // 默认使用原始主题
  // 默认不收集固定标签页（更保守）
  collectPinnedTabs: false,
};

/**
 * 云端列（snake_case）→ 我们**确实知道**的默认值。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * `user_settings` 里有几列可能是 **NOT NULL 且没有默认值**。那样 Postgres
 * 在 upsert 的 INSERT 阶段就抛 `23502` ⇒ **整条设置同步直接断**。
 * 降级路径要靠这张表把撞规的那一列补上一个**类型正确**的值再重试。
 *
 * ── 为什么是「活列 + 退役列」合在一起，而不是只列退役列 ──────────────────
 * A-9 之前上传侧只认一份**硬编码的五个退役列名单**，于是：
 * ① 任何别的 NOT NULL 无默认列撞上 23502 时降级**不命中** ⇒ 错误原样抛出
 *    ⇒ 整条同步断掉；
 * ② 判定方式是「错误文本里包含某个列名」⇒ 可能补错列。
 *
 * 现在这张表覆盖**所有我们知道的列**：活列取当前 `DEFAULT_SETTINGS` 的值
 * （那是产品认定的默认值，类型一定对），退役列取它们的历史默认值。
 * 我们**不知道**默认值的列不在表里 ⇒ 撞上时宁可失败，也不瞎填一个
 * 类型不对的值（那等于换个姿势失败，还把库里那一行改坏了）。
 *
 * ── 为什么放在这里 ────────────────────────────────────────────────────────
 * 「某个设置的默认值是什么」是**设置模型**的性质，而 `DEFAULT_SETTINGS`
 * 就在本文件 —— 放在这里，上面那份表与这一份天然同源，
 * 不需要「记得两边一起改」。
 *
 * ⚠️ 注意 `syncEnabled` / `syncBackend` / `syncIntervalMinutes` 是**设备级**
 *   字段，不上云（见 `DEVICE_LEVEL_SETTING_KEYS`），所以不在表里 ——
 *   补它们没有意义（云端行里那几列的值以本机为准）。
 */
export const SETTINGS_COLUMN_DEFAULTS: Record<string, unknown> = {
  // ── 活列：取当前 DEFAULT_SETTINGS 的值 ────────────────────────────────
  show_favicons: DEFAULT_SETTINGS.showFavicons,
  show_tab_count: DEFAULT_SETTINGS.showTabCount,
  confirm_before_delete: DEFAULT_SETTINGS.confirmBeforeDelete,
  layout_mode: DEFAULT_SETTINGS.layoutMode,
  show_notifications: DEFAULT_SETTINGS.showNotifications,
  theme_mode: DEFAULT_SETTINGS.themeMode,
  theme_style: DEFAULT_SETTINGS.themeStyle,
  collect_pinned_tabs: DEFAULT_SETTINGS.collectPinnedTabs,
  // ── 退役列：它们的历史默认值（旧客户端曾经写上去的值）────────────────
  ...RETIRED_SETTING_COLUMN_DEFAULTS,
};

// 兼容历史字段
type LegacySettings = Partial<UserSettings> & {
  useDoubleColumnLayout?: boolean;
};

/**
 * 「增量白名单登记」这个事实的**完整状态**（2026-10-20 D-10）。
 *
 * 为什么要从布尔升级成结构：布尔版（D-3）把「最近一次登记失败了吗」与
 * 「漏登记的那批改动补齐了吗」压成同一个位 ⇒ 复位它只能等「对账通过」
 * ⇒ 自锁（见 core/uploadCoverage 的 decideRegistryAfterUpload 注释）。
 *
 * 三个字段各自的判据：
 *   · unreliable —— 最近一次写方登记**失败**了 ⇒ 「登记机制此刻不可信」。
 *     复位 = 下一次登记成功（写方事实，与上传对账无关）。
 *   · gapOpen —— 漏登记的那批改动**还没被一次全量提交覆盖**。
 *     复位 = 本轮提交的是全量（那批改动就在这份全量里）。
 *   · gen —— 置位次数。**并发保护**：上传轮次开始时读一次，轮次结束时
 *     只有在 gen 没变时才允许复位 ⇒ 轮次进行中又失败一次时不会被抹掉。
 */
export interface PendingUploadRegistryState {
  unreliable: boolean;
  gapOpen: boolean;
  gen: number;
}

// 导出数据的格式
interface ExportData {
  version: string;
  timestamp: string;
  data: {
    groups: TabGroup[];
    /**
     * 设置快照。
     *
     * 【为什么是 Partial 而不是 UserSettings】（2026-10-20 审计 A-21）
     * 导出侧会剔掉「不跨设备」的三个键（syncBackend / syncEnabled /
     * syncIntervalMinutes）与已退役键 ⇒ 文件里的设置**本来就不是全字段**。
     * 类型写成 `UserSettings` 等于**在类型层面承诺一个假的完整性** ——
     * 而这正是缺陷能长期存在的原因：类型说「全都在」，代码却少给三个。
     *
     * 导入侧对外部文件也只认部分字段（外来文件形状不可信），
     * 两边对上。
     */
    settings: Partial<UserSettings>;
  };
}

/**
 * 导入的真实结果（2026-10-09 UX P1-6）。
 *
 * UI 必须用这三个数字把结果说清楚，而不是只回一个「成功」：
 *   · source   文件里有几个组
 *   · imported 实际落盘了几个（applyImportGroups 会丢掉全空/全无效 URL 的组）
 *   · pending  true = 超时但命令已受理、正在后台执行（此时 imported 无意义）
 *
 * 「导入了 3 个、跳过 7 个」和「导入了 10 个」对用户是两回事 —— 前者意味着
 * 有 7 个得回文件里自己对，静默跳过等于让他以为全都在。
 *
 * `reason`（可选，2026-10-10 P2-3）：失败时给面向用户的原因，与 OneTab 的
 * importFromOneTabFormat 同口径 —— 否则 JSON 导入失败只能弹一句静态的
 * 「数据导入失败」，用户完全不知道是文件格式不对、组全不可存储、还是
 * 存盘那一层出错（同一句文案覆盖三种完全不同的原因 = 没法排查）。
 */
export interface ImportDetailedResult {
  ok: boolean;
  imported: number;
  source: number;
  pending: boolean;
  /** 仅失败时存在：面向用户的原因说明（不直接展示内部堆栈/错误类名）。 */
  reason?: string;
  /**
   * 「已存在而跳过」的会话数（2026-10-19 审计 F-5）。
   *
   * 与「为空会话 / 只含不可保存网址」是**两种完全不同的跳过**：
   * 前者是幂等（正常，用户重复导入同一份备份），后者说明文件内容有问题。
   * UI 必须分开说，否则用户重复导入一次就以为自己的备份坏了。
   */
  skippedExisting?: number;
}

class ChromeStorage {
  private async ensureVersion() {
    const version = await kvGet<number>(STORAGE_KEYS.VERSION);
    if (version === STORAGE_VERSION) return;
    await kvSet(STORAGE_KEYS.VERSION, STORAGE_VERSION);
  }

  /**
   * 读取全部标签组（30s 内存缓存）。
   *
   * fail-closed：读失败**抛错**，不返回 []。所有写路径都是本方法的读-改-写
   * （mutationService / TabManager / import），返回 [] 等于「现有列表为空」，
   * 下一次写入会把整组用户会话截断成单个元素并回报成功。抛错则写路径整条失败，
   * 用户数据保持原样。
   */
  async getGroups(): Promise<TabGroup[]> {
    return cachedAsyncFn('storage', 'groups', async () => {
      await this.ensureVersion();
      const groups = await kvGet<unknown>(STORAGE_KEYS.GROUPS);
      // ── 2026-10-09 P1-10：读失败不得与「键不存在」同形 ────────────────
      //
      // 原实现是一行三元 `Array.isArray(groups) ? … : []`，与上方注释承诺的
      // 「fail-closed：读失败抛错，不返回 []」**直接冲突**（注释与实现不一致）。
      // 后果有两层：
      //   ① UI 层：形状损坏被归一成空数组 ⇒ loadGroups 走 fulfilled、不置 error
      //      ⇒ 界面显示「先保存一个工作会话」，与**真的首次使用完全同形**。
      //      用户看不出「数据还在但读出来是坏的」，只会以为自己的会话没了。
      //   ② 写路径：所有读-改-写拿这个 `[]` 当真值 ⇒ 下一次写入把整组用户会话
      //      截断成单个元素并回报成功 —— 这正是上方注释想防的那个 P0。
      //
      // 现在分成三种语义，不再共用一个 `[]`：
      //   · 读不到键（undefined/null）= 首次使用，真的没有数据 → 返回 []
      //   · 键在但形状不对 = 数据损坏 → 抛错（fail-closed）
      //   · kvGet 本身抛错 = 读失败 → 原样向上抛（既有行为，未改）
      if (groups === undefined || groups === null) {
        return [];
      }
      if (!Array.isArray(groups)) {
        // 不把原始内容拼进错误消息：错误会进 Redux state 并可能被上层日志携带，
        // 而它可能含用户数据。只报类型，够定位、不泄露。
        throw new Error(
          `本地会话数据形状异常：tab_groups 期望数组，实得 ${typeof groups}，` +
            '已中止本次读取（不按空列表处理，避免数据被误认为不存在）'
        );
      }
      return groups as TabGroup[];
    }, CACHE_TTL.GROUPS);
  }

  /**
   * 防抖批量写入 groups（可 await）
   * - 窗口期内多次 setGroups 会合并为一次落盘（使用最后一次 groups）
   * - 但每次调用都可以 await，保证返回时已真正写入
   */
  private debouncedPersistGroups = debounceAsync(async (groups: TabGroup[]) => {
    await this.ensureVersion();
    await kvSet(STORAGE_KEYS.GROUPS, groups);

    // 落盘后刷新缓存 TTL（即便之前已 optimistic 更新）
    const cache = cacheManager.getCache('storage');
    cache.set('groups', groups, CACHE_TTL.GROUPS);

    // 事件源：groups 落盘即广播（订阅方收到后失效自己的 30s 缓存并重新加载）。
    // 放在 cache.set 之后：订阅方本进程失效缓存时，缓存里已经是本次的新值，
    // 不会退化成「失效后读到空」。
    notifyGroupsChanged();
  }, 500);

  async setGroups(groups: TabGroup[]): Promise<void> {
    const cache = cacheManager.getCache('storage');
    
    try {
      // optimistic：立刻更新缓存，保证后续读取一致
      // 注意：在防抖窗口期内，缓存会被多次更新，但最终只有最后一次会持久化
      cache.set('groups', groups, CACHE_TTL.GROUPS);

      // 强一致：等待最终一次落盘完成
      await this.debouncedPersistGroups(groups);
    } catch (error) {
      logError('保存标签组失败:', error);
      // 清除可能不一致的缓存
      cache.delete('groups');
      throw error;
    }
  }

  /**
   * P1-4：SW 侧统一的 groups 写路径（绕过 500ms 防抖，直写 kv）。
   *
   * 为什么需要：MV3 Service Worker 可随时被杀——setGroups 的防抖窗口期内
   * 若 SW 被挂起，合并结果/快照回滚可能根本没落盘，下次唤醒读到旧数据
   * （合并过的数据“丢了”，云端却以为已同步）。
   *
   * 先排空防抖再直写：同一进程内若还有未决的防抖写入（旧快照），必须先让它
   * 落盘，再用本次更新的数据覆盖；否则定时器稍后触发会用旧数据覆盖新数据。
   *
   * 写路径分工：SW 内所有写者（mutation、TabManager 保存、导入、迁移）都走
   * 本函数；只有 UI 进程的用户操作热路径走防抖 setGroups（高频连写合并）。
   */
  async setGroupsImmediate(groups: TabGroup[], originId?: string): Promise<void> {
    const cache = cacheManager.getCache('storage');
    try {
      await this.debouncedPersistGroups.flush();
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.GROUPS, groups);
      cache.set('groups', groups, CACHE_TTL.GROUPS);
      // 事件源：同 debouncedPersistGroups（见那里的注释）。
      // 这条是 SW 侧所有写路径（mutation / TabManager / 导入 / syncEngine 合并）
      // 真正落盘的地方 —— 云端合并后管理页不刷新，根因就是这里以前不发任何事件。
      // originId：MUTATE 命令的发起方身份。发起方据此忽略自己的写入回声，
      // 其它上下文（另一个窗口 / SW 自身写入）照常收到通知。
      notifyGroupsChanged(originId);
    } catch (error) {
      logError('直接保存标签组失败:', error);
      cache.delete('groups');
      throw error;
    }
  }

  /**
   * P1-4：同步关键路径专用新鲜读（先失效 30s 缓存再读）。
   * 同一进程内 mutation 刚写完就触发下载时，缓存可能是防抖窗口期的旧快照。
   */
  async getGroupsFresh(): Promise<TabGroup[]>
  {
    invalidateGroupsCache();
    return this.getGroups();
  }

  /**
   * 写路径专用读：先落盘 pending 的防抖写、失效 30s 缓存，再读真值。
   *
   * 【为什么读-改-写必须用它，而不是 getGroups()】
   * getGroups() 有 30s 进程内缓存，拿它做读-改-写的快照，可能比实际磁盘状态旧。
   * 防抖窗口期内由本进程写入的 pending 值也可能还没落盘 —— 先 flush 才能读到
   * 「含 pending 写的真值」，否则紧接着的写会把 pending 覆盖掉。
   *
   * 【2026-10-09 修订：popup 已不再自行写 groups】本注释原先写的是
   * 「popup 的 runMigrations（migrateFaviconUrls）会在 TabList 挂载时调
   * setGroups()，SW 侧没有 onGroupsChanged，感知不到这次写入」—— 那是**修复前**
   * 的世界。P0 修复后 TabList 改发 RUN_MIGRATIONS 消息，三件迁移全部搬进
   * SW 的单写者队列执行（见 service-worker 的 RUN_MIGRATIONS 分支），
   * popup realm 不再直接整表写 GROUPS key。
   *
   * **但 getGroupsForWrite() 仍然不可替代**：它解决的是「本 realm 缓存陈旧 +
   * pending 未落盘」，与跨 realm 队列互斥是**两件不同的事**，两者都需要 ——
   * 进队列解决并发，fresh read 解决自己的陈旧。不要因为「已入队」就改回
   * getGroups()：入队保证的是没有并发写，保证不了自己读到的是最新快照。
   *
   * 后果不是"读到旧数据"这么轻——所有 mutation 都是「读-改-写」：拿陈旧快照
   * 改完再写回，期间由别的上下文写入的数据被整段抹掉，且回报成功
   * （这与 v1.21.2 的墓碑灌入、fail-closed 注释描述的是同一类"读失败变成写"）。
   * 触发窗口窄（升级后首次打开 popup 的那一瞬），但后果是全部会话丢失，
   * 且恰好发生在用户升级、最不该丢数据的时刻。
   *
   * 先 flush 再失效：保证同进程内尚未落盘的防抖写不会因这次新鲜读而被跳过
   * （读到的必须是"含 pending 写"的真值，否则紧接着的写会把 pending 覆盖掉）。
   * 读-改-写的入口统一走这里：mutationService 的全部 mutation、TabManager 两处
   * 保存路径、三处迁移（migrateFaviconUrls / purgeTombstones / migrateToV2），
   * 以及无 SW 语境下的导入兜底（mergeImportedGroups）。
   */
  async getGroupsForWrite(): Promise<TabGroup[]> {
    await this.debouncedPersistGroups.flush();
    invalidateGroupsCache();
    return this.getGroups();
  }

  /**
   * 读取用户设置（60s 内存缓存）。
   *
   * fail-closed：读失败**抛错**，不返回 DEFAULT_SETTINGS。
   *
   * 【为什么这里降级的代价和 getGroups 一样致命，方向却相反】
   * getGroups 降级成 [] 会把「列表为空」当成真值写回；本方法的降级值是一个
   * **看起来完全合法的设置对象**，调用方无法区分「读到了默认值」与「用户就是
   * 默认值」。而 getSettings 的调用方里有一条直通云端写的路径：
   * syncEngine.upload 末尾 `uploadSettings(await storage.getSettings())`，
   * uploadSettings 是**无条件 upsert**（无 stamp / 无 version / 无 LWW，
   * 见 @/utils/supabase/upload.ts）——一次偶发 IndexedDB 读错误就能把用户
   * 真实的云端设置整行覆盖成默认值，其他设备下次下载再复制一遍。
   *
   * 抛错后该上传路径已有的 try/catch 只记一行日志、不发请求；本地设置原样保留，
   * 下一轮重试读成功再上传。与 getGroups 一致：读失败只能停在读，不得变成写。
   */
  async getSettings(): Promise<UserSettings> {
    try {
      return await cachedAsyncFn('storage', 'settings', async () => {
        await this.ensureVersion();
        const rawSettings = (await kvGet<LegacySettings | unknown>(STORAGE_KEYS.SETTINGS)) || {};
        const normalizedSettings =
          rawSettings && typeof rawSettings === 'object' ? (rawSettings as LegacySettings) : {};

        // 向后兼容性处理：将旧的useDoubleColumnLayout转换为新的layoutMode
        if (
          'useDoubleColumnLayout' in normalizedSettings &&
          normalizedSettings.useDoubleColumnLayout !== undefined &&
          normalizedSettings.layoutMode === undefined
        ) {
          normalizedSettings.layoutMode = normalizedSettings.useDoubleColumnLayout ? 'double' : 'single';
          delete normalizedSettings.useDoubleColumnLayout;
          await this.setSettings({ ...DEFAULT_SETTINGS, ...normalizedSettings });
        }

        // 验证并修正主题相关设置
        const validatedThemeStyle = validateThemeStyle(normalizedSettings.themeStyle);
        const validatedThemeMode = validateThemeMode(normalizedSettings.themeMode);
        // 2026-10-11（1.23.0）：自动同步间隔只认四档，非法值回落默认档。
        // 与主题校验同纪律：fail-safe 回落，不抛错（抛错会让整条 getSettings
        // 失败，进而阻塞所有读设置的路径 —— 间隔值不值得这个代价）。
        const validatedSyncInterval = validateSyncIntervalMinutes(
          normalizedSettings.syncIntervalMinutes
        );
        // 2026-10-18：布局模式同样只认枚举内的值。它是唯一被当作「开关语义」用
        // 却没校验的字段 —— 脏值会让顶栏文案与列表呈现互相矛盾，且点一次按钮
        // 落回 default 分支后列表毫无变化（详见 validateLayoutMode 的注释）。
        const validatedLayoutMode = validateLayoutMode(normalizedSettings.layoutMode);

        // ── 2026-10-20 审计 A-9：退役的设置键从本地存储里**物理清掉** ──────
        // 这五个键曾经是「有设置、无入口、无读取方」（见 types/tab.ts 的逐条结论）。
        // 只从类型里删掉是不够的：存量用户的存储里还留着它们，
        // 而 getSettings 是 {...DEFAULT_SETTINGS, ...stored} —— 不清就会让
        // 已退役的键继续出现在设置对象里，一路被带上云（数据模型在骗人）。
        // 这里在读路径上就地删除并触发一次回写（needsUpdate），让本地数据自愈。
        const mutableSettings = normalizedSettings as Record<string, unknown>;
        const retiredKeysPresent = RETIRED_SETTING_KEYS.filter(key => key in mutableSettings);
        for (const key of retiredKeysPresent) {
          delete mutableSettings[key];
        }

        // 如果验证后的值与原值不同，说明存储中有无效值，需要更新
        const needsUpdate =
          normalizedSettings.themeStyle !== validatedThemeStyle ||
          normalizedSettings.themeMode !== validatedThemeMode ||
          normalizedSettings.syncIntervalMinutes !== validatedSyncInterval ||
          normalizedSettings.layoutMode !== validatedLayoutMode ||
          retiredKeysPresent.length > 0;

        const mergedSettings: UserSettings = {
          ...DEFAULT_SETTINGS,
          ...normalizedSettings,
          themeStyle: validatedThemeStyle,
          themeMode: validatedThemeMode,
          syncIntervalMinutes: validatedSyncInterval,
          layoutMode: validatedLayoutMode,
        };

        // 如果有无效值被修正，保存修正后的设置
        if (needsUpdate) {
          await this.setSettings(mergedSettings);
        }

        return mergedSettings;
      }, CACHE_TTL.SETTINGS);
    } catch (error) {
      // 不降级、不返回 DEFAULT_SETTINGS（见方法注释）：降级值会被上传路径当真值写上云端。
      logError('获取设置失败（抛错，不降级为默认值）:', error);
      throw error;
    }
  }

  /**
   * 只读本地设置、允许降级为 DEFAULT_SETTINGS。
   *
   * 为什么需要它：getSettings 的 fail-closed 是**为上云服务的**——uploadSettings 是
   * 无 stamp / 无 version / 无 LWW 的无条件 upsert，一旦把降级值当真值推上去，就会
   * 覆盖掉用户真实的云端设置。但同一个 getter 如果被纯本地路径调用（保存标签页时
   * 读 collectPinnedTabs），一次瞬时 IndexedDB 读错误就会让「保存全部标签 / 保存当前
   * 标签」整条中止——为一个只影响云端的隐患，赔上了本地保存功能，不成比例。
   *
   * 因此按「结果会不会被上传」分流：会 → getSettings（抛错）；不会 → 本方法（降级）。
   * 降级值只用于本地行为判断，永远不参与任何上传。
   */
  async getSettingsForLocalUse(): Promise<UserSettings> {
    try {
      return await this.getSettings();
    } catch (error) {
      logWarn('本地读取设置失败，降级为默认值（该降级值不参与任何上传）:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * 需要真值的设置读：先落盘 pending 的防抖写、失效 60s 缓存，再读。
   *
   * 【为什么 getSettings() 不够（不是"读到旧数据"这么轻）】
   * 设置写方在**另一个执行上下文**（设置页 / popup），写完后不会让本进程的
   * 缓存失效；SW 又是长活上下文，缓存能活满 60s。而 SW 这条读路径的下一站是
   * **云端**：`uploadSettings` 是无 stamp / 无 version / 无 LWW 的**无条件 upsert**
   * （见 @/utils/supabase/upload），一次陈旧读就把用户云端设置整行覆盖成旧值，
   * 其他设备下次下载再复制一遍。
   *
   * 2026-10-18 实测：在设置页切成「自带存储（WebDAV）」后点「检查并推送到云端」，
   * 云端 settings.json 里 syncBackend 仍是 supabase；随后覆盖下载把本机也改回
   * supabase ⇒ WebDAV 用户的同步静默失效，顶栏按钮还反过来提示「请先登录」。
   *
   * 同一根因的先例：@/sync-backend 的 readConfiguredBackendId —— 那里 2026-10-14
   * 就把「用户现在选了什么」当设置事实直读存储，不走缓存。
   *
   * 【先 flush 再失效，顺序不能反】失效之后读的是**磁盘**值：本进程防抖窗口内
   * 刚写的设置若还没落盘，就会被读成旧值并推上云端。与 getGroupsForWrite 同一纪律。
   *
   * 用途：读-改-写（mergeCloudSettingsIntoLocal）与上云两条路径。纯本地行为判断
   * 仍用 getSettingsForLocalUse()（它允许降级，且降级值不参与上传）。
   */
  async getSettingsForWrite(): Promise<UserSettings> {
    await this.debouncedPersistSettings.flush();
    invalidateSettingsCache();
    return this.getSettings();
  }

  /**
   * 防抖批量写入 settings（可 await）
   * - 窗口期内多次 setSettings 会合并为一次落盘（使用最后一次 settings）
   * - 每次调用都可以 await，保证返回时已真正写入
   */
  private debouncedPersistSettings = debounceAsync(async (settings: UserSettings) => {
    await this.ensureVersion();

    // 验证主题相关设置，确保保存的值是有效的
    const validatedSettings: UserSettings = {
      ...settings,
      themeStyle: validateThemeStyle(settings.themeStyle),
      themeMode: validateThemeMode(settings.themeMode),
      // 这里是真正落盘的那一步，与 setSettings 保持同一份字段清单
      // （2026-10-18 补 layoutMode：两个外部来源带进来的值没有别处兜底）
      layoutMode: validateLayoutMode(settings.layoutMode),
    };

    await kvSet(STORAGE_KEYS.SETTINGS, validatedSettings);

    // 落盘后刷新缓存 TTL（即便之前已 optimistic 更新）
    const cache = cacheManager.getCache('storage');
    cache.set('settings', validatedSettings, CACHE_TTL.SETTINGS);
  }, 500);

  async setSettings(settings: UserSettings): Promise<void> {
    // ── 2026-10-20 审计 A-9：退役键在**写路径**上一律剔除 ──────────────
    // setSettings 是所有设置写入的唯一漏斗：本地开关、导入备份、云端合并
    // （syncEngine.mergeCloudSettingsIntoLocal）、下载后的回写，全都经过这里。
    // 在这里剔除一次，就不必去改每一条来源路径 —— 也不必动 sync engine
    // （合并语义不在本轮范围内）。
    //
    // 为什么必须剔：WebDAV 的设置文件是**整份对象**透传，Supabase 的云端行
    // 也可能还留着旧客户端写下的退役列。若不剔，退役键会被「合并」回本地，
    // 又变成「有设置、无入口、无读取方」的死设置 —— 删了等于没删。
    const mutableIncoming = settings as unknown as Record<string, unknown>;
    for (const key of RETIRED_SETTING_KEYS) delete mutableIncoming[key];

    const validatedSettings: UserSettings = {
      ...settings,
      themeStyle: validateThemeStyle(settings.themeStyle),
      themeMode: validateThemeMode(settings.themeMode),
      // 2026-10-18：写路径同样收敛布局模式。两个外部来源会带着任意值进来
      // ——导入的备份文件与云端行的合并（见 importDetailed / syncEngine 的
      // mergeCloudSettingsIntoLocal），它们都没有字段级校验。
      layoutMode: validateLayoutMode(settings.layoutMode),
    };

    const cache = cacheManager.getCache('storage');

    try {
      // optimistic：立刻更新缓存，保证后续读取一致
      // 注意：在防抖窗口期内，缓存会被多次更新，但最终只有最后一次会持久化
      cache.set('settings', validatedSettings, CACHE_TTL.SETTINGS);

      // 强一致：等待最终一次落盘完成
      await this.debouncedPersistSettings(validatedSettings);
    } catch (error) {
      logError('保存设置失败:', error);
      // 清除可能不一致的缓存
      cache.delete('settings');
      throw error;
    }
  }

  // 新增：获取已删除的标签组
  // ⚠️ 无墓碑重写（2026-09-29）后已无写入方；保留仅为迁移期读取旧键（迁移后删除）。
  async getDeletedGroups(): Promise<TabGroup[]> {
    try {
      await this.ensureVersion();
      const groups = await kvGet<unknown>(STORAGE_KEYS.DELETED_GROUPS);
      return Array.isArray(groups) ? (groups as TabGroup[]) : [];
    } catch (error) {
      logError('获取已删除标签组失败:', error);
      return [];
    }
  }

  // ── 删除广播队列（PENDING_PURGE_IDS / PENDING_DELETE_IDS）───────────────
  //
  // 【为什么这一组读写必须 fail-closed】
  // pendingDeleteIds 是组删除**唯一的**跨设备广播载体：无墓碑模型下本地不留
  // 任何删除痕迹，云端行的 is_deleted 标记就是载体本身。任一环节静默降级都会
  // 让删除被撤销，且没有任何痕迹：
  //   读失败降级成 []  → upload 只推幸存者，随后 clearPendingDeleteIds() 把队列
  //                      当成「已消费」清掉 → 删除意图永久丢失 → 对端下次合并
  //                      （mergeOpStamped 的 cg && !lg）把已删的组整组加回来。
  //   写失败被吞掉    → 本地组已物理删除、队列没这条 id、云端行仍是活跃行，
  //                      同样复活，而 UI/handler 全程回报成功。
  // 所以：读失败抛错（upload 整体失败、pending_upload 保留、下轮重试），
  // 写失败抛错（不再谎报成功）。补偿见 unsyncedDeleteIds。
  //
  // 【清队不是「清空」而是「确认已广播」】读-写两侧都 fail-closed 只解决一半：
  // 一轮上传期间队列还会继续长（新登记的删除），所以 clearPendingDeleteIds 必须
  // 由调用方点名本轮真的广播成功的 id，没点名的继续留着。详见该方法的注释。

  // P1-6（历史）：purge 队列读写。无墓碑模型改用 pendingDeleteIds（见下），
  // 本组方法仅为迁移读取残留队列保留，迁移完成后清除该键。
  // 读失败必须抛错：purgeTombstones 读完就把这个键删掉，读失败返回 [] 等于
  // 「队列本来就是空的」→ 迁移删键 → 队列里的删除意图当场销毁。
  async getPendingPurgeIds(): Promise<string[]> {
    await this.ensureVersion();
    const ids = await kvGet<unknown>(STORAGE_KEYS.PENDING_PURGE_IDS);
    return Array.isArray(ids) ? (ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  }

  // 无墓碑模型：删除广播队列。本地物理删除组后由 mutation 登记，
  // upload 时 markCloudGroupsAsDeleted 成功（读回确认）后才 clear；失败保留下轮重试。
  // 读失败抛错（理由同上），返回值 = 持久化队列 ∪ 内存兜底队列（后者的来源见下）。
  // 这就是「一轮上传的批次」：clear 必须原样点回这份清单（见 clearPendingDeleteIds），
  // 队列在这轮期间新增的条目一条都不能被这次清队带走。
  async getPendingDeleteIds(): Promise<string[]> {
    await this.ensureVersion();
    const ids = await kvGet<unknown>(STORAGE_KEYS.PENDING_DELETE_IDS);
    const persisted = Array.isArray(ids)
      ? (ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (unsyncedDeleteIds.size === 0) return persisted;
    return [...new Set([...persisted, ...unsyncedDeleteIds])];
  }

  /**
   * 登记一条删除广播意图。
   *
   * 写失败时**两条腿都走**：先把 id 暂存到进程内存（unsyncedDeleteIds），
   * 再把错误抛出去。内存兜底承担的职责只有一个——**让这条意图继续留在队列里**：
   * getPendingDeleteIds 把内存态并进返回值，所以同进程内的 upload 仍能读到它并
   * 广播到云端，「本地已删、云端行还没标 is_deleted」的窗口不会因为一次写失败而
   * 当场消失；抛错则保证这次删除对上层是显式失败（handler 不回报成功）。
   *
   * 兜底的边界要说清楚：SW 被回收后内存态随之消失；那种场景下 KV 根本写不进去，
   * 任何进程内手段都救不了，能做的只有让失败显形（抛错 + 日志 + 上层重试），
   * 而不是静默当成删除成功。
   *
   * 【兜底不等于「会被清掉」】内存里的意图何时消失由 clearPendingDeleteIds 决定，
   * 而它只移除**调用方点名确认广播成功**的那些 id；没被点名的意图（没读到、
   * 没广播成功、读队列之后才登记的）一律继续留着等下一轮。自己不点名的后果见
   * clearPendingDeleteIds 的注释。
   */
  async addPendingDeleteId(id: string): Promise<void> {
    return this.addPendingDeleteIds([id]);
  }

  /**
   * 批量登记删除广播意图（addPendingDeleteId 的 N 条版本）。
   *
   * 【为什么必须批量】单次清理（cleanDuplicates）/ 批量迁移会一次移除成百上千个组，
   * 逐条调用 addPendingDeleteId 的代价是 **2N 次 IndexedDB 往返**（每条都读一遍
   * 全队列、再写回全队列）+ 2N 次整队列序列化。2000 条实测约 9 秒——这就是
   * 「清理重复标签点击后卡住」的根因（计算本身只要几十毫秒，全耗在队列 I/O 上）。
   * 批量化后是 2 次往返，与条数无关。
   *
   * 语义与逐条版完全一致：读-合并-写；写失败时把**本批全部** id 推进内存兜底
   * 并抛错（不让任何一条被静默丢弃）。并发调用由 KV 写本身的串行性兜底——本文件
   * 的 addPendingDeleteId 系列都在 SW 的单写者队列内被调用。
   */
  async addPendingDeleteIds(newIds: readonly string[]): Promise<void> {
    const idsToAdd = [...new Set(newIds.filter((id): id is string => typeof id === 'string'))];
    if (idsToAdd.length === 0) return;
    try {
      const ids = await this.getPendingDeleteIds();
      const existing = new Set(ids);
      const merged = [...ids, ...idsToAdd.filter(id => !existing.has(id))];
      if (merged.length === ids.length) return; // 全部已在队列里
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.PENDING_DELETE_IDS, merged);
    } catch (error) {
      for (const id of idsToAdd) unsyncedDeleteIds.add(id);
      logError('记录 pending_delete_ids 失败（已暂存内存兜底，删除不会被静默撤销）:', error);
      throw error;
    }
  }

  /**
   * 消费删除广播队列：**只**移除本轮确认已广播成功的那些 id，其余一律保留。
   *
   * @param confirmedBroadcastIds 本轮 markCloudGroupsAsDeleted 读回确认成功的 id
   *   清单（调用方上一次 getPendingDeleteIds() 读到的队列里，实际广播成功的那部分）。
   *   省略 = 旧语义「整队清空」，仅当调用方确定刚把**整条合并队列**（KV ∪ 内存兜底）
   *   都广播成功时才成立；否则必须显式传清单。
   *
   * 【为什么不能整队清空】队列有两个来源：KV 持久化队列与 unsyncedDeleteIds 内存兜底，
   * 而一轮上传的周期里两者都在长。复现窗口：上传读走队列（内容 A）→ 用户又删了 B，
   * B 的 KV 写失败只进了内存 → 本轮 A 广播成功 → 整队清空把 B 一起抹掉。此时 B 已经
   * 本地物理删除、云端行仍是活跃行、无墓碑无回收站 → 下次合并（mergeOpStamped 的
   * cg && !lg）整组复活，用户永久找不回，且全程没有任何提示。清队必须逐条点名。
   *
   * 【为什么是读-改-写而不是直接删键】读队列之后才登记的条目（这一轮根本没广播过，
   * 哪怕它已经落进 KV）不在 confirmed 里；直接删键会把它们连坐删掉，写回剩余项才
   * 与内存兜底保持同一套「按确认消费」的语义。
   *
   * fail-closed：任何一步失败都在**动内存兜底之前**抛出。抛错时 KV 队列与内存兜底
   * 都保持原样，上层 upload 整体失败并保留 pending_upload，下轮重试——重复广播一次
   * 删除是幂等的，代价远小于丢一条删除意图。
   */
  async clearPendingDeleteIds(confirmedBroadcastIds?: readonly string[]): Promise<void> {
    await this.ensureVersion();

    if (confirmedBroadcastIds === undefined) {
      // 无参旧路径：整队清空。危险面 = 内存兜底里「本轮没广播成功」的 id 被连坐抹掉。
      // 两个生产调用方（syncEngine 的覆盖下载前广播、覆盖上传后广播）都已改为传确认
      // 清单，所以生产里**不应该**再走到这里。保留这条分支 + 这条告警，是给未来
      // 新增调用方的绊线：谁图省事不传清单，告警会立刻指出来，而不是让一条删除
      // 意图在上传竞态里悄悄蒸发。若确认今后不再有调用方，可以整条删掉。
      logWarn(
        '[storage] clearPendingDeleteIds() 未提供「本轮确认广播成功」清单，将整队清空——'
        + '内存兜底里未广播的删除意图会被一并抹掉（已删组可能在下次合并时复活）。'
      );
      await kvRemove(STORAGE_KEYS.PENDING_DELETE_IDS);
      unsyncedDeleteIds.clear();
      return;
    }

    // 只认字符串 id：非字符串条目视为「未确认」，留在队列里等下轮，不污染兜底集合。
    const confirmed = new Set(confirmedBroadcastIds.filter((id): id is string => typeof id === 'string'));

    const raw = await kvGet<unknown>(STORAGE_KEYS.PENDING_DELETE_IDS);
    const persisted = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string')
      : [];
    const remaining = [...new Set(persisted.filter((id) => !confirmed.has(id)))];

    if (remaining.length === 0) {
      await kvRemove(STORAGE_KEYS.PENDING_DELETE_IDS);
    } else {
      await kvSet(STORAGE_KEYS.PENDING_DELETE_IDS, remaining);
    }

    // KV 落定后才动内存兜底（反过来则会在清队列失败时凭空丢掉兜底里的 id）。
    for (const id of confirmed) unsyncedDeleteIds.delete(id);
  }

  // 获取最后同步时间
  async getLastSyncTime(): Promise<string | null> {
    try {
      await this.ensureVersion();
      return (await kvGet<string>(STORAGE_KEYS.LAST_SYNC_TIME)) || null;
    } catch (error) {
      logError('获取最后同步时间失败:', error);
      return null;
    }
  }

  // 设置最后同步时间
  async setLastSyncTime(time: string): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.LAST_SYNC_TIME, time);
    } catch (error) {
      logError('设置最后同步时间失败:', error);
    }
  }

  // ponytail: 持久化的"本地有未上传变更"标志。
  // scheduleUpload 置 true；upload 成功置 false；cancelPendingUpload 不动。
  //
  // ── 2026-10-05：读失败不再静默返回 false ──────────────────────────────
  // 这个标志是「后台 alarm 要不要上传」的唯一判据，而 false 的语义是
  // 「本地没有待上传的变更」——于是读失败会被读成「一切正常，不用了」，
  // 而真实状态可能是「有一堆本地变更等着上云」。结果：本地变更**静默不推送**，
  // 云端保持旧状态，下次下载再把本地覆盖回去，用户以为存了其实没存上。
  //
  // 之前这里 `catch { return false }`，与同文件 groups/settings 的
  // fail-closed 纪律正好相反。改为抛错：让调用方显式决定「读不到时怎么办」，
  // 而不是替它们编一个「没有待上传」的答案。
  async getPendingUpload(): Promise<boolean> {
    await this.ensureVersion();
    return (await kvGet<boolean>(STORAGE_KEYS.PENDING_UPLOAD)) === true;
  }

  /**
   * 置/清 pending_upload 标志（本地有未上传变更）。
   *
   * 失败即抛：这个标志是「后台 alarm 要不要上传」的唯一判据，两头都不能出错——
   *   置位失败 → 本地变更永远不推上云（云端保持旧状态，下次下载把本地覆盖回去）；
   *   清位失败 → 保守方向（多传一轮），无害。
   * 上层 scheduleUpload 仍会吞掉这个错误并只记日志（见 syncEngine），那是另一个
   * 文件的语义；本层不再假装写成功，把失败如实交出去。
   */
  async setPendingUpload(pending: boolean): Promise<void> {
    await this.ensureVersion();
    await kvSet(STORAGE_KEYS.PENDING_UPLOAD, pending);
  }

  /**
   * WebDAV 首次同步的归属决策是否仍未完成（2026-10-18 P1#4）。
   *
   * `true` 期间：自动上传（保存会话触发的 scheduleUpload、后台 alarm）
   * 不得走「远端无 manifest ⇒ 全量」那条路，否则用户在设置页的三选一
   * 还没做，历史会话就已经全被推上云了 —— 决策被替他做了。
   *
   * 缺失 = 已完成：老用户升级后不会被无端挡住同步（缺省方向必须是「放行」，
   * 因为误挡的代价是「数据传不上去」而非「多传一次」）。
   *
   * ⚠️ 2026-10-20：**待决位按「目标库」寻址**（`scope` 参数）。
   *
   * 判据是「**这些会话归这个库吗**」—— 而「这个库」会变：换云盘 = 另一个库，
   * 那里的归属是**另一个决定**。全局单值会让「换云盘」与「同库重设密码」
   * 长得一模一样（两者都是「本机配过自带存储」），于是换云盘时历史会话被
   * 静默整批推上新云盘，而用户从没被问过。
   *
   * 口径与同步水位线一致（`baseUrl | username | rootPath` 三者任一变化
   * 都意味着「另一个库」，见 `webdav/adapter.ts` 的 `watermarkKey`）。
   *
   * **旧格式的迁移**（老用户磁盘上那个全局布尔值）：语义见
   * `storage-kv/firstSyncPendingRecord.ts` —— 旧值 `true` ⇒ 落进保留槽位 ⇒
   * 任何**没有显式记录**的库都算待决（保守方向：多挡一次、少传一次；
   * 「多传」不可回滚）。**显式记录优先于它**（用户做完三选一后写入的
   * 显式 `false` 必须能压住旧的 `true`）。
   *
   * @param scope 目标库的作用域键（见 `webdav/libraryIdentity.ts`）。
   *              省略 = **自动解析为「本机当前指向的库」**（读磁盘上的
   *              已保存配置）—— 那正是「现在要往哪儿传」这个问题的答案。
   */
  async getFirstSyncPending(scope?: string): Promise<boolean> {
    try {
      // ⚠️ `ensureVersion()` 不能省：KV 层要先完成版本初始化，否则首次读
      // （尤其 SW 冷启动）会读在未就绪的存储上，写进去的值读不回来。
      // 这与 getPendingUpload 的前置步骤一致 —— 我第一版漏了它，
      // 表现为「set 成功但 get 恒 false」，而那是**最难查**的一类：
      // 代码看起来完全正确，只有真跑才暴露。
      await this.ensureVersion();
      const raw = await kvGet<unknown>(STORAGE_KEYS.FIRST_SYNC_PENDING);
      const resolved = scope ?? (await resolveCurrentLibraryScope());
      return resolveFirstSyncPending(raw, resolved);
    } catch {
      // 读不到就当「没有待决」：挡住的代价（数据传不上去）比放过的代价大。
      return false;
    }
  }

  async setFirstSyncPending(pending: boolean, scope?: string): Promise<void> {
    await this.ensureVersion();
    // 读-改-写同一个键（不是「按库各写一个键」）：键名保持单值，
    // `storage.clear()` 派生自 `Object.values(STORAGE_KEYS)`，动态键
    // 派生不出来 ⇒ 「清除本地数据」会留下孤儿待决位。
    const raw = await kvGet<unknown>(STORAGE_KEYS.FIRST_SYNC_PENDING);
    const record = toPendingRecord(raw);
    const key = scope ?? (await resolveCurrentLibraryScope());
    if (pending) {
      record[key] = true;
    } else {
      // 显式的「已完成」：它**只覆盖自己这个作用域**。
      // 旧格式槽位描述的是「某个（未知的）库的未决决定」—— 别的库若没有
      // 显式记录，仍按旧槽位待决（保守方向：不会少挡）。
      record[key] = false;
    }
    await kvSet(STORAGE_KEYS.FIRST_SYNC_PENDING, record);
    // 两个方向都要清「本次改动过的会话 id」队列：
    //   · pending=true（刚切到自带存储）：队列的语义是「**进入待决态之后**改动过的会话」，
    //     此前攒下的 id（那时还没有待决态，上传也没配好）全都属于「历史会话」——
    //     留着它们等于让历史会话照样被自动推上去，抑制又成了死代码；
    //   · pending=false（归属决策完成）：此后不再有抑制，留着只会在下一次进入
    //     待决态时误导增量筛选。
    await this.clearPendingUploadGroupIds();
  }

  /**
   * 待决期允许上传的会话 id 队列（2026-10-18 P1#4 第二半）。
   *
   * 为什么需要它：`FIRST_SYNC_PENDING` 期间自动上传必须只传本次改动，而适配器
   * 降级后用的判据是 `selectDirty(groups, 水位)` —— 远端没有 manifest 时水位恒为 0，
   * 全部历史会话都被判成脏 ⇒ 抑制前后上传内容逐字相同（死代码）。判据改成**写方
   * 一路记下来的 id**（保存路径知道它刚写了哪个组；mutation 命令本身也带着受影响的
   * id，见 core/mutationAffectedGroups），而不是靠 stamp 与水位比较去猜。
   *
   * 【失败方向】读不到就返回空数组 ⇒ 待决期什么都不上传（fail-closed）。这个方向是
   * 安全的：该期间**少传**只是「数据留在本机等用户决定」，**多传**才是违约
   * （用户还没决定归属，历史会话就已经上了他的云盘）。
   */
  async getPendingUploadGroupIds(): Promise<string[]> {
    try {
      await this.ensureVersion();
      const raw = await kvGet<unknown>(STORAGE_KEYS.PENDING_UPLOAD_GROUP_IDS);
      if (!Array.isArray(raw)) return [];
      return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))];
    } catch {
      return [];
    }
  }

  /**
   * 登记「本次操作改动过的会话 id」（并集，不去重即不覆盖前一轮的登记）。
   *
   * 为什么是并集而不是覆盖：防抖窗口内可能连着几次操作（保存一个会话、又删掉一条
   * 标签），每一次的改动都要在待决期上传出去；覆盖会把前一次登记抹掉。
   *
   * 失败即抛：调用方（scheduleUpload）必须知道这次登记没落盘 —— 静默失败会让
   * 待决期的增量上传**漏掉这次改动**，而用户以为它已经同步了。
   */
  async noteGroupsChanged(ids: readonly string[]): Promise<void> {
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (clean.length === 0) return;
    await this.ensureVersion();
    const existing = await this.getPendingUploadGroupIds();
    await kvSet(STORAGE_KEYS.PENDING_UPLOAD_GROUP_IDS, [...new Set([...existing, ...clean])]);
  }

  /** 清空待决期的增量 id 队列（上传成功后、或归属决策完成时）。 */
  async clearPendingUploadGroupIds(): Promise<void> {
    await this.ensureVersion();
    await kvRemove(STORAGE_KEYS.PENDING_UPLOAD_GROUP_IDS);
  }

  /**
   * 增量白名单的登记**是否曾经失败过**（2026-10-20 D-3 / D-10）。
   *
   * 登记失败的后果不是「少传几个」，而是「**不知道漏了哪几个**」——
   * 于是「队列与上行集合对得上账」不再能作为「全部已同步」的依据。
   * 有了这个标志，上传流程就知道：**不能**清 pending_upload，
   * 也不能对外宣称「都同步了」。
   *
   * 读失败 ⇒ false（方向：读不到不等于失败过。把它当 true 会让上传
   * 永远清不掉 pending_upload ⇒ 无限重试，比「偶尔多说一句」糟得多）。
   */
  async getPendingUploadRegistryUnreliable(): Promise<boolean> {
    return (await this.getPendingUploadRegistryState()).unreliable;
  }

  /**
   * 「登记不可信」标志的**完整状态**（2026-10-20 D-10）。
   *
   * ── 为什么不是一个布尔 ────────────────────────────────────────────────
   * 这个标志原本是布尔，且**只**在「上传对账通过」的分支里清 ——
   * 而「对账通过」的判据里含「标志为假」⇒ 自锁：标志一旦置上就永不复位
   * ⇒ pending_upload 永远清不掉 ⇒ 每轮后台同步都在重跑上传，界面还报
   * 「同步成功」（界面撒谎的原因：skippedGroups 恒为 undefined）。
   *
   * 现在它记的是**三件不同的事**（同一个 KV 键，值是对象）：
   *   · unreliable —— 「最近一次登记失败了」（写方事实）。
   *     复位条件 = **下一次登记成功**（写方事实，**与上传对账无关**），
   *     或「本轮提交的是全量 ⇒ 登记漏没漏都不影响本轮传了什么」。
   *   · gapOpen —— 「漏登记的那批改动还没被一次全量提交覆盖」。
   *     复位条件 = 「本轮提交的是全量」（那批改动就在这份全量里）。
   *   · gen —— 置位次数（**并发保护**，见 clearPendingUploadRegistryUnreliableIfUnchanged）。
   *
   * 前两者的区别是自锁的解药：unreliable 可以被「登记成功」单独复位，
   * 而 gapOpen 会一直挂着，直到有一次全量提交把漏登记的那批补上去。
   * 少了 gapOpen 就会出现这个洞：登记成功 ⇒ unreliable 复位 ⇒ 下一轮按
   * 白名单过滤 ⇒ 漏登记的那批**永远传不上去**。
   */
  async getPendingUploadRegistryState(): Promise<PendingUploadRegistryState> {
    const clean: PendingUploadRegistryState = { unreliable: false, gapOpen: false, gen: 0 };
    try {
      await this.ensureVersion();
      const raw = await kvGet<unknown>(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE);
      if (raw === undefined || raw === null) return clean;
      // 老版本写的是裸 `true`（D-3 的形状）⇒ 读作「失败过且还没被覆盖」。
      if (raw === true) return { unreliable: true, gapOpen: true, gen: 1 };
      if (raw && typeof raw === 'object') {
        const r = raw as Partial<PendingUploadRegistryState>;
        const unreliable = r.unreliable === true;
        const gapOpen = r.gapOpen === true;
        const gen = Number.isFinite(r.gen) && Number(r.gen) > 0 ? Math.floor(Number(r.gen)) : 1;
        return { unreliable, gapOpen, gen };
      }
      // 认不出来的形状：键存在却读不懂 ⇒ 有东西坏了 ⇒ 按「不可信」处理
      //（方向：读不懂不等于没问题；但也别把它当成「失败过 N 次」）。
      return { unreliable: true, gapOpen: true, gen: 1 };
    } catch {
      // 读失败 ⇒ false（既有纪律：读不到不等于失败过）。
      return clean;
    }
  }

  /**
   * 记下「这次登记失败了」（true）或**整个清掉**（false）。
   *
   * ⚠️ false 是**全清**（unreliable + gapOpen + 键本身）——
   * 「登记不可信」这件事整体不再成立。只清一半（只清 unreliable）的语义
   * 是另一个方法（markPendingUploadRegistryTrusted），两者混用会漏掉
   * 「漏登记未覆盖」这一半 ⇒ 白名单洞 ⇒ 漏传的改动永远补不回来。
   */
  async setPendingUploadRegistryUnreliable(unreliable: boolean): Promise<void> {
    await this.ensureVersion();
    if (unreliable) {
      const prev = await this.getPendingUploadRegistryState();
      // 置位 = 「又失败了一次」⇒ gen 递增（上传轮次据此发现「期间被改过」）。
      await kvSet(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE, {
        unreliable: true,
        gapOpen: true,
        gen: prev.gen + 1,
      } satisfies PendingUploadRegistryState);
    } else {
      await kvRemove(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE);
    }
  }

  /**
   * 「登记恢复可信」（写方登记成功的证据）—— 只清 unreliable，**保留 gapOpen**。
   *
   * 为什么不能顺手把 gapOpen 也清了：漏登记的那批改动的 id **已经不知道了**
   * ⇒ 唯一的兜底是「全量传一次」⇒ 必须等那次全量真的发生。
   * 在这之前清掉 gapOpen ⇒ 下一轮按白名单过滤 ⇒ 漏登记的那批永远传不上去
   * （静默丢失，且没有任何提示）。
   *
   * 幂等：已经是可信的状态 ⇒ 直接返回，不写盘。
   */
  async markPendingUploadRegistryTrusted(): Promise<void> {
    await this.ensureVersion();
    const prev = await this.getPendingUploadRegistryState();
    if (!prev.unreliable) return; // 已经是可信的 ⇒ 不写（避免无谓的 KV 写）
    await kvSet(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE, {
      unreliable: false,
      gapOpen: prev.gapOpen,
      gen: prev.gen,
    } satisfies PendingUploadRegistryState);
  }

  /**
   * 按**给定的新状态**写标志（带 gen 并发保护）。
   *
   * ── 为什么是「写给定的状态」而不是「帮我清掉」 ─────────────────────────
   * 判据的唯一真相源必须��**纯函数**（core/uploadCoverage 的
   * decideRegistryAfterUpload / decideRegistryAfterRegistryWrite）。
   * 若存储层自己「顺手清掉整个键」，就会出现两处判据漂移：纯函数说
   * 「gapOpen 保留」、存储层却把键删了（gapOpen 也没了）⇒ 漏登记的那批
   * 永远补不上（静默丢失）。所以这里只负责**忠实落盘**判据给出的状态。
   *
   * ⚠️ 并发保护：只有当 gen 与调用方读到的一致才写。
   * 轮次进行中又发生了一次登记失败（gen 变了）⇒ 那一批改动**不在**本轮
   * 提交的全量里（它是本轮提交之后才改的）⇒ 写下去就是抹掉一个真实问题
   * ⇒ 那批改动会**永远**补不回来。
   *
   * @param expectedGen 调用方读到状态时的 gen。
   * @param next 要落盘的新状态（由纯函数判据给出）。
   * @returns 落盘之后的**当前**状态（没写成功时是「期间被别人改过」的状态）。
   */
  async setPendingUploadRegistryStateIfUnchanged(
    expectedGen: number,
    next: { unreliable: boolean; gapOpen: boolean }
  ): Promise<PendingUploadRegistryState> {
    await this.ensureVersion();
    const prev = await this.getPendingUploadRegistryState();
    if (prev.gen !== expectedGen) {
      // 期间又有人置位了 ⇒ 不写（那一批不在本轮的提交里）。
      return prev;
    }
    if (next.unreliable === false && next.gapOpen === false) {
      // 两个位都清 ⇒ 键可以整个删掉（不留空对象）。
      if (prev.unreliable || prev.gapOpen) {
        await kvRemove(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE);
      }
      return { unreliable: false, gapOpen: false, gen: prev.gen };
    }
    await kvSet(STORAGE_KEYS.PENDING_UPLOAD_REGISTRY_UNRELIABLE, {
      unreliable: next.unreliable,
      gapOpen: next.gapOpen,
      gen: prev.gen,
    } satisfies PendingUploadRegistryState);
    return { unreliable: next.unreliable, gapOpen: next.gapOpen, gen: prev.gen };
  }

  /**
   * 导入后把变更标记为待上传并请求一次调度上传（**仅无 SW 兜底路径**）。
   *
   * SW 路径不需要它：mutationHandlers 的 importGroups 分支自己会
   * scheduleUpload（置 pending_upload + alarm）。
   *
   * 无 SW 语境（网页版）里导入只写本地 groups，既不盖操作印记也不会置
   * pending_upload，而后台上传仅在 hasPending 为真时才跑 → 导入的会话会永远
   * 只留在本地（多设备下备份恢复承诺不成立），所以这里补置标志。
   */
  private async markGroupsChangedByImport(): Promise<void> {
    try {
      await this.setPendingUpload(true);
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        // 与 mutationProtocol.sendSyncCommand 同一消息形态（不依赖它，避免循环引用）
        await chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'scheduleUpload' } })
          .catch(() => undefined);
      }
    } catch (error) {
      // 上传调度失败不影响导入本身，但必须留下痕迹
      logWarn('[Storage] 导入后请求上传调度失败（下次后台轮询会重试）:', error);
    }
  }

  /**
   * 导入的读-改-写入口。
   *
   * 【为什么导入不能自己读自己写】（2026-09-29 修）
   * 修复前 importData / importFromOneTabFormat 在 popup 进程里
   * getGroups()（30s 缓存读）→ 拼接 → setGroupsImmediate（整表直写），
   * 既不盖印记、不进队列，也完全不与 SW 协调。而后台 60 秒 alarm
   * （backgroundSync）触发的下载合并是「读快照 → 耗时若干秒下载 → 无条件整表
   * 覆盖」：两者交错时序是
   *     t0 SW 读快照 → t1 popup 写导入结果 → t2 SW 用 t0 快照覆盖
   * 刚导入的会话当场从本地消失，紧接着 pending_upload 又把这个「没有导入内容」
   * 的状态推上云端——本地与云端一起丢。
   *
   * 【现在的做法】复用仓库已有的单写者串行化路径，而不是自己另搞一把锁：
   * popup 把 importGroups 语义命令发给 SW，service-worker 的 MUTATE 分支用
   * **同一个 mutationQueue** 排它，与 sync:upload / sync:download 严格串行——
   * 导入要么排在下载合并之前（合并的快照已含导入结果），要么排在之后（导入读到的
   * 是合并后的真值），两种顺序都不会丢数据。SW 侧的读-改-写本来就是
   * getGroupsForWrite + applyImportGroups（盖 stamp）+ setGroupsImmediate，
   * 三件事一次做完：真值读、LWW 印记、上传调度。
   *
   * 无 SW（网页版 / node:test）时走本地兜底：同样的语义、同样的纯函数，
   * 只是由本进程串行执行（此语境下没有并发同步合并，竞态不成立）。
   */
  /**
   * @returns 实际导入的组数；**-1 = 超时、命令已受理但在后台继续**（数量未知）。
   *   两条路径都有真实数量可拿：SW 路径是 `res.payload`（applyImportGroups
   *   返回的 imported 数组），本地路径是 `merged.imported`。原先两条都丢掉，
   *   UI 只拿到一个 boolean，于是「导入了 3 个、跳过 7 个」无从告知。
   */
  private async mergeImportedGroups(incoming: TabGroup[]): Promise<{ imported: number; skippedExisting: number }> {
    // 2026-10-10 P2-4：幂等前置 —— 不再信任调用方「已归一化」。
    // 本方法此前只有两个调用方（两条路径都已经过 normalizeImportedGroup），
    // 所以这一行当下是恒等变换；它防的是**下一个**调用方（或被改回原样的
    // 调用方）绕过归一化：SW 侧 importGroups 分支已有自己的边界归一化（P1-1），
    // 本地兜底路径若直接拿脏形状喂 applyImportGroups，就会退化成
    // 「同一份文件走 SW 成功 / 走本地兜底失败」。
    // 二次归一化对已归一化的输入不变（容器选择命中 tabs、元素映射恒等），
    // 代价是一趟数组映射（几百组的规模下远小于一次落盘往返）。
    const safeIncoming = incoming.map(normalizeImportedGroup);
    if (hasMutationSender()) {
      const res = await sendMutation<{ imported: number; skippedExisting: number }>({ op: 'importGroups', groups: safeIncoming });
      if (!res.ok) {
        // 超时 ≠ 未受理（1.22.14）：sendMutation 把超时折成 { ok:false,
        // error:'操作超时…' }（它内部吞掉一切异常）。但超时的真实语义只是
        // 「popup 不再等了」，命令已进入 SW 单写者队列且后台会继续执行完。
        // 此时若报「导入失败」，用户重试同一份文件会导入出整份副本
        // （1.22.17 起 applyImportGroups 会跳过「同名 + 同内容指纹」的组，见
        // core/normalizeTabsData.groupContentFingerprint；但幂等是收敛机制，
        // 不是「可以随便重试」的许可）。按「已受理」处理：让 reload 后的
        // 列表展示真实结果；极端情况下列表短暂未含导入内容，等 SW 跑完再开即见。
        if (typeof res.error === 'string' && res.error.startsWith(TIMEOUT_REASON_PREFIX)) {
          logWarn('[Storage] 导入等待超时，命令已受理并在后台继续执行（不报失败，避免重复导入整份副本）');
          return { imported: -1, skippedExisting: 0 };
        }
        // 其余明确失败如实失败：不退回本地直写——那正是本方法要消灭的竞态路径。
        throw new Error(res.error ?? 'Service Worker 未接受导入');
      }
      const payload = res.payload;
      if (payload && typeof payload === 'object' && typeof payload.imported === 'number') {
        return { imported: payload.imported, skippedExisting: payload.skippedExisting ?? 0 };
      }
      // 旧形状（数组）兜底：SW 版本比本仓旧时按数组长度算。
      return { imported: Array.isArray(payload) ? payload.length : -1, skippedExisting: 0 };
    }

    const existing = await this.getGroupsForWrite();
    const stamp = await this.nextLocalOpStamp(existing);
    const merged = applyImportGroups(
      existing,
      safeIncoming,
      { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl },
      new Date().toISOString(),
      stamp
    );
    await this.setGroupsImmediate(merged.groups);
    await this.markGroupsChangedByImport();
    return { imported: merged.imported.length, skippedExisting: merged.skippedExisting };
  }

  /**
   * 本地兜底导入盖印记用的号（无 SW 语境没有 journal/seqRegistry 单例）。
   * 规则与 createSeqRegistry 一致：号位下限 = max(持久化 device_seq, 已观察到的
   * 全部实体印记 s)，即 Lamport 时钟——保证导入组盖的 stamp 严格大于本地既有
   * 任何实体印记，合并时不会「输给自己刚写的东西」。
   */
  private async nextLocalOpStamp(observed: TabGroup[]): Promise<OpStamp> {
    const seq = createSeqRegistry({ kvGet, kvSet, getGroups: async () => observed });
    return { d: await getDeviceId(), s: await seq.nextSeq() };
  }

  /**
   * 上次上传时间。
   *
   * 【为什么读失败必须抛】（2026-10-07 审查）它和 getPendingUpload 在**同一个
   * Promise.all** 里被 downloadAndMerge 读取，用来决定「能不能安全下载」。
   * 之前这里是 `catch { return null }`，而 null 的语义是「从未上传过」——
   * 于是一次瞬时读失败（死句柄看门狗 abort / quota / 事务 abort）会被当成
   * 「保护窗口不存在」，35s 的 recent_upload_guard 静默失效，下载就能覆盖掉
   * 本地未推送的新状态。同一表达式里的另一个判据已经改成 fail-closed（抛错），
   * 这一个必须同口径，否则同一个故障在半个表达式上被挡住、在另一半上放行。
   */
  async getLastUploadTime(): Promise<string | null> {
    await this.ensureVersion();
    return (await kvGet<string>(STORAGE_KEYS.LAST_UPLOAD_TIME)) || null;
  }

  async setLastUploadTime(time: string): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.LAST_UPLOAD_TIME, time);
    } catch (error) {
      logError('设置 last_upload_time 失败:', error);
    }
  }

  // 阶段二·§4.1：本设备 seq。SW 启动时由 seqRegistry 读取并修复；
  // mutationHandlers 在每次写入前调用 seqRegistry.nextSeq() 原子自增。
  async getDeviceSeq(): Promise<number> {
    try {
      await this.ensureVersion();
      return (await kvGet<number>(STORAGE_KEYS.DEVICE_SEQ)) ?? 0;
    } catch {
      return 0;
    }
  }

  async setDeviceSeq(seq: number): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.DEVICE_SEQ, seq);
    } catch (error) {
      logError('设置 device_seq 失败:', error);
    }
  }

  // 阶段二·§4.3：journal 读写（mutationHandlers 通过 createJournal 工厂间接访问）
  async getJournal(): Promise<unknown[]> {
    try {
      await this.ensureVersion();
      return (await kvGet<unknown[]>(STORAGE_KEYS.JOURNAL)) ?? [];
    } catch {
      return [];
    }
  }

  async setJournal(entries: unknown[]): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.JOURNAL, entries);
    } catch (error) {
      logError('写 journal 失败:', error);
    }
  }

  async getLastSyncedSeq(): Promise<number> {
    try {
      await this.ensureVersion();
      return (await kvGet<number>(STORAGE_KEYS.LAST_SYNCED_SEQ)) ?? 0;
    } catch {
      return 0;
    }
  }

  async setLastSyncedSeq(s: number): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.LAST_SYNCED_SEQ, s);
    } catch (error) {
      logError('设置 last_synced_seq 失败:', error);
    }
  }

  // 阶段二·§7：迁移标志位
  async getOpStampMigrated(): Promise<boolean> {
    try {
      await this.ensureVersion();
      return (await kvGet<boolean>(STORAGE_KEYS.OP_STAMP_MIGRATED)) === true;
    } catch {
      return false;
    }
  }

  async setOpStampMigrated(v: boolean): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.OP_STAMP_MIGRATED, v);
    } catch (error) {
      logError('设置 op_stamp_migrated 失败:', error);
    }
  }

  /**
   * 清除 sync_snapshot 键 —— **只用于清理历史遗留**。
   *
   * 【为什么 get/set 被删掉了】这个键曾是「下载合并前回滚点」的持久化副本，
   * 但 getSyncSnapshot() 全仓零调用：回滚路径 restoreSnapshot() 用的是内存里的
   * snapshot 变量，而全仓也没有任何「启动时读回磁盘快照」的恢复入口。
   * 也就是说它一直是 write-only —— 每 60s 一次的后台同步都会把整份 groups
   * 再写一遍到磁盘，提供零回滚能力，却实打实占用单写者队列的时间
   * （全量 blob 场景下是秒级 I/O，正是「删除/清理有时特别慢」的贡献者之一）。
   *
   * groups 是单个 blob、一次 kvSet 原子写入，不存在「写到一半的撕裂态」需要
   * 磁盘副本来恢复，因此删掉写入不损失任何安全性。
   *
   * 【为什么 clear 要留着】存量用户磁盘上还躺着上一次写入的副本（一份全量 groups，
   * 可能几 MB）。下载成功后调用一次把它清掉；幂等、便宜，之后键不存在就是空操作。
   * 键名保留在 STORAGE_KEYS 里，storage.clear() 也仍会删它。
   */
  async clearSyncSnapshot(): Promise<void> {
    try {
      await this.ensureVersion();
      await kvRemove(STORAGE_KEYS.SYNC_SNAPSHOT);
    } catch (error) {
      logError('清除同步快照失败:', error);
    }
  }

  async getProductEvents(): Promise<Array<Record<string, unknown>>> {
    try {
      await this.ensureVersion();
      const events = await kvGet<unknown>(STORAGE_KEYS.PRODUCT_EVENTS);
      return Array.isArray(events) ? (events as Array<Record<string, unknown>>) : [];
    } catch (error) {
      logError('获取产品事件失败:', error);
      return [];
    }
  }

  async appendProductEvent(event: Record<string, unknown>): Promise<void> {
    const events = await this.getProductEvents();
    const nextEvents = [...events, event].slice(-200);
    await kvSet(STORAGE_KEYS.PRODUCT_EVENTS, nextEvents);
  }

  async clearProductEvents(): Promise<void> {
    await kvRemove(STORAGE_KEYS.PRODUCT_EVENTS);
  }

  async exportData(): Promise<ExportData> {
    // 导出是写用户备份，必须是最新真值：30s 缓存快照会让「备份恢复」把用户带回
    // 几分钟前的状态（且此后云端合并可能已把这段时间的改动上传过）。
    // 用 getGroupsForWrite 而非 getGroupsFresh：后者只失效缓存、不 flush 500ms 防抖
    // 窗口，用户「刚改名完 200ms 就点导出」时那次 setGroups 还没落盘，备份会缺这一笔。
    const groups = await this.getGroupsForWrite();
    const settings = await this.getSettings();

    // 2026-10-20 审计 A-21：导出侧也必须剔掉「不跨设备」与「已退役」的设置键。
    //
    // 【为什么】导入侧（importDetailed）会剔这三个键 ⇒ 写在备份文件里就是
    // **文件内容在表达一个假承诺**：用户打开备份看到 `syncBackend: "supabase"`，
    // 理所当然以为「导入后同步设置也会跟着走」，而实际不会。
    // 已退役键更不该出现 —— 它们在本地也不生效。
    //
    // 与「上云」「云端合并」共用同一张剔除表（stripNonPortableSettings），
    // 免得四条路径各写一遍、各漂一次。
    return {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        groups,
        settings: stripNonPortableSettings(settings)
      }
    };
  }

  /**
   * 导出为 OneTab 格式
   * @returns OneTab 格式的导出文本
   */
  async exportToOneTabFormat(): Promise<string> {
    // 同 exportData：getGroupsForWrite 会 flush 防抖窗口，getGroupsFresh 不会
    const groups = await this.getGroupsForWrite();
    return formatToOneTabFormat(groups);
  }

  /**
   * 导入 JSON 备份。
   *
   * 组数据走 mergeImportedGroups（SW 单写者串行化 + 真值读 + 盖印记），
   * 设置合并单独兜错：设置读失败（fail-closed）不得把**已经落盘**的组导入
   * 判成整体失败，用户看到「导入失败」却发现会话其实已经进来了。
   */
  /**
   * 导入 JSON 备份，并给出**真实结果**（2026-10-09 UX P1-6）。
   *
   * 为什么不再只回一个 boolean：`applyImportGroups` 会把 sanitizeTabUrl 不通过的
   * 标签整条丢弃、并滤掉因此变空的组 —— 所以「文件里有 10 个组」不等于「导入了
   * 10 个组」。只回 boolean 时 UI 要么弹「导入失败」、要么 reload 后什么也不说，
   * 用户无从知道「导入了 3 个、跳过 7 个」，也没法把跳过的去文件里对。
   *
   * 这是诚实化的**下一层**：1.22.14/15 已修掉「全跳过却报成功」，
   * 这里补的是「部分成功也必须说出来」。
   *
   * `importData` 保留为薄包装（返回 boolean）——9 处既有测试与调用方依赖该形状；
   * 新 UI 改用本方法拿数量。
   */
  async importDetailed(data: ExportData): Promise<ImportDetailedResult> {
    // 【2026-10-10 P2-3】文件里的组数在 try 之外先行取出：原先只有 try 内的两个
    // return 分支带 `source: groups.length`，而 catch 分支直接归零，于是
    // 「文件里有 N 个组、却因任何原因（设置读炸、SW 明确拒绝、归一化抛错）
    // 一个都没落盘」时，UI 拿到 source:0 → 用户看到「导入失败」却不知道
    // 文件里到底有什么，无从判断是文件坏还是导入坏。
    // source 的语义是「文件里有多少个组」——这是**读文件**的事实，
    // 不该因为后续步骤失败而归零。格式完全不对（data.data.groups 非数组）
    // 时它就是 0，仍然诚实。
    const sourceGroupsCount = Array.isArray(data?.data?.groups) ? data.data.groups.length : 0;
    try {
      if (!data || !data.data || !Array.isArray(data.data.groups)) {
        throw new Error('无效的导入数据格式');
      }

      // 归一化（2026-10-07）：JSON 备份是**用户手上的文件**，形状不可信 ——
      // 旧版本/云端导出可能用 `tabs_data` 而不是 `tabs`，而下游
      // applyImportGroups 会直接 group.tabs.reduce(...)，一旦缺失就整次导入抛异常
      // （用户看到「导入失败」却不知道原因，而文件其实是好的）。
      // 下载路径早就在用 normalizeTabsData 处理同一类形状，导入路径此前没有。
      const groups = data.data.groups.map(normalizeImportedGroup);

      // 诚实化（2026-10-07 补漏）：与 importFromOneTabFormat 同一处判据 ——
      // 「有 N 个组」不等于「能导入 N 个组」。applyImportGroups 会把 sanitizeTabUrl
      // 不通过的标签整条丢弃、并滤掉因此变空的组；若所有组都这样，旧实现一路
      // 返回 true，UI 弹「成功」并 reload，列表却什么都没多 —— 假成功比失败更误导。
      // 1.22.14 只修了 OneTab 那条路，JSON 备份这条路漏了。
      const hasImportableGroup = groups.some(
        group =>
          Array.isArray(group?.tabs) &&
          group.tabs.some(tab => sanitizeTabUrl(tab?.url) !== null)
      );
      if (!hasImportableGroup) {
        logWarn(
          `[Storage] 导入数据里没有可导入的标签组：${groups.length} 个组全部为空或只含不可存储的 URL`
        );
        // 这里的 early return（false）**有意不合并 settings**：全不可导入时
        // 导入判定为「失败」，若仍悄悄改写设置，用户会看到「导入失败」的提示、
        // 设置却已经变了 —— 报失败的同时改状态比不改更糟（与整次导入的原子
        // 期望一致：失败 = 什么都没动）。
        // 注意这是 1.22.15 引入的行为变化：旧版本在这条路径上仍会合并 settings。
        // 若要恢复旧行为，把这段 early return 移到 settings 合并之后即可，
        // 但需要先重新论证「失败提示 + 设置被改」的组合是否可接受。
        return { ok: false, imported: 0, source: groups.length, pending: false,
          reason: `文件内共 ${groups.length} 个会话，但没有任何可导入的网址：` +
            '全部为空会话，或只含无法保存的网址（javascript:、data: 等危险协议，' +
            '以及 chrome://、edge:// 等浏览器内部地址会被跳过）' };
      }

      const merged = await this.mergeImportedGroups(groups);

      // 如果有设置数据，则合并设置
      if (data.data.settings) {
        try {
          const currentSettings = await this.getSettings();
          // 设备级字段不跟着备份跨设备（2026-10-18 产品定稿，同一个
          // DEVICE_LEVEL_SETTING_KEYS 也用在「上云」与「云端合并」两条路径上）。
          // 备份文件是**用户手上的外来文件**：B 机导入 A 机的备份后，本机的
          // syncBackend 会变成 A 机那个后端 —— 而 WebDAV 凭据不进 UserSettings，
          // 本机没有 ⇒ 同步立刻坏掉，用户只看到「同步失败/请先登录」，
          // 无从判断是自己的后端被换了。syncEnabled/syncIntervalMinutes 同理，
          // 它们描述的是本机的后台行为。
          //
          // 2026-10-20 审计 A-21：改用共用函数 stripNonPortableSettings ——
          // 与「上云」「云端合并」「导出备份」四条路径同一张剔除表。
          const importedSettings = stripNonPortableSettings(data.data.settings);
          await this.setSettings({
            ...currentSettings,
            ...importedSettings
          });
        } catch (settingsError) {
          logWarn('[Storage] 导入的设置未合并（标签组已导入成功，设置保持原样）:', settingsError);
        }
      }

      return {
        ok: true,
        // importedCount === -1 表示超时但命令已受理（后台继续跑，真实数量未知）
        imported: merged.imported < 0 ? 0 : merged.imported,
        source: groups.length,
        pending: merged.imported < 0,
        // 2026-10-19 审计 F-5：「已存在而跳过」的个数。
        // UI 据此把「幂等跳过」与「文件内容有问题」分开说 —— 原先两者共用
        // 一句「为空会话或只含无法保存的网址」，用户重复导入同一份备份时
        // 看到的是「你的备份文件坏了」。
        skippedExisting: merged.skippedExisting,
      };
    } catch (error) {
      logError('导入数据失败:', error);
      // source 保持「文件里的组数」（见方法开头注释），不归零。
      return {
        ok: false,
        imported: 0,
        source: sourceGroupsCount,
        pending: false,
        // 格式不对（最高频，且用户自己能判断）与写盘失败（用户处理不了）
        // 必须分开说 —— 原先 UI 只有一句静态的「数据导入失败」，三种原因同一句。
        reason:
          sourceGroupsCount === 0
            ? '这个文件里没有可导入的会话：请确认选中的是本扩展导出的 JSON 备份文件'
            : `导入未能完成（文件内共 ${sourceGroupsCount} 个会话，本次一个都没落盘）。请稍后重试；若反复失败，可能是浏览器存储空间不足或扩展无写入权限。`,
      };
    }
  }

  /** {@link importDetailed} 的 boolean 薄包装（既有调用方与测试依赖这个形状）。 */
  async importData(data: ExportData): Promise<boolean> {
    return (await this.importDetailed(data)).ok;
  }

  /**
   * 从 OneTab 格式导入数据
   * @param text OneTab 格式的文本
   * @returns ok=是否导入成功；失败时 reason=面向用户的原因说明（1.22.14 诚实化：
   *   「解析失败」不再笼统一刀切——0 组与全无效 URL 是两种不同的失败，文案分开说）。
   *   imported/source 为**可选**（2026-10-09 UX P1-6）：成功时给实际落盘数与
   *   解析出的组数，供 UI 报「导入 N 个、跳过 M 个」。既有调用方只读 ok/reason，
   *   不传也不依赖这两个字段，所以保持可选以免牵动 3 处测试。
   */
  async importFromOneTabFormat(text: string): Promise<{
    ok: boolean;
    reason?: string;
    imported?: number;
    source?: number;
    pending?: boolean;
    /** 「已存在而跳过」的会话数（2026-10-19 审计 F-5，语义同 ImportDetailedResult）。 */
    skippedExisting?: number;
  }> {
    try {
      if (!text || typeof text !== 'string') {
        return { ok: false, reason: '导入内容为空，请重新选择 OneTab 导出的文本文件' };
      }

      // 解析 OneTab 格式的文本
      const parsedGroups = parseOneTabFormat(text);

      // 诚实化（1.22.14）：「解析出 N 个组」不等于「能导入 N 个组」。
      // parseOneTabFormat 会为每个空行分隔块建组，URL 清洗不合格的行整行丢弃；
      // applyImportGroups 再过滤空组。全部行无效时旧实现有两条坏路径：
      //   - parsedGroups 为空 → 报「解析失败或没有有效的标签组」，用户不知道为什么；
      //   - parsedGroups 非空但组内标签全被清洗掉 → 一路走到 SW 返回 ok，
      //     弹「成功」并 reload，列表却什么都没多 —— 假成功比失败更误导。
      // 现在在发送前判明「可导入组数」，为 0 时说明原因。
      const importableGroups = parsedGroups.filter(group => group.tabs.length > 0);
      if (importableGroups.length === 0) {
        return {
          ok: false,
          reason:
            parsedGroups.length === 0
              ? '没有解析出任何标签组：请确认这是 OneTab 导出的文本（空行分隔会话，每行一个网址）'
              : `解析出 ${parsedGroups.length} 个会话，但没有任何可导入的网址：全部行都不是可存储的 URL（javascript:、data: 等危险协议，以及 chrome://、edge:// 等浏览器内部地址会被跳过）`,
        };
      }

      // 同 importData：交单写者串行化执行读-改-写（真值读 + 盖印记 + 上传调度）。
      // 只发可导入组，全空的壳不必让 SW 再过滤一遍。
      //
      // ⚠️ 这里**只调用一次**：mergeImportedGroups 会真的写盘。
      // 2026-10-10：applyImportGroups 已具备导入幂等（同名 + 同内容指纹 → 跳过），
      // 但幂等是**收敛**机制，不是「可以随便调两次」的许可 —— 它按内容判重，
      // 不保证任意两次调用的副作用可交换。回归锁（每次入口恰好调 1 次）在
      // tests/p0DataSafetyGuards.test.ts。
      // 2026-10-09 我给它加返回值统计时差点留了重复调用，靠自查发现。
      const merged = await this.mergeImportedGroups(importableGroups);
      return {
        ok: true,
        imported: merged.imported < 0 ? 0 : merged.imported,
        source: parsedGroups.length,
        pending: merged.imported < 0,
        // 2026-10-19 审计 F-5：与 JSON 路径同一口径，UI 才能分开说
        // 「已存在（幂等）」与「内容有问题」。
        skippedExisting: merged.skippedExisting,
      };
    } catch (error) {
      logError('从 OneTab 格式导入数据失败:', error);
      return { ok: false, reason: error instanceof Error ? error.message : '导入失败，请重试' };
    }
  }

  async clear(): Promise<void> {
    try {
      // 键清单直接从 STORAGE_KEYS 派生，不再手抄一份。
      //
      // 手抄版已经和单源漂移了：SYNC_SNAPSHOT 不在原清单里，于是「清除本地数据」
      // 之后仍留着一个同步回滚快照（它对应的 groups 已被清掉，是个永远不该被
      // restore 的孤儿回滚点）。此后每加一个键都会重演这个遗漏——加键的人不会想到
      // 还有一份平行的清单要同步改。
      const keys = Object.values(STORAGE_KEYS);
      await Promise.all(keys.map(key => kvRemove(key)));
      //
      // 2026-10-11 补充：增量上传水位**故意不在**这张表里（它是按账号寻址的
      // 推导量，理由见 storage-kv/keys.ts 末尾）。这里刻意**不**顺带清它：
      // 水位按 userId 分键，而本方法拿不到当前 userId（storage 层不持有会话态），
      // 要清就得引入「按前缀枚举删除」这种 KV 层未承诺的能力 —— 那是为一个
      // **已不存在的风险**加复杂度。
      //
      // 风险为什么不复存在：水位值带 deviceSeq 基线，上传时若发现 seq 时钟已回退
      // （清数据把 DEVICE_SEQ 清零 ⇒ 新组 seq 从 1 重启 ⇒ 当前计数器 < 基线）
      // 就**自动作废水位**走全量上行（见 supabase/syncWatermark.ts 头注释 P0 段）。
      // 残留的只是一个无害的孤儿推导量，代价是清数据后的首轮多传一次全量。
      // 正确性由水位自身保证，不依赖这里补一刀。
    } catch (error) {
      logError('清除存储失败:', error);
    }
  }

  // 迁移标志相关方法
  async getMigrationFlags(): Promise<Record<string, boolean>> {
    try {
      // 优先使用加密存储
      const flags = await secureStorage.get<Record<string, boolean>>(STORAGE_KEYS.MIGRATION_FLAGS);
      if (flags) return flags;

      // 降级到普通存储（向后兼容）
      const result = await kvGet<Record<string, boolean>>(STORAGE_KEYS.MIGRATION_FLAGS);
      return result || {};
    } catch (error) {
      logError('获取迁移标志失败:', error);
      return {};
    }
  }

  async setMigrationFlag(key: string, value: boolean): Promise<void> {
    try {
      const flags = await this.getMigrationFlags();
      flags[key] = value;

      // 使用加密存储
      await secureStorage.set(STORAGE_KEYS.MIGRATION_FLAGS, flags);
    } catch (error) {
      logError('设置迁移标志失败:', error);
      // 降级到普通存储
      try {
        const flags = await this.getMigrationFlags();
        flags[key] = value;
        await kvSet(STORAGE_KEYS.MIGRATION_FLAGS, flags);
      } catch (fallbackError) {
        logError('降级存储也失败:', fallbackError);
      }
    }
  }
}

export const storage = new ChromeStorage();
