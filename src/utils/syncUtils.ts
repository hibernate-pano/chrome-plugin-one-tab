import { TabGroup, Tab, UserSettings } from '@/types/tab';

/**
 * 智能合并本地和云端标签组
 * @param localGroups 本地标签组
 * @param cloudGroups 云端标签组
 * @param syncStrategy 同步策略
 * @returns 合并后的标签组
 */
export const mergeTabGroups = (
  localGroups: TabGroup[],
  cloudGroups: TabGroup[],
  syncStrategy: UserSettings['syncStrategy'] = 'newest',
  deletedGroups: TabGroup[] = []
): TabGroup[] => {
  // 创建一个映射，以标签组ID为键
  const mergedGroupsMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();

  // 处理已删除的标签组，创建删除标记映射
  const deletedGroupIds = new Set<string>();
  deletedGroups.forEach(group => {
    if (group.isDeleted) {
      deletedGroupIds.add(group.id);
    }
  });

  // 处理本地标签组
  localGroups.forEach(localGroup => {
    // 如果标签组已被删除，则跳过
    if (deletedGroupIds.has(localGroup.id)) {
      return;
    }

    // 标记本地独有的标签组
    const group = {
      ...localGroup,
      syncStatus: 'local-only' as const,
      lastSyncedAt: null
    };
    mergedGroupsMap.set(localGroup.id, group);
  });

  // 处理云端标签组
  cloudGroups.forEach(cloudGroup => {
    // 如果标签组已被删除，则跳过
    if (deletedGroupIds.has(cloudGroup.id) || cloudGroup.isDeleted) {
      return;
    }

    const localGroup = mergedGroupsMap.get(cloudGroup.id);

    if (!localGroup) {
      // 云端独有的标签组
      const group = {
        ...cloudGroup,
        syncStatus: 'remote-only' as const,
        lastSyncedAt: currentTime
      };
      mergedGroupsMap.set(cloudGroup.id, group);
    } else {
      // 本地和云端都有的标签组，需要合并
      const mergedGroup = mergeGroup(localGroup, cloudGroup, syncStrategy);
      mergedGroupsMap.set(cloudGroup.id, mergedGroup);
    }
  });

  // 将映射转换回数组
  return Array.from(mergedGroupsMap.values())
    // 过滤掉已删除的标签组
    .filter(group => !group.isDeleted && !deletedGroupIds.has(group.id));
};

/**
 * 合并两个标签组
 * @param localGroup 本地标签组
 * @param cloudGroup 云端标签组
 * @param syncStrategy 同步策略
 * @returns 合并后的标签组
 */
const mergeGroup = (
  localGroup: TabGroup,
  cloudGroup: TabGroup,
  syncStrategy: UserSettings['syncStrategy']
): TabGroup => {
  const currentTime = new Date().toISOString();

  // 检查是否有冲突（两边都修改了）
  const localUpdatedAt = new Date(localGroup.updatedAt).getTime();
  const cloudUpdatedAt = new Date(cloudGroup.updatedAt).getTime();
  const hasConflict = localUpdatedAt > 0 && cloudUpdatedAt > 0 &&
    localGroup.lastSyncedAt !== cloudGroup.updatedAt;

  // 根据同步策略决定如何合并
  if (hasConflict) {
    switch (syncStrategy) {
      case 'newest':
        // 使用更新时间较新的版本
        if (localUpdatedAt > cloudUpdatedAt) {
          return {
            ...localGroup,
            syncStatus: 'synced',
            lastSyncedAt: currentTime
          };
        } else {
          return {
            ...cloudGroup,
            syncStatus: 'synced',
            lastSyncedAt: currentTime
          };
        }

      case 'local':
        // 总是使用本地版本
        return {
          ...localGroup,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        };

      case 'remote':
        // 总是使用云端版本
        return {
          ...cloudGroup,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        };

      case 'ask':
        // 标记为冲突，等待用户解决
        return {
          ...localGroup,
          name: `${localGroup.name} (冲突)`,
          syncStatus: 'conflict',
          lastSyncedAt: null,
          // 保存云端版本以供用户选择
          cloudVersion: cloudGroup
        } as TabGroup & { cloudVersion: TabGroup };

      default:
        // 默认使用最新版本
        if (localUpdatedAt > cloudUpdatedAt) {
          return {
            ...localGroup,
            syncStatus: 'synced',
            lastSyncedAt: currentTime
          };
        } else {
          return {
            ...cloudGroup,
            syncStatus: 'synced',
            lastSyncedAt: currentTime
          };
        }
    }
  } else {
    // 没有冲突，合并标签
    return mergeTabs(localGroup, cloudGroup, currentTime);
  }
};

