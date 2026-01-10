/**
 * 存储服务 - 统一的本地存储访问层
 * 提供类型安全的存储操作接口
 */

import { TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';

export interface StorageService {
  // 标签组操作
  getGroups(): Promise<TabGroup[]>;
  setGroups(groups: TabGroup[]): Promise<void>;
  getGroup(id: string): Promise<TabGroup | undefined>;
  addGroup(group: TabGroup): Promise<void>;
  updateGroup(id: string, updates: Partial<TabGroup>): Promise<TabGroup | undefined>;
  deleteGroup(id: string): Promise<boolean>;

  // 设置操作
  getSettings(): Promise<UserSettings>;
  setSettings(settings: UserSettings): Promise<void>;
  updateSettings(updates: Partial<UserSettings>): Promise<UserSettings>;

  // 同步时间
  getLastSyncTime(): Promise<string | null>;
  setLastSyncTime(time: string): Promise<void>;

  // 批量操作
  clear(): Promise<void>;
  export(): Promise<{ groups: TabGroup[]; settings: UserSettings }>;
  import(data: { groups: TabGroup[]; settings?: UserSettings }): Promise<void>;
}

class StorageServiceImpl implements StorageService {
  // ==================== 标签组操作 ====================

  async getGroups(): Promise<TabGroup[]> {
    return storage.getGroups();
  }

  async setGroups(groups: TabGroup[]): Promise<void> {
    return storage.setGroups(groups);
  }

  async getGroup(id: string): Promise<TabGroup | undefined> {
    const groups = await this.getGroups();
    return groups.find(g => g.id === id);
  }

  async addGroup(group: TabGroup): Promise<void> {
    const groups = await this.getGroups();
    groups.unshift(group);
    await this.setGroups(groups);
  }

  async updateGroup(id: string, updates: Partial<TabGroup>): Promise<TabGroup | undefined> {
    const groups = await this.getGroups();
    const index = groups.findIndex(g => g.id === id);

    if (index === -1) return undefined;

    const updatedGroup: TabGroup = {
      ...groups[index],
      ...updates,
      updatedAt: new Date().toISOString(),
      version: (groups[index].version || 1) + 1,
    };

    groups[index] = updatedGroup;
    await this.setGroups(groups);

    return updatedGroup;
  }

  async deleteGroup(id: string): Promise<boolean> {
    const groups = await this.getGroups();
    const index = groups.findIndex(g => g.id === id);

    if (index === -1) return false;

    groups.splice(index, 1);
    await this.setGroups(groups);

    return true;
  }

  // ==================== 设置操作 ====================

  async getSettings(): Promise<UserSettings> {
    return storage.getSettings();
  }

  async setSettings(settings: UserSettings): Promise<void> {
    return storage.setSettings(settings);
  }

  async updateSettings(updates: Partial<UserSettings>): Promise<UserSettings> {
    const settings = await this.getSettings();
    const updatedSettings = { ...settings, ...updates };
    await this.setSettings(updatedSettings);
    return updatedSettings;
  }

  // ==================== 同步时间 ====================

  async getLastSyncTime(): Promise<string | null> {
    return storage.getLastSyncTime();
  }

  async setLastSyncTime(time: string): Promise<void> {
    return storage.setLastSyncTime(time);
  }

  // ==================== 批量操作 ====================

  async clear(): Promise<void> {
    await this.setGroups([]);
  }

  async export(): Promise<{ groups: TabGroup[]; settings: UserSettings }> {
    const [groups, settings] = await Promise.all([this.getGroups(), this.getSettings()]);
    return { groups, settings };
  }

  async import(data: { groups: TabGroup[]; settings?: UserSettings }): Promise<void> {
    const promises: Promise<void>[] = [this.setGroups(data.groups)];

    if (data.settings) {
      promises.push(this.setSettings(data.settings));
    }

    await Promise.all(promises);
  }
}

// 导出单例
export const storageService = new StorageServiceImpl();
