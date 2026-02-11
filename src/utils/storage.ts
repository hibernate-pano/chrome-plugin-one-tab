import { TabGroup, UserSettings, Tab, LayoutMode, ThemeStyle } from '@/types/tab';
import { parseOneTabFormat, formatToOneTabFormat } from './oneTabFormatParser';
import { secureStorage } from './secureStorage';
import { kvGet, kvSet, kvRemove } from '@/storage/storageAdapter';
import { cacheManager, cachedAsyncFn, debounceAsync } from './performance';

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

const STORAGE_KEYS = {
  VERSION: 'storage_version',
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings',
  DELETED_GROUPS: 'deleted_tab_groups',
  DELETED_TABS: 'deleted_tabs',
  LAST_SYNC_TIME: 'last_sync_time',
  MIGRATION_FLAGS: 'migration_flags'
};

const STORAGE_VERSION = 2;

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

  async exportData(): Promise<ExportData> {
    const groups = await this.getGroups();
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
      await this.setGroups(sortedGroups);

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
      await this.setGroups(sortedGroups);

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
        STORAGE_KEYS.MIGRATION_FLAGS
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