/**
 * 合并两个标签组的标签
 * @param localGroup 本地标签组
 * @param cloudGroup 云端标签组
 * @param currentTime 当前时间
 * @returns 合并后的标签组
 */
const mergeTabs = (
  localGroup: TabGroup,
  cloudGroup: TabGroup,
  currentTime: string
): TabGroup => {
  // 创建一个映射，以标签ID为键
  const mergedTabsMap = new Map<string, Tab>();

  // 添加本地标签
  localGroup.tabs.forEach(localTab => {
    mergedTabsMap.set(localTab.id, {
      ...localTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });
  });

  // 添加或更新云端标签
  cloudGroup.tabs.forEach(cloudTab => {
    const localTab = mergedTabsMap.get(cloudTab.id);

    if (!localTab) {
      // 云端独有的标签
      mergedTabsMap.set(cloudTab.id, {
        ...cloudTab,
        syncStatus: 'synced',
        lastSyncedAt: currentTime
      });
    } else {
      // 本地和云端都有的标签，使用更新时间较新的版本
      const localAccessedAt = new Date(localTab.lastAccessed).getTime();
      const cloudAccessedAt = new Date(cloudTab.lastAccessed).getTime();

      if (localAccessedAt > cloudAccessedAt) {
        mergedTabsMap.set(cloudTab.id, {
          ...localTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      } else {
        mergedTabsMap.set(cloudTab.id, {
          ...cloudTab,
          syncStatus: 'synced',
          lastSyncedAt: currentTime
        });
      }
    }
  });

  // 过滤掉已删除的标签
  const mergedTabs = Array.from(mergedTabsMap.values())
    .filter(tab => !tab.isDeleted);

  // 使用更新时间较新的标签组信息
  const localUpdatedAt = new Date(localGroup.updatedAt).getTime();
  const cloudUpdatedAt = new Date(cloudGroup.updatedAt).getTime();

  if (localUpdatedAt > cloudUpdatedAt) {
    return {
      ...localGroup,
      tabs: mergedTabs,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    };
  } else {
    return {
      ...cloudGroup,
      tabs: mergedTabs,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    };
  }
};

/**
 * 标记要删除的标签组
 * @param group 标签组
 * @param deleteStrategy 删除策略
 * @returns 标记了删除状态的标签组
 */
export const markGroupForDeletion = (
  group: TabGroup,
  deleteStrategy: UserSettings['deleteStrategy'] = 'everywhere'
): TabGroup => {
  const currentTime = new Date().toISOString();

  if (deleteStrategy === 'everywhere') {
    // 标记为已删除，将在所有设备上删除
    return {
      ...group,
      isDeleted: true,
      updatedAt: currentTime,
      lastSyncedAt: null // 需要同步此更改
    };
  } else {
    // 仅本地删除，不同步到其他设备
    return {
      ...group,
      syncStatus: 'local-only',
      isDeleted: true,
      updatedAt: currentTime,
      lastSyncedAt: currentTime // 已同步（实际上是忽略同步）
    };
  }
};

/**
 * 标记要删除的标签
 * @param tab 标签
 * @param deleteStrategy 删除策略
 * @returns 标记了删除状态的标签
 */
export const markTabForDeletion = (
  tab: Tab,
  deleteStrategy: UserSettings['deleteStrategy'] = 'everywhere'
): Tab => {
  const currentTime = new Date().toISOString();

  if (deleteStrategy === 'everywhere') {
    // 标记为已删除，将在所有设备上删除
    return {
      ...tab,
      isDeleted: true,
      lastAccessed: currentTime,
      lastSyncedAt: null // 需要同步此更改
    };
  } else {
    // 仅本地删除，不同步到其他设备
    return {
      ...tab,
      syncStatus: 'local-only',
      isDeleted: true,
      lastAccessed: currentTime,
      lastSyncedAt: currentTime // 已同步（实际上是忽略同步）
    };
  }
};

/**
 * 获取需要同步到云端的标签组
 * @param groups 所有标签组
 * @returns 需要同步的标签组
 */
export const getGroupsToSync = (groups: TabGroup[]): TabGroup[] => {
  return groups.filter(group => {
    // 需要同步的情况：
    // 1. 从未同步过 (lastSyncedAt === null)
    // 2. 上次同步后有更新 (updatedAt > lastSyncedAt)
    // 3. 标记为已删除但未同步 (isDeleted && lastSyncedAt === null)

    if (!group.lastSyncedAt) return true;

    const updatedAt = new Date(group.updatedAt).getTime();
    const lastSyncedAt = new Date(group.lastSyncedAt).getTime();

    return updatedAt > lastSyncedAt || (group.isDeleted && !group.lastSyncedAt);
  });
};
