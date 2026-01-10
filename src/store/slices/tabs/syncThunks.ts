/**
 * 同步操作的 Async Thunks
 * 处理云端同步相关的所有操作
 */

import { createAsyncThunk, ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import { TabGroup } from '@/types/tab';
import { storage } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';
import { mergeTabGroups } from '@/utils/syncUtils';
import { updateGroupWithVersion } from '@/utils/versionHelper';
import type {
  SyncToCloudOptions,
  SyncFromCloudOptions,
  SyncToCloudResult,
  SyncFromCloudResult,
  RootState,
  UpdateGroupNameParams,
} from './types';
import { updateGroupName, toggleGroupLock, updateSyncProgress } from './reducers';

type AppDispatch = ThunkDispatch<unknown, unknown, UnknownAction>;

/**
 * 同步标签组到云端
 */
export const syncTabsToCloud = createAsyncThunk<
  SyncToCloudResult,
  SyncToCloudOptions | void,
  { state: RootState }
>('tabs/syncTabsToCloud', async (options, { getState, dispatch }) => {
  const background = options?.background || false;
  const overwriteCloud = options?.overwriteCloud || false;

  try {
    await new Promise(resolve => setTimeout(resolve, 10));

    const { auth, tabs } = getState();

    if (!auth.isAuthenticated) {
      console.log('用户未登录，无法同步数据到云端');
      return {
        syncTime: new Date().toISOString(),
        stats: null,
      };
    }

    console.log(
      `开始${background ? '后台' : ''}同步标签组到云端${overwriteCloud ? '（覆盖模式）' : '（合并模式）'}...`
    );

    if (!background) {
      dispatch(updateSyncProgress({ progress: 0, operation: 'upload' }));
    }

    if (!tabs.groups || tabs.groups.length === 0) {
      console.log('没有标签组需要同步');
      if (!background) {
        dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
      }
      return {
        syncTime: tabs.lastSyncTime || new Date().toISOString(),
        stats: null,
      };
    }

    const groupsToSync = tabs.groups;

    if (groupsToSync.length === 0) {
      console.log('没有需要同步的标签组');
      if (!background) {
        dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
      }
      return {
        syncTime: tabs.lastSyncTime || new Date().toISOString(),
        stats: null,
      };
    }

    console.log(`将同步 ${groupsToSync.length} 个标签组到云端`);

    if (!background) {
      dispatch(updateSyncProgress({ progress: 20, operation: 'upload' }));
    }

    const currentTime = new Date().toISOString();
    const validGroups = groupsToSync.map(group => ({
      ...group,
      createdAt: group.createdAt || currentTime,
      updatedAt: group.updatedAt || currentTime,
      isLocked: typeof group.isLocked === 'boolean' ? group.isLocked : false,
      lastSyncedAt: currentTime,
      tabs: group.tabs.map(tab => ({
        ...tab,
        createdAt: tab.createdAt || currentTime,
        lastAccessed: tab.lastAccessed || currentTime,
        lastSyncedAt: currentTime,
      })),
    }));

    if (!background) {
      dispatch(updateSyncProgress({ progress: 50, operation: 'upload' }));
    }

    await supabaseSync.uploadTabGroups(validGroups, overwriteCloud);

    if (!background) {
      dispatch(updateSyncProgress({ progress: 70, operation: 'upload' }));
    }

    const updatedGroups = tabs.groups.map(group => {
      const syncedGroup = validGroups.find(g => g.id === group.id && !g.isDeleted);
      if (syncedGroup) {
        return {
          ...group,
          lastSyncedAt: currentTime,
          syncStatus: 'synced' as const,
        };
      }
      return group;
    });

    await storage.setGroups(updatedGroups as TabGroup[]);
    await storage.setLastSyncTime(currentTime);

    if (!background) {
      dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
    }

    return {
      syncTime: currentTime,
      stats: null,
    };
  } catch (error) {
    console.error('同步标签组到云端失败:', error);
    throw error;
  }
});

/**
 * 从云端同步标签组
 */
export const syncTabsFromCloud = createAsyncThunk<
  SyncFromCloudResult,
  SyncFromCloudOptions | void,
  { state: RootState }
>('tabs/syncTabsFromCloud', async (options, { getState, dispatch }) => {
  const background = options?.background || false;
  const forceRemoteStrategy = options?.forceRemoteStrategy || false;

  try {
    await new Promise(resolve => setTimeout(resolve, 10));

    const { auth, tabs, settings } = getState();

    if (!auth.isAuthenticated) {
      console.log('用户未登录，无法从云端同步数据');
      return {
        groups: tabs.groups,
        syncTime: new Date().toISOString(),
        stats: null,
      };
    }

    if (!background) {
      dispatch(updateSyncProgress({ progress: 0, operation: 'download' }));
    }

    const result = await supabaseSync.downloadTabGroups();

    if (!background) {
      dispatch(updateSyncProgress({ progress: 30, operation: 'download' }));
    }

    const cloudGroups = result as TabGroup[];
    let localGroups = tabs.groups;

    console.log('云端标签组数量:', cloudGroups.length);
    console.log('本地标签组数量:', localGroups.length);

    if (forceRemoteStrategy) {
      console.log('覆盖模式: 清空本地数据，只使用云端数据');
      localGroups = [];
    }

    logGroupDetails('云端', cloudGroups);
    logGroupDetails('本地', localGroups);

    if (!background) {
      dispatch(updateSyncProgress({ progress: 50, operation: 'download' }));
    }

    const currentTime = new Date().toISOString();
    let mergedGroups;

    if (forceRemoteStrategy) {
      mergedGroups = cloudGroups.map(group => ({
        ...group,
        syncStatus: 'synced' as const,
        lastSyncedAt: currentTime,
      }));
    } else {
      const syncStrategy = settings.syncStrategy;
      mergedGroups = mergeTabGroups(localGroups, cloudGroups, syncStrategy);
    }

    if (!background) {
      dispatch(updateSyncProgress({ progress: 70, operation: 'download' }));
    }

    await storage.setGroups(mergedGroups);

    if (!background) {
      dispatch(updateSyncProgress({ progress: 90, operation: 'download' }));
    }

    await storage.setLastSyncTime(currentTime);

    const hasConflicts = mergedGroups.some(group => group.syncStatus === 'conflict');

    if (hasConflicts && settings.syncStrategy === 'ask') {
      console.log('检测到数据冲突，需要用户解决');
    }

    if (!background) {
      dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
    }

    return {
      groups: mergedGroups,
      syncTime: currentTime,
      stats: null,
    };
  } catch (error) {
    console.error('从云端同步标签组失败:', error);
    throw error;
  }
});

/**
 * 检查登录状态（用于同步检查）
 */
export const syncLocalChangesToCloud = createAsyncThunk<boolean, void, { state: RootState }>(
  'tabs/syncLocalChangesToCloud',
  async (_, { getState }) => {
    const { auth } = getState();
    return auth.isAuthenticated;
  }
);

/**
 * 更新标签组名称并同步到云端
 */
export const updateGroupNameAndSync = createAsyncThunk<
  UpdateGroupNameParams,
  UpdateGroupNameParams
>('tabs/updateGroupNameAndSync', async ({ groupId, name }, { dispatch }) => {
  const typedDispatch = dispatch as AppDispatch;
  typedDispatch(updateGroupName({ groupId, name }));

  const groups = await storage.getGroups();
  const updatedGroups = groups.map(g => {
    if (g.id === groupId) {
      return updateGroupWithVersion(g, { name });
    }
    return g;
  });
  await storage.setGroups(updatedGroups);

  console.log(
    `[UpdateGroupName] 更新标签组 ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`
  );

  return { groupId, name };
});

/**
 * 切换标签组锁定状态并同步到云端
 */
export const toggleGroupLockAndSync = createAsyncThunk<
  { groupId: string; isLocked: boolean },
  string
>('tabs/toggleGroupLockAndSync', async (groupId, { dispatch }) => {
  const typedDispatch = dispatch as AppDispatch;
  typedDispatch(toggleGroupLock(groupId));

  const groups = await storage.getGroups();
  const group = groups.find(g => g.id === groupId);

  if (group) {
    const updatedGroup = updateGroupWithVersion(group, {
      isLocked: !group.isLocked,
    });

    const updatedGroups = groups.map(g => (g.id === groupId ? updatedGroup : g));
    await storage.setGroups(updatedGroups);

    console.log(`[ToggleLock] 切换锁定状态 ${groupId}, 新版本: ${updatedGroup.version}`);

    return { groupId, isLocked: updatedGroup.isLocked };
  }

  return { groupId, isLocked: false };
});

/**
 * 辅助函数：记录标签组详情
 */
function logGroupDetails(source: string, groups: TabGroup[]) {
  console.log(`${source}标签组详情:`);
  let totalTabs = 0;
  groups.forEach((group, index) => {
    const tabCount = group.tabs.length;
    totalTabs += tabCount;
    console.log(
      `[${index + 1}/${groups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`
    );
  });
  console.log(`${source}总标签数: ${totalTabs}`);
}
