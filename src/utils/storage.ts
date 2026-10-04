import { TabGroup, UserSettings, LayoutMode, ThemeStyle } from '@/types/tab';
import { parseOneTabFormat, formatToOneTabFormat } from '@/core/oneTabFormatParser';
import { secureStorage } from './secureStorage';
import { kvGet, kvSet, kvRemove } from '@/storage/storageAdapter';
import { notifyGroupsChanged, subscribeGroupsChanged } from '@/storage-kv/groupsChangedBus';
import { STORAGE_KEYS, STORAGE_VERSION } from '@/storage-kv/keys';
import { cacheManager, cachedAsyncFn, debounceAsync } from './performance';
import { logError, logWarn } from './log';
// 导入路径需要与 SW 单写者同构的语义：盖印记（LWW 载体）+ URL 白名单 + 重排。
// 纯函数在 @/core/mutationOps，与 mutationHandlers 走的是同一份实现，
// 本地兜底（无 SW 语境）与 SW 语义不可能漂移。
import { applyImportGroups } from '@/core/mutationOps';
import { sanitizeTabUrl } from './inputValidation';
import { createSeqRegistry } from './seqRegistry';
import { getDeviceId } from './deviceUtils';
import { sendMutation } from '@/shared/mutationProtocol';
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

// 有效的主题风格值
const VALID_THEME_STYLES: ThemeStyle[] = ['legacy', 'creamy', 'prism', 'apple', 'chrome', 'claude'];

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

// 默认设置
export const DEFAULT_SETTINGS: UserSettings = {
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false, // 默认不允许重复标签页
  syncEnabled: true, // 默认启用同步
  layoutMode: 'single' as LayoutMode, // 默认使用单栏布局
  showNotifications: false, // 默认关闭通知
  syncStrategy: 'newest', // 默认使用最新版本
  deleteStrategy: 'everywhere', // 默认在所有设备上删除
  themeMode: 'auto', // 默认使用自动模式（跟随系统）
  themeStyle: 'legacy', // 默认使用原始主题
  // 默认不收集固定标签页（更保守）
  collectPinnedTabs: false,
};

// 兼容历史字段
type LegacySettings = Partial<UserSettings> & {
  useDoubleColumnLayout?: boolean;
};

// 导出数据的格式
interface ExportData {
  version: string;
  timestamp: string;
  data: {
    groups: TabGroup[];
    settings: UserSettings;
  };
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
      return Array.isArray(groups) ? (groups as TabGroup[]) : [];
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
   * getGroups() 有 30s 进程内缓存，而 groups 并非只有 SW 一个上下文会写：
   * popup 的 runMigrations（migrateFaviconUrls）会在 TabList 挂载时调
   * setGroups() 写 GROUPS key。SW 侧没有注册 onGroupsChanged，感知不到这次写入，
   * 缓存就此陈旧。
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

        // 如果验证后的值与原值不同，说明存储中有无效值，需要更新
        const needsUpdate =
          normalizedSettings.themeStyle !== validatedThemeStyle ||
          normalizedSettings.themeMode !== validatedThemeMode;

        const mergedSettings: UserSettings = {
          ...DEFAULT_SETTINGS,
          ...normalizedSettings,
          themeStyle: validatedThemeStyle,
          themeMode: validatedThemeMode,
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
    };

    await kvSet(STORAGE_KEYS.SETTINGS, validatedSettings);

