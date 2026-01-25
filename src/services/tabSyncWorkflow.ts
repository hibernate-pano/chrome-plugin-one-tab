import type { TabGroup, TabState, UserSettings } from '@/types/tab';
import { downloadTabGroups, uploadTabGroups } from '@/services/tabGroupSyncService';
import { storage } from '@/utils/storage';
import { mergeTabGroups } from '@/utils/syncUtils';

type SyncOperation = 'upload' | 'download' | 'none';
export type SyncProgressReporter = (progress: number, operation: SyncOperation) => void;

interface UploadTabsOptions {
  auth: { isAuthenticated: boolean };
  tabsState: TabState;
  background?: boolean;
  overwriteCloud?: boolean;
  reportProgress?: SyncProgressReporter;
}

interface DownloadTabsOptions {
  auth: { isAuthenticated: boolean };
  tabsState: TabState;
  settings: UserSettings;
  background?: boolean;
  forceRemoteStrategy?: boolean;
  reportProgress?: SyncProgressReporter;
}

const reportIfNeeded = (
  reportProgress: SyncProgressReporter | undefined,
  background: boolean,
  progress: number,
  operation: SyncOperation
) => {
  if (!background) {
    reportProgress?.(progress, operation);
  }
};

export async function uploadTabsToCloudFlow({
  auth,
  tabsState,
  background = false,
  overwriteCloud = false,
  reportProgress,
}: UploadTabsOptions): Promise<{ syncTime: string; stats: any | null }> {
  // 检查用户是否已登录
  if (!auth.isAuthenticated) {
    console.log('用户未登录，无法同步数据到云端');
    return {
      syncTime: new Date().toISOString(),
      stats: null,
    };
  }

  // 记录同步模式和覆盖模式
  console.log(
    `开始${background ? '后台' : ''}同步标签组到云端${overwriteCloud ? '（覆盖模式）' : '（合并模式）'}...`
  );

  reportIfNeeded(reportProgress, background, 0, 'upload');

  // 检查是否有标签组需要同步
  if (!tabsState.groups || tabsState.groups.length === 0) {
    console.log('没有标签组需要同步');
    reportIfNeeded(reportProgress, background, 100, 'none');
    return {
      syncTime: tabsState.lastSyncTime || new Date().toISOString(),
      stats: tabsState.compressionStats,
    };
  }

  const groupsToSync = tabsState.groups;

  if (groupsToSync.length === 0) {
    console.log('没有需要同步的标签组');
    reportIfNeeded(reportProgress, background, 100, 'none');
    return {
      syncTime: tabsState.lastSyncTime || new Date().toISOString(),
      stats: tabsState.compressionStats,
    };
  }

  console.log(`将同步 ${groupsToSync.length} 个标签组到云端`);
  reportIfNeeded(reportProgress, background, 20, 'upload');

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

  reportIfNeeded(reportProgress, background, 50, 'upload');

  await uploadTabGroups(validGroups, overwriteCloud);

  reportIfNeeded(reportProgress, background, 70, 'upload');

  const updatedGroups = tabsState.groups.map(group => {
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

  reportIfNeeded(reportProgress, background, 100, 'none');

  return {
    syncTime: currentTime,
    stats: null,
  };
}

export async function downloadTabsFromCloudFlow({
  auth,
  tabsState,
  settings,
  background = false,
  forceRemoteStrategy = false,
  reportProgress,
}: DownloadTabsOptions): Promise<{ groups: TabGroup[]; syncTime: string; stats: any | null }> {
  if (!auth.isAuthenticated) {
    console.log('用户未登录，无法从云端同步数据');
    return {
      groups: tabsState.groups,
      syncTime: new Date().toISOString(),
      stats: null,
    };
  }

  reportIfNeeded(reportProgress, background, 0, 'download');

  const result = await downloadTabGroups();

  reportIfNeeded(reportProgress, background, 30, 'download');

  const cloudGroups = result as TabGroup[];
  let localGroups = tabsState.groups;

  console.log('云端标签组数量:', cloudGroups.length);
  console.log('本地标签组数量:', localGroups.length);

  if (forceRemoteStrategy) {
    console.log('覆盖模式: 清空本地数据，只使用云端数据');
    localGroups = [];
  }

  console.log('云端标签组详情:');
  let totalCloudTabs = 0;
  cloudGroups.forEach((group, index) => {
    const tabCount = group.tabs.length;
    totalCloudTabs += tabCount;
    console.log(
      `[${index + 1}/${cloudGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`
    );

    group.tabs.forEach((tab, tabIndex) => {
      console.log(
        `  - 云端标签 [${tabIndex + 1}/${tabCount}]: ID=${tab.id}, 标题="${tab.title}", URL=${tab.url}`
      );
    });
  });
  console.log(`云端总标签数: ${totalCloudTabs}`);

  console.log('本地标签组详情:');
  let totalLocalTabs = 0;
  localGroups.forEach((group, index) => {
    const tabCount = group.tabs.length;
    totalLocalTabs += tabCount;
    console.log(
      `[${index + 1}/${localGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`
    );
  });
  console.log(`本地总标签数: ${totalLocalTabs}`);

  reportIfNeeded(reportProgress, background, 50, 'download');

  const currentTime = new Date().toISOString();
  let mergedGroups: TabGroup[];

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

  reportIfNeeded(reportProgress, background, 70, 'download');

  await storage.setGroups(mergedGroups);

  reportIfNeeded(reportProgress, background, 90, 'download');

  await storage.setLastSyncTime(currentTime);

  const hasConflicts = mergedGroups.some(group => group.syncStatus === 'conflict');
  if (hasConflicts && settings.syncStrategy === 'ask') {
    console.log('检测到数据冲突，需要用户解决');
  }

  reportIfNeeded(reportProgress, background, 100, 'none');

  return {
    groups: mergedGroups,
    syncTime: currentTime,
    stats: null,
  };
}
