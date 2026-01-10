/**
 * CRUD 操作的 Async Thunks
 * 处理标签组的创建、读取、更新、删除操作
 */

import { createAsyncThunk, nanoid } from '@reduxjs/toolkit';
import { TabGroup } from '@/types/tab';
import { storage } from '@/utils/storage';
import { updateGroupWithVersion } from '@/utils/versionHelper';
import { getActiveGroupsSorted, mergeAndSortGroups } from '@/utils/tabSortUtils';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import type { DeleteTabParams, CleanDuplicateResult } from './types';

/**
 * 加载所有标签组
 */
export const loadGroups = createAsyncThunk('tabs/loadGroups', async () => {
  const groups = await storage.getGroups();
  const sortedGroups = getActiveGroupsSorted(groups);

  console.log(
    `[LoadGroups] 加载 ${sortedGroups.length} 个活跃标签组（已过滤 ${groups.length - sortedGroups.length} 个已删除）`
  );

  return sortedGroups;
});

/**
 * 保存单个标签组
 */
export const saveGroup = createAsyncThunk('tabs/saveGroup', async (group: TabGroup) => {
  const groups = await storage.getGroups();
  const sortedGroups = mergeAndSortGroups(groups, [group]);
  await storage.setGroups(sortedGroups);

  return group;
});

/**
 * 更新标签组
 */
export const updateGroup = createAsyncThunk('tabs/updateGroup', async (group: TabGroup) => {
  const groups = await storage.getGroups();

  const updatedGroups = groups.map(g =>
    g.id === group.id ? updateGroupWithVersion(g, group) : g
  );

  await storage.setGroups(updatedGroups);

  return updatedGroups.find(g => g.id === group.id)!;
});

/**
 * 删除标签组（软删除）
 */
export const deleteGroup = createAsyncThunk('tabs/deleteGroup', async (groupId: string) => {
  const groups = await storage.getGroups();

  const updatedGroups = groups.map(g => {
    if (g.id === groupId) {
      const currentVersion = g.version || 1;
      return {
        ...g,
        isDeleted: true,
        version: currentVersion + 1,
        updatedAt: new Date().toISOString(),
      };
    }
    return g;
  });

  await storage.setGroups(updatedGroups);

  console.log(
    `[DeleteGroup] 软删除标签组: ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`
  );

  return groupId;
});

/**
 * 删除所有标签组
 */
export const deleteAllGroups = createAsyncThunk('tabs/deleteAllGroups', async () => {
  const groups = await storage.getGroups();

  if (groups.length === 0) {
    return { count: 0 };
  }

  await storage.setGroups([]);

  return { count: groups.length };
});

/**
 * 导入标签组
 */
export const importGroups = createAsyncThunk('tabs/importGroups', async (groups: TabGroup[]) => {
  const processedGroups = groups.map(group => ({
    ...group,
    id: nanoid(),
    tabs: group.tabs.map(tab => ({
      ...tab,
      id: nanoid(),
    })),
  }));

  const existingGroups = await storage.getGroups();
  const sortedGroups = mergeAndSortGroups(existingGroups, processedGroups);
  await storage.setGroups(sortedGroups);

  return processedGroups;
});

/**
 * 删除单个标签页
 */
export const deleteTabAndSync = createAsyncThunk<
  { group: TabGroup | null },
  DeleteTabParams,
  { state: unknown }
>('tabs/deleteTabAndSync', async ({ groupId, tabId }: DeleteTabParams) => {
  try {
    const groups = await storage.getGroups();
    const groupIndex = groups.findIndex(g => g.id === groupId);

    if (groupIndex !== -1) {
      const currentGroup = groups[groupIndex];

      if (shouldAutoDeleteAfterTabRemoval(currentGroup, tabId)) {
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await storage.setGroups(updatedGroups);

        console.log(`自动删除空标签组: ${currentGroup.name} (ID: ${groupId})`);
        return { group: null };
      } else {
        const updatedTabs = currentGroup.tabs.filter(tab => tab.id !== tabId);
        const currentVersion = currentGroup.version || 1;
        const updatedGroup = {
          ...currentGroup,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
          version: currentVersion + 1,
        };

        const updatedGroups = [...groups];
        updatedGroups[groupIndex] = updatedGroup;
        await storage.setGroups(updatedGroups);

        console.log(
          `从标签组删除标签页: ${currentGroup.name}, 剩余标签页: ${updatedTabs.length}`
        );
        return { group: updatedGroup };
      }
    }

    return { group: null };
  } catch (error) {
    console.error('删除标签页操作失败:', error);
    throw error;
  }
});

/**
 * 清理重复标签
 */
export const cleanDuplicateTabs = createAsyncThunk<CleanDuplicateResult>(
  'tabs/cleanDuplicateTabs',
  async () => {
    let originalGroups: TabGroup[] = [];

    try {
      originalGroups = await storage.getGroups();
      const groups = [...originalGroups];

      const urlMap = new Map<string, { tab: TabGroup['tabs'][0]; groupId: string }[]>();

      groups.forEach(group => {
        group.tabs.forEach(tab => {
          if (tab.url) {
            const urlKey = tab.url.startsWith('loading://')
              ? `${tab.url}|${tab.title}`
              : tab.url;

            if (!urlMap.has(urlKey)) {
              urlMap.set(urlKey, []);
            }
            urlMap.get(urlKey)?.push({ tab, groupId: group.id });
          }
        });
      });

      let removedTabsCount = 0;
      const updatedGroups = [...groups];

      urlMap.forEach(tabsWithSameUrl => {
        if (tabsWithSameUrl.length > 1) {
          tabsWithSameUrl.sort(
            (a, b) =>
              new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
          );

          for (let i = 1; i < tabsWithSameUrl.length; i++) {
            const { groupId, tab } = tabsWithSameUrl[i];
            const groupIndex = updatedGroups.findIndex(g => g.id === groupId);

            if (groupIndex !== -1) {
              updatedGroups[groupIndex].tabs = updatedGroups[groupIndex].tabs.filter(
                t => t.id !== tab.id
              );
              removedTabsCount++;

              const currentVersion = updatedGroups[groupIndex].version || 1;
              updatedGroups[groupIndex].updatedAt = new Date().toISOString();
              updatedGroups[groupIndex].version = currentVersion + 1;
            }
          }
        }
      });

      let removedGroupsCount = 0;
      const finalGroups = updatedGroups.filter(group => {
        if (group.tabs.length === 0 && !group.isLocked) {
          removedGroupsCount++;
          return false;
        }
        return true;
      });

      try {
        await storage.setGroups(finalGroups);
      } catch (storageError) {
        console.error('保存到本地存储失败，操作回滚:', storageError);
        throw new Error('保存失败，操作已取消');
      }

      return {
        removedTabsCount,
        removedGroupsCount,
        updatedGroups: finalGroups,
      };
    } catch (error) {
      console.error('清理重复标签和空标签组失败:', error);

      try {
        if (originalGroups.length > 0) {
          await storage.setGroups(originalGroups);
          console.log('已回滚到原始状态');
        }
      } catch (rollbackError) {
        console.error('回滚失败:', rollbackError);
      }

      throw error;
    }
  }
);
