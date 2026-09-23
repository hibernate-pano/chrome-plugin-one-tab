import { TabGroup, UserSettings, Tab, LayoutMode, ThemeStyle } from '@/types/tab';
import { parseOneTabFormat, formatToOneTabFormat } from './oneTabFormatParser';
import { secureStorage } from './secureStorage';
import { kvGet, kvSet, kvRemove } from '@/storage/storageAdapter';
import { STORAGE_KEYS, STORAGE_VERSION } from '@/storage-kv/keys';
import { cacheManager, cachedAsyncFn, debounceAsync } from './performance';

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
 * SW 侧任何写入都会触发；回调前自动失效本进程 groups 缓存。
 */
export function onGroupsChanged(cb: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.GROUPS]) return;
    invalidateGroupsCache();
    cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// 有效的主题风格值
const VALID_THEME_STYLES: ThemeStyle[] = [
  'legacy',
  'classic',
  'aurora',
  'creamy',
  'pink',
  'mint',
  'cyberpunk',
  'prism',
];

// 有效的主题模式值
const VALID_THEME_MODES: Array<'light' | 'dark' | 'auto'> = ['light', 'dark', 'auto'];

/**
 * 验证主题风格值
 * @param value 待验证的值
 * @returns 有效的主题风格值，无效时返回默认值 'legacy'
 */
