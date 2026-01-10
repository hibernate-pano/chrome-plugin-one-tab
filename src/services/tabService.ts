/**
 * 标签页服务 - 统一的标签页管理层
 * 提供标签页和标签组的业务逻辑操作
 */

import { TabGroup, Tab } from '@/types/tab';
import { nanoid } from '@reduxjs/toolkit';
import { storageService } from './storageService';

export interface TabService {
  // 标签组操作
  createGroup(name: string, tabs?: Tab[]): Promise<TabGroup>;
  renameGroup(groupId: string, name: string): Promise<TabGroup | undefined>;
  lockGroup(groupId: string): Promise<TabGroup | undefined>;
  unlockGroup(groupId: string): Promise<TabGroup | undefined>;
  toggleGroupLock(groupId: string): Promise<TabGroup | undefined>;
  deleteGroup(groupId: string, soft?: boolean): Promise<boolean>;

  // 标签页操作
  addTab(groupId: string, tab: Omit<Tab, 'id' | 'createdAt' | 'lastAccessed'>): Promise<Tab | undefined>;
  removeTab(groupId: string, tabId: string): Promise<boolean>;
  moveTab(sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number): Promise<boolean>;

  // 批量操作
  removeDuplicateTabs(): Promise<{ removedTabs: number; removedGroups: number }>;
  removeEmptyGroups(): Promise<number>;
  mergeGroups(groupIds: string[], newName?: string): Promise<TabGroup | undefined>;

  // 查询操作
  searchTabs(query: string): Promise<{ group: TabGroup; tab: Tab }[]>;
  getTabsByDomain(domain: string): Promise<{ group: TabGroup; tab: Tab }[]>;
}

class TabServiceImpl implements TabService {
  // ==================== 标签组操作 ====================

  async createGroup(name: string, tabs: Tab[] = []): Promise<TabGroup> {
    const now = new Date().toISOString();
    const group: TabGroup = {
      id: nanoid(),
      name,
      tabs: tabs.map(tab => ({
        ...tab,
        id: tab.id || nanoid(),
        createdAt: tab.createdAt || now,
        lastAccessed: tab.lastAccessed || now,
      })),
      createdAt: now,
      updatedAt: now,
      isLocked: false,
      version: 1,
    };

    await storageService.addGroup(group);
    return group;
  }

  async renameGroup(groupId: string, name: string): Promise<TabGroup | undefined> {
    return storageService.updateGroup(groupId, { name });
  }

  async lockGroup(groupId: string): Promise<TabGroup | undefined> {
    return storageService.updateGroup(groupId, { isLocked: true });
  }

  async unlockGroup(groupId: string): Promise<TabGroup | undefined> {
    return storageService.updateGroup(groupId, { isLocked: false });
  }

  async toggleGroupLock(groupId: string): Promise<TabGroup | undefined> {
    const group = await storageService.getGroup(groupId);
    if (!group) return undefined;
    return storageService.updateGroup(groupId, { isLocked: !group.isLocked });
  }

  async deleteGroup(groupId: string, soft = true): Promise<boolean> {
    if (soft) {
      const result = await storageService.updateGroup(groupId, { isDeleted: true } as Partial<TabGroup>);
      return !!result;
    }
    return storageService.deleteGroup(groupId);
  }

  // ==================== 标签页操作 ====================

  async addTab(
    groupId: string,
    tabData: Omit<Tab, 'id' | 'createdAt' | 'lastAccessed'>
  ): Promise<Tab | undefined> {
    const group = await storageService.getGroup(groupId);
    if (!group) return undefined;

    const now = new Date().toISOString();
    const tab: Tab = {
      ...tabData,
      id: nanoid(),
      createdAt: now,
      lastAccessed: now,
    };

    const updatedTabs = [...group.tabs, tab];
    await storageService.updateGroup(groupId, { tabs: updatedTabs });

    return tab;
  }

  async removeTab(groupId: string, tabId: string): Promise<boolean> {
    const group = await storageService.getGroup(groupId);
    if (!group) return false;

    const updatedTabs = group.tabs.filter(t => t.id !== tabId);

    // 如果标签组为空且未锁定，删除整个标签组
    if (updatedTabs.length === 0 && !group.isLocked) {
      return storageService.deleteGroup(groupId);
    }

    await storageService.updateGroup(groupId, { tabs: updatedTabs });
    return true;
  }

  async moveTab(
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number
  ): Promise<boolean> {
    const groups = await storageService.getGroups();
    const sourceGroup = groups.find(g => g.id === sourceGroupId);
    const targetGroup = groups.find(g => g.id === targetGroupId);

    if (!sourceGroup || !targetGroup) return false;
    if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) return false;

    const tab = sourceGroup.tabs[sourceIndex];

    // 从源组移除
    const newSourceTabs = [...sourceGroup.tabs];
    newSourceTabs.splice(sourceIndex, 1);

