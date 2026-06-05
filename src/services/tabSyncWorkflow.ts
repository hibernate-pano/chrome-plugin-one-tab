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
  // 动态解析 storage 模块——避免在模块加载时绑定引用，
  // 这样测试环境 (mock.module + restoreAll) 可以为不同场景注入不同 mock，
  // 生产环境走的是 Vite 静态分析，import 仍然会被 tree-shake 命中，零成本。
  const { storage } = await import('@/utils/storage');

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

  // ── 安全网 0: 防止 race condition 用空数组覆盖本地存储 ─────────────────
  // 场景: popup 打开后 2 秒 maybeAutoDownload 触发, 但 loadGroups thunk
  // 还没把 storage 数据写回 Redux, 此时 tabsState.groups = []。如果再叠加
  // 云端返回 [], 合并结果就是 [], setGroups([]) 会清空本地存储——用户数据
  // 全部丢失。
  //
  // 检测: tabsState 为空但 storage 里有数据 → 跳过合并, 直接返回 storage
  // 中的数据, 不写 setGroups, 不写 setLastSyncTime (因为并没有真正同步
  // 任何东西, 把"刚检查过"的时间记下来反而会触发冷却窗口误判, 错过真正
  // 的下载机会)。
  if (
    localGroups.length === 0 &&
    cloudGroups.length === 0 &&
    !forceRemoteStrategy
  ) {
    try {
      const stored = await storage.getGroups();
      if (Array.isArray(stored) && stored.length > 0) {
        console.warn(
          `[sync] 检测到 race: tabsState 为空但 storage 有 ${stored.length} 个组, 跳过合并以保护本地数据`
        );
        reportIfNeeded(reportProgress, background, 100, 'none');
        return {
          groups: stored as TabGroup[],
          syncTime: new Date().toISOString(),
          stats: null,
        };
      }
    } catch (err) {
      console.warn('[sync] 读 storage 失败, 继续原合并流程:', err);
    }
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
    // ── 安全网 1: 云端空 + 本地空 = no-op ─────────────────────────────
    // 两边都没有数据, 跳过 setGroups 和 setLastSyncTime——这次同步什么都没
    // 发生, 不应该让"刚检查过"的时间戳污染冷却窗口, 也不应该写入空数组。
    if (cloudGroups.length === 0 && localGroups.length === 0) {
      console.log('[sync] 云端和本地都为空, 无需同步');
      reportIfNeeded(reportProgress, background, 100, 'none');
      return {
        groups: localGroups,
        syncTime: currentTime,
        stats: null,
      };
    }

    // ── 安全网 2: 云端空 + 本地有数据 = 保留本地 ───────────────────────
    // 这是"本地是 source of truth, 云端刚被清空"的情况 (例如另一台设备
    // 已经从云端删除了数据, 但本地还没来得及上传空集)。跳过 setGroups
    // 保留本地, 但仍然更新 lastSyncTime——因为这次确实去云端检查过了。
    if (cloudGroups.length === 0 && localGroups.length > 0) {
      console.log(
        '[sync] 云端为空但本地有数据, 保留本地作为 source of truth'
      );
      await storage.setLastSyncTime(currentTime);
      reportIfNeeded(reportProgress, background, 100, 'none');
      return {
        groups: localGroups,
        syncTime: currentTime,
        stats: null,
      };
    }

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
