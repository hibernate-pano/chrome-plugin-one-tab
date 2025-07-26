import { TabGroup, UserSettings, Tab } from '@/types/tab';
import { parseOneTabFormat, formatToOneTabFormat } from './oneTabFormatParser';

const STORAGE_KEYS = {
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings',
  DELETED_GROUPS: 'deleted_tab_groups', // 存储已删除的标签组
  DELETED_TABS: 'deleted_tabs', // 存储已删除的标签页
  LAST_SYNC_TIME: 'last_sync_time', // 存储最后同步时间
  MIGRATION_FLAGS: 'migration_flags' // 存储迁移标志
};

// 默认设置
export const DEFAULT_SETTINGS: UserSettings = {
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false, // 默认不允许重复标签页
  syncEnabled: true, // 默认启用同步
  useDoubleColumnLayout: true, // 默认使用双栏布局
  showNotifications: false, // 默认关闭通知
  syncStrategy: 'newest', // 默认使用最新版本
  deleteStrategy: 'everywhere', // 默认在所有设备上删除
  themeMode: 'auto', // 默认使用自动模式（跟随系统）
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
  async getGroups(): Promise<TabGroup[]> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
      return result[STORAGE_KEYS.GROUPS] || [];
    } catch (error) {
      console.error('获取标签组失败:', error);
      return [];
    }
  }

  async setGroups(groups: TabGroup[]): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.GROUPS]: groups
      });
    } catch (error) {
      console.error('保存标签组失败:', error);
    }
  }

  async getSettings(): Promise<UserSettings> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
      return {
        ...DEFAULT_SETTINGS,
        ...result[STORAGE_KEYS.SETTINGS]
      };
    } catch (error) {
      console.error('获取设置失败:', error);
      return DEFAULT_SETTINGS;
    }
  }

  async setSettings(settings: UserSettings): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: settings
      });
    } catch (error) {
      console.error('保存设置失败:', error);
    }
  }

  // 新增：获取已删除的标签组
  async getDeletedGroups(): Promise<TabGroup[]> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.DELETED_GROUPS);
      return result[STORAGE_KEYS.DELETED_GROUPS] || [];
    } catch (error) {
      console.error('获取已删除标签组失败:', error);
      return [];
    }
  }

  // 新增：设置已删除的标签组
  async setDeletedGroups(groups: TabGroup[]): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.DELETED_GROUPS]: groups
      });
    } catch (error) {
      console.error('设置已删除标签组失败:', error);
    }
  }

  // 新增：获取已删除的标签页
  async getDeletedTabs(): Promise<Tab[]> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.DELETED_TABS);
      return result[STORAGE_KEYS.DELETED_TABS] || [];
    } catch (error) {
      console.error('获取已删除标签页失败:', error);
      return [];
    }
  }

  // 新增：设置已删除的标签页
  async setDeletedTabs(tabs: Tab[]): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.DELETED_TABS]: tabs
      });
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
      const result = await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC_TIME);
      return result[STORAGE_KEYS.LAST_SYNC_TIME] || null;
    } catch (error) {
      console.error('获取最后同步时间失败:', error);
      return null;
    }
  }

  // 设置最后同步时间
  async setLastSyncTime(time: string): Promise<void> {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.LAST_SYNC_TIME]: time
      });
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
      await chrome.storage.local.clear();
    } catch (error) {
      console.error('清除存储失败:', error);
    }
  }

  // 迁移标志相关方法
  async getMigrationFlags(): Promise<Record<string, boolean>> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.MIGRATION_FLAGS);
      return result[STORAGE_KEYS.MIGRATION_FLAGS] || {};
    } catch (error) {
      console.error('获取迁移标志失败:', error);
      return {};
    }
  }

  async setMigrationFlag(key: string, value: boolean): Promise<void> {
    try {
      const flags = await this.getMigrationFlags();
      flags[key] = value;
      await chrome.storage.local.set({
        [STORAGE_KEYS.MIGRATION_FLAGS]: flags
      });
    } catch (error) {
      console.error('设置迁移标志失败:', error);
    }
  }
}

export const storage = new ChromeStorage();