    // 添加到目标组
    const newTargetTabs = sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];
    const safeIndex = Math.max(0, Math.min(targetIndex, newTargetTabs.length));
    newTargetTabs.splice(safeIndex, 0, tab);

    // 更新组
    const now = new Date().toISOString();
    const updatedGroups = groups.map(g => {
      if (g.id === sourceGroupId) {
        return { ...g, tabs: newSourceTabs, updatedAt: now };
      }
      if (g.id === targetGroupId && sourceGroupId !== targetGroupId) {
        return { ...g, tabs: newTargetTabs, updatedAt: now };
      }
      return g;
    });

    // 移除空的未锁定组
    const finalGroups = updatedGroups.filter(g => g.tabs.length > 0 || g.isLocked);

    await storageService.setGroups(finalGroups);
    return true;
  }

  // ==================== 批量操作 ====================

  async removeDuplicateTabs(): Promise<{ removedTabs: number; removedGroups: number }> {
    const groups = await storageService.getGroups();
    const urlMap = new Map<string, { tab: Tab; groupId: string; groupIndex: number; tabIndex: number }[]>();

    // 收集所有标签页
    groups.forEach((group, groupIndex) => {
      group.tabs.forEach((tab, tabIndex) => {
        if (tab.url) {
          const key = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
          if (!urlMap.has(key)) {
            urlMap.set(key, []);
          }
          urlMap.get(key)!.push({ tab, groupId: group.id, groupIndex, tabIndex });
        }
      });
    });

    // 标记要删除的标签页
    const tabsToRemove = new Set<string>();
    urlMap.forEach(tabs => {
      if (tabs.length > 1) {
        // 按最后访问时间排序，保留最新的
        tabs.sort((a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime());
        for (let i = 1; i < tabs.length; i++) {
          tabsToRemove.add(`${tabs[i].groupId}:${tabs[i].tab.id}`);
        }
      }
    });

    // 更新标签组
    let removedTabs = 0;
    const updatedGroups = groups.map(group => {
      const originalLength = group.tabs.length;
      const newTabs = group.tabs.filter(tab => !tabsToRemove.has(`${group.id}:${tab.id}`));
      removedTabs += originalLength - newTabs.length;
      return { ...group, tabs: newTabs, updatedAt: new Date().toISOString() };
    });

    // 移除空的未锁定组
    const finalGroups = updatedGroups.filter(g => g.tabs.length > 0 || g.isLocked);
    const removedGroups = updatedGroups.length - finalGroups.length;

    await storageService.setGroups(finalGroups);

    return { removedTabs, removedGroups };
  }

  async removeEmptyGroups(): Promise<number> {
    const groups = await storageService.getGroups();
    const nonEmptyGroups = groups.filter(g => g.tabs.length > 0 || g.isLocked);
    const removedCount = groups.length - nonEmptyGroups.length;

    if (removedCount > 0) {
      await storageService.setGroups(nonEmptyGroups);
    }

    return removedCount;
  }

  async mergeGroups(groupIds: string[], newName?: string): Promise<TabGroup | undefined> {
    const groups = await storageService.getGroups();
    const groupsToMerge = groups.filter(g => groupIds.includes(g.id));

    if (groupsToMerge.length < 2) return undefined;

    // 合并所有标签页
    const allTabs = groupsToMerge.flatMap(g => g.tabs);

    // 创建新组
    const now = new Date().toISOString();
    const mergedGroup: TabGroup = {
      id: nanoid(),
      name: newName || groupsToMerge[0].name,
      tabs: allTabs,
      createdAt: now,
      updatedAt: now,
      isLocked: groupsToMerge.some(g => g.isLocked),
      version: 1,
    };

    // 移除旧组，添加新组
    const remainingGroups = groups.filter(g => !groupIds.includes(g.id));
    remainingGroups.unshift(mergedGroup);

    await storageService.setGroups(remainingGroups);

    return mergedGroup;
  }

  // ==================== 查询操作 ====================

  async searchTabs(query: string): Promise<{ group: TabGroup; tab: Tab }[]> {
    const groups = await storageService.getGroups();
    const results: { group: TabGroup; tab: Tab }[] = [];
    const lowerQuery = query.toLowerCase();

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (
          tab.title.toLowerCase().includes(lowerQuery) ||
          tab.url.toLowerCase().includes(lowerQuery)
        ) {
          results.push({ group, tab });
        }
      });
    });

    return results;
  }

  async getTabsByDomain(domain: string): Promise<{ group: TabGroup; tab: Tab }[]> {
    const groups = await storageService.getGroups();
    const results: { group: TabGroup; tab: Tab }[] = [];

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        try {
          const url = new URL(tab.url);
          if (url.hostname.includes(domain)) {
            results.push({ group, tab });
          }
        } catch {
          // 忽略无效 URL
        }
      });
    });

    return results;
  }
}

// 导出单例
export const tabService = new TabServiceImpl();
