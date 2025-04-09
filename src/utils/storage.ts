import { TabGroup, UserSettings } from '@/types/tab';

const STORAGE_KEYS = {
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings'
};

// 默认设置
export const DEFAULT_SETTINGS: UserSettings = {
  autoSave: false,
  autoSaveInterval: 5,
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  autoCloseTabsAfterSaving: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false, // 默认不允许重复标签页
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

  async importData(data: ExportData): Promise<boolean> {
    try {
      if (!data || !data.data || !Array.isArray(data.data.groups)) {
        throw new Error('无效的导入数据格式');
      }

      // 导入标签组
      const existingGroups = await this.getGroups();
      await this.setGroups([...data.data.groups, ...existingGroups]);

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

  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
    } catch (error) {
      console.error('清除存储失败:', error);
    }
  }
}

export const storage = new ChromeStorage();