export function validateThemeStyle(value: unknown): ThemeStyle {
  if (typeof value === 'string' && VALID_THEME_STYLES.includes(value as ThemeStyle)) {
    return value as ThemeStyle;
  }
  console.warn('无效的主题风格值，使用默认值:', value);
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
  console.warn('无效的明暗模式值，使用默认值:', value);
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

  async getGroups(): Promise<TabGroup[]> {
    try {
      return await cachedAsyncFn('storage', 'groups', async () => {
        await this.ensureVersion();
        const groups = await kvGet<unknown>(STORAGE_KEYS.GROUPS);
        return Array.isArray(groups) ? (groups as TabGroup[]) : [];
      }, CACHE_TTL.GROUPS);
    } catch (error) {
      console.error('获取标签组失败:', error);
      return [];
    }
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
      console.error('保存标签组失败:', error);
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
  async setGroupsImmediate(groups: TabGroup[]): Promise<void> {
    const cache = cacheManager.getCache('storage');
    try {
      await this.debouncedPersistGroups.flush();
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.GROUPS, groups);
      cache.set('groups', groups, CACHE_TTL.GROUPS);
    } catch (error) {
      console.error('直接保存标签组失败:', error);
      cache.delete('groups');
      throw error;
    }
  }

  /**
   * P1-4：同步关键路径专用新鲜读（先失效 30s 缓存再读）。
   * 同一进程内 mutation 刚写完就触发下载时，缓存可能是防抖窗口期的旧快照。
   */
  async getGroupsFresh(): Promise<TabGroup[]> {
    invalidateGroupsCache();
    return this.getGroups();
  }

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
      console.error('获取设置失败:', error);
      return DEFAULT_SETTINGS;
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
      console.error('保存设置失败:', error);
      // 清除可能不一致的缓存
      cache.delete('settings');
      throw error;
    }
  }

  // 新增：获取已删除的标签组
  async getDeletedGroups(): Promise<TabGroup[]> {
    try {
      await this.ensureVersion();
      const groups = await kvGet<unknown>(STORAGE_KEYS.DELETED_GROUPS);
      return Array.isArray(groups) ? (groups as TabGroup[]) : [];
    } catch (error) {
      console.error('获取已删除标签组失败:', error);
      return [];
    }
  }

  // 新增：设置已删除的标签组
  async setDeletedGroups(groups: TabGroup[]): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.DELETED_GROUPS, groups);
    } catch (error) {
      console.error('设置已删除标签组失败:', error);
    }
  }

  // 新增：获取已删除的标签页
  async getDeletedTabs(): Promise<Tab[]> {
    try {
      await this.ensureVersion();
      const tabs = await kvGet<unknown>(STORAGE_KEYS.DELETED_TABS);
      return Array.isArray(tabs) ? (tabs as Tab[]) : [];
    } catch (error) {
      console.error('获取已删除标签页失败:', error);
      return [];
    }
  }

  // 新增：设置已删除的标签页
  async setDeletedTabs(tabs: Tab[]): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.DELETED_TABS, tabs);
    } catch (error) {
      console.error('设置已删除标签页失败:', error);
    }
  }

  // 新增：清理过期的已删除标签组
  /**
   * ⚠️ 已废弃，勿接入调度：本函数读写的是旧「回收站列表」（getDeletedGroups/
   * getDeletedTabs），而阶段二的墓碑是**内联在 groups 数组里**的 `isDeleted: true`
   * 实体（带 lastOp 印记）→ 调用它不会回收任何墓碑，只是死代码。
   * 墓碑压缩需「云端已确认 + 30 天龄期」（规格 §8），属阶段三，
   * 届时需按印记模型重写（包含云端行删除与本地内联墓碑清理）。
   * 现状：墓碑只增不减，但增速 = 用户删除频率，不构成即时风险。
   */
  async cleanupDeletedGroups(maxAgeInDays: number = 30): Promise<void> {
    try {
      const deletedGroups = await this.getDeletedGroups();
      const now = new Date().getTime();
      const maxAgeMs = maxAgeInDays * 24 * 60 * 60 * 1000;

      // 过滤出未过期的已删除标签组
      const validGroups = deletedGroups.filter(group => {
        const updatedAt = new Date(group.updatedAt).getTime();
        return (now - updatedAt) < maxAgeMs;
      });

      // 如果有过期的标签组，更新存储
      if (validGroups.length !== deletedGroups.length) {
        await this.setDeletedGroups(validGroups);
        console.log(`清理了 ${deletedGroups.length - validGroups.length} 个过期的已删除标签组`);
      }

      // 同时清理过期的已删除标签页
      const deletedTabs = await this.getDeletedTabs();
      const validTabs = deletedTabs.filter(tab => {
        const lastAccessed = new Date(tab.lastAccessed).getTime();
        return (now - lastAccessed) < maxAgeMs;
      });

      if (validTabs.length !== deletedTabs.length) {
        await this.setDeletedTabs(validTabs);
        console.log(`清理了 ${deletedTabs.length - validTabs.length} 个过期的已删除标签页`);
      }
    } catch (error) {
      console.error('清理已删除数据失败:', error);
    }
  }

  // 获取最后同步时间
  async getLastSyncTime(): Promise<string | null> {
    try {
      await this.ensureVersion();
      return (await kvGet<string>(STORAGE_KEYS.LAST_SYNC_TIME)) || null;
    } catch (error) {
      console.error('获取最后同步时间失败:', error);
      return null;
    }
  }

  // 设置最后同步时间
  async setLastSyncTime(time: string): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.LAST_SYNC_TIME, time);
    } catch (error) {
      console.error('设置最后同步时间失败:', error);
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

  async setPendingUpload(pending: boolean): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.PENDING_UPLOAD, pending);
    } catch (error) {
      console.error('设置 pending_upload 失败:', error);
    }
  }

  /**
   * 导入（JSON / OneTab）后把变更标记为待上传并请求一次调度上传。
   *
   * 为什么需要：导入只写本地 groups，不经过 mutationService，因此既不盖操作印记也
   * 不会置 pending_upload；而后台 alarm（backgroundSync）仅在 hasPending 为真时才
   * 上传 → 导入的会话会**永远只留在本地**（多设备下备份恢复承诺不成立）。
   *
   * 非扩展环境（网页版）没有 runtime.sendMessage，只置标志后静默返回。
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
      console.warn('[Storage] 导入后请求上传调度失败（下次后台轮询会重试）:', error);
    }
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
      console.error('设置 last_upload_time 失败:', error);
    }
  }

  // P1-6：purge 出队/入队。upload 成功删掉云端对应行后才 clear；失败保留下轮重试。
  async getPendingPurgeIds(): Promise<string[]> {
    try {
      await this.ensureVersion();
      const ids = await kvGet<unknown>(STORAGE_KEYS.PENDING_PURGE_IDS);
      return Array.isArray(ids) ? (ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  async addPendingPurgeId(id: string): Promise<void> {
    try {
      const ids = await this.getPendingPurgeIds();
      if (!ids.includes(id)) {
        await this.ensureVersion();
        await kvSet(STORAGE_KEYS.PENDING_PURGE_IDS, [...ids, id]);
      }
    } catch (error) {
      console.error('记录 pending_purge_ids 失败:', error);
    }
  }

  async clearPendingPurgeIds(): Promise<void> {
    try {
      await this.ensureVersion();
      await kvRemove(STORAGE_KEYS.PENDING_PURGE_IDS);
    } catch (error) {
      console.error('清除 pending_purge_ids 失败:', error);
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
      console.error('设置 device_seq 失败:', error);
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
      console.error('写 journal 失败:', error);
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
      console.error('设置 last_synced_seq 失败:', error);
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
      console.error('设置 op_stamp_migrated 失败:', error);
    }
  }

  // 获取同步前快照（合并失败时用于回滚）
  async getSyncSnapshot(): Promise<TabGroup[] | null> {
    try {
      await this.ensureVersion();
      const raw = await kvGet<unknown>(STORAGE_KEYS.SYNC_SNAPSHOT);
      return Array.isArray(raw) ? (raw as TabGroup[]) : null;
    } catch (error) {
      console.error('获取同步快照失败:', error);
      return null;
    }
  }

  // 保存同步前快照
  async setSyncSnapshot(groups: TabGroup[]): Promise<void> {
    try {
      await this.ensureVersion();
      await kvSet(STORAGE_KEYS.SYNC_SNAPSHOT, groups);
    } catch (error) {
      console.error('保存同步快照失败:', error);
    }
  }

  // 清除同步快照（合并成功后调用）
  async clearSyncSnapshot(): Promise<void> {
    try {
      await this.ensureVersion();
      await kvRemove(STORAGE_KEYS.SYNC_SNAPSHOT);
    } catch (error) {
      console.error('清除同步快照失败:', error);
    }
  }

  async getProductEvents(): Promise<Array<Record<string, unknown>>> {
    try {
      await this.ensureVersion();
      const events = await kvGet<unknown>(STORAGE_KEYS.PRODUCT_EVENTS);
      return Array.isArray(events) ? (events as Array<Record<string, unknown>>) : [];
    } catch (error) {
      console.error('获取产品事件失败:', error);
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
    const groups = await this.getGroups();
    const settings = await this.getSettings();

    return {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        groups,
        settings,
      }
    };
  }

  /**
   * 导出为 OneTab 格式
   * @returns OneTab 格式的导出文本
   */
  async exportToOneTabFormat(): Promise<string> {
    const groups = await this.getGroups();
    return formatToOneTabFormat(groups);
  }

  async importData(data: ExportData): Promise<boolean> {
    try {
      if (!data || !data.data || !Array.isArray(data.data.groups)) {
        throw new Error('无效的导入数据格式');
      }

      // 导入标签组，并按创建时间倒序排列
      const existingGroups = await this.getGroups();
      const allGroups = [...data.data.groups, ...existingGroups];
      // 按创建时间倒序排列，确保最新创建的标签组在前面
      const sortedGroups = allGroups.sort((a, b) => {
        const dateA = new Date(a.createdAt);
        const dateB = new Date(b.createdAt);
        return dateB.getTime() - dateA.getTime();
      });
      // SW/后台语境的导入走直写（与 mutation/TabManager 同一写路径），避免防抖
      // 窗口期内 SW 被挂起导致导入结果丢失。
      await this.setGroupsImmediate(sortedGroups);
      // 导入的数据必须能上云：导入只写本地 groups，不经过 mutationService（不盖印记、
      // 不置 pending_upload），而后台 alarm 仅在 pending_upload 为真时才上传。
      await this.markGroupsChangedByImport();

      // 如果有设置数据，则合并设置
      if (data.data.settings) {
        const currentSettings = await this.getSettings();
        await this.setSettings({
          ...currentSettings,
          ...data.data.settings
        });
      }

      return true;
    } catch (error) {
      console.error('导入数据失败:', error);
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

      // 导入标签组，并按创建时间倒序排列
      const existingGroups = await this.getGroups();
      const allGroups = [...parsedGroups, ...existingGroups];
      // 按创建时间倒序排列，确保最新创建的标签组在前面
      const sortedGroups = allGroups.sort((a, b) => {
        const dateA = new Date(a.createdAt);
        const dateB = new Date(b.createdAt);
        return dateB.getTime() - dateA.getTime();
      });
      // 同 importData：直写，防 SW 挂起丢导入结果。
      await this.setGroupsImmediate(sortedGroups);
      await this.markGroupsChangedByImport();

      return true;
    } catch (error) {
      console.error('从 OneTab 格式导入数据失败:', error);
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
        STORAGE_KEYS.DEVICE_SEQ,
        STORAGE_KEYS.JOURNAL,
        STORAGE_KEYS.LAST_SYNCED_SEQ,
        STORAGE_KEYS.OP_STAMP_MIGRATED,
      ];
      await Promise.all(keys.map(key => kvRemove(key)));
    } catch (error) {
      console.error('清除存储失败:', error);
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
      console.error('获取迁移标志失败:', error);
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
      console.error('设置迁移标志失败:', error);
      // 降级到普通存储
      try {
        const flags = await this.getMigrationFlags();
        flags[key] = value;
        await kvSet(STORAGE_KEYS.MIGRATION_FLAGS, flags);
      } catch (fallbackError) {
        console.error('降级存储也失败:', fallbackError);
      }
    }
  }
}

export const storage = new ChromeStorage();