    // 落盘后刷新缓存 TTL（即便之前已 optimistic 更新）
    const cache = cacheManager.getCache('storage');
    cache.set('settings', validatedSettings, CACHE_TTL.SETTINGS);
  }, 500);

  async setSettings(settings: UserSettings): Promise<void> {
    const validatedSettings: UserSettings = {
      ...settings,
      themeStyle: validateThemeStyle(settings.themeStyle),
      themeMode: validateThemeMode(settings.themeMode),
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

  // ponytail: 持久化的“本地有未上传变更”标志。
  // scheduleUpload 置 true；upload 成功置 false；cancelPendingUpload 不动。
  async getPendingUpload(): Promise<boolean> {
    try {
      await this.ensureVersion();
      return (await kvGet<boolean>(STORAGE_KEYS.PENDING_UPLOAD)) === true;
    } catch {
      return false;
    }
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
  private async mergeImportedGroups(incoming: TabGroup[]): Promise<void> {
    if (hasMutationSender()) {
      const res = await sendMutation<TabGroup[]>({ op: 'importGroups', groups: incoming });
      if (!res.ok) {
        // 明确失败就如实失败：不退回本地直写——那正是本方法要消灭的竞态路径。
        throw new Error(res.error ?? 'Service Worker 未接受导入');
      }
      return;
    }

    const existing = await this.getGroupsForWrite();
    const stamp = await this.nextLocalOpStamp(existing);
    const merged = applyImportGroups(
      existing,
      incoming,
      { genId: () => nanoid(), sanitizeUrl: sanitizeTabUrl },
      new Date().toISOString(),
      stamp
    );
    await this.setGroupsImmediate(merged.groups);
    await this.markGroupsChangedByImport();
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

  async getLastUploadTime(): Promise<string | null> {
    try {
      await this.ensureVersion();
      return (await kvGet<string>(STORAGE_KEYS.LAST_UPLOAD_TIME)) || null;
    } catch {
      return null;
    }
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

  // 获取同步前快照（合并失败时用于回滚）
  async getSyncSnapshot(): Promise<TabGroup[] | null> {
    try {
      await this.ensureVersion();
      const raw = await kvGet<unknown>(STORAGE_KEYS.SYNC_SNAPSHOT);
      return Array.isArray(raw) ? (raw as TabGroup[]) : null;
    } catch (error) {
      logError('获取同步快照失败:', error);
      return null;
    }
  }

  // 保存同步前快照
  async setSyncSnapshot(groups: TabGroup[]): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.SYNC_SNAPSHOT, groups);
    } catch (error) {
      logError('保存同步快照失败:', error);
    }
  }

  // 清除同步快照（合并成功后调用）
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

    return {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        groups,
        settings
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
  async importData(data: ExportData): Promise<boolean> {
    try {
      if (!data || !data.data || !Array.isArray(data.data.groups)) {
        throw new Error('无效的导入数据格式');
      }

      await this.mergeImportedGroups(data.data.groups);

      // 如果有设置数据，则合并设置
      if (data.data.settings) {
        try {
          const currentSettings = await this.getSettings();
          await this.setSettings({
            ...currentSettings,
            ...data.data.settings
          });
        } catch (settingsError) {
          logWarn('[Storage] 导入的设置未合并（标签组已导入成功，设置保持原样）:', settingsError);
        }
      }

      return true;
    } catch (error) {
      logError('导入数据失败:', error);
      return false;
    }
  }

  /**
   * 从 OneTab 格式导入数据
   * @param text OneTab 格式的文本
   * @returns 是否导入成功
   */
  async importFromOneTabFormat(text: string): Promise<boolean> {
    try {
      if (!text || typeof text !== 'string') {
        throw new Error('无效的 OneTab 导入数据');
      }

      // 解析 OneTab 格式的文本
      const parsedGroups = parseOneTabFormat(text);

      if (parsedGroups.length === 0) {
        throw new Error('解析失败或没有有效的标签组');
      }

      // 同 importData：交单写者串行化执行读-改-写（真值读 + 盖印记 + 上传调度）
      await this.mergeImportedGroups(parsedGroups);

      return true;
    } catch (error) {
      logError('从 OneTab 格式导入数据失败:', error);
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      const keys = [
        STORAGE_KEYS.VERSION,
        STORAGE_KEYS.GROUPS,
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.DELETED_GROUPS,
        STORAGE_KEYS.DELETED_TABS,
        STORAGE_KEYS.LAST_SYNC_TIME,
        STORAGE_KEYS.PRODUCT_EVENTS,
        STORAGE_KEYS.MIGRATION_FLAGS,
        STORAGE_KEYS.PENDING_UPLOAD,
        STORAGE_KEYS.LAST_UPLOAD_TIME,
        STORAGE_KEYS.PENDING_PURGE_IDS,
        STORAGE_KEYS.PENDING_DELETE_IDS,
        STORAGE_KEYS.DEVICE_SEQ,
        STORAGE_KEYS.JOURNAL,
        STORAGE_KEYS.LAST_SYNCED_SEQ,
        STORAGE_KEYS.OP_STAMP_MIGRATED,
      ];
      await Promise.all(keys.map(key => kvRemove(key)));
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
