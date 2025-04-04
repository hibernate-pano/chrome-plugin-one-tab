import { TabGroup, UserSettings } from '@/types/tab';

const STORAGE_KEYS = {
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings'
};

// 默认设置
const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  autoSave: false,
  autoSaveInterval: 5,
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  autoCloseTabsAfterSaving: true,
  confirmBeforeDelete: true,
};

export const defaultSettings: UserSettings = {
  theme: 'system',
  autoCloseTabsAfterSaving: true,
  autoSave: false,
  autoSaveInterval: 5,
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
};

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

  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
    } catch (error) {
      console.error('清除存储失败:', error);
    }
  }
}

export const storage = new ChromeStorage(); 