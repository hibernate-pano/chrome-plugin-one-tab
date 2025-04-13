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
  syncStrategy: UserSettings['syncStrategy'] = 'newest'
): TabGroup[] => {
  // 创建一个映射，以标签组ID为键
  const mergedGroupsMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();

  // 处理本地标签组
  localGroups.forEach(localGroup => {
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
    // 跳过云端已删除的标签组
    if (cloudGroup.isDeleted) {
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
    .filter(group => !group.isDeleted);
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
  _syncStrategy: UserSettings['syncStrategy']
): TabGroup => {
  const currentTime = new Date().toISOString();

  // 手动同步时，云端数据优先，但仍然将本地数据智能合并去重
  // 不再检查冲突，直接使用智能合并算法合并标签
  return mergeTabs(localGroup, cloudGroup, currentTime);
};

/**
 * 合并两个标签组的标签，并进行智能去重
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

  // 创建 URL 映射，用于去除重复标签
  const urlMap = new Map<string, Set<string>>();

  // 添加本地标签前先记录数量
  console.log(`合并标签组 "${localGroup.name}"，本地标签: ${localGroup.tabs.length}, 云端标签: ${cloudGroup.tabs.length}`);

  // 先处理云端标签，因为云端数据优先
  cloudGroup.tabs.forEach(cloudTab => {
    // 记录每个云端标签的信息
    console.log(`处理云端标签: ID=${cloudTab.id}, 标题="${cloudTab.title}", URL=${cloudTab.url}`);

    // 添加到标签映射
    mergedTabsMap.set(cloudTab.id, {
      ...cloudTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });

    // 记录URL以便去重
    if (cloudTab.url) {
      if (!urlMap.has(cloudTab.url)) {
        urlMap.set(cloudTab.url, new Set<string>());
      }
      urlMap.get(cloudTab.url)?.add(cloudTab.id);
    }
  });

  // 然后处理本地标签，只添加不重复的标签
  localGroup.tabs.forEach(localTab => {
    // 如果标签ID已存在，跳过
    if (mergedTabsMap.has(localTab.id)) {
      console.log(`跳过重复标签ID: ${localTab.id}`);
      return;
    }

    // 检查URL是否重复
    if (localTab.url && urlMap.has(localTab.url)) {
      console.log(`发现URL重复标签: ${localTab.url}`);
      // 已经有相同URL的标签，跳过
      return;
    }

    // 记录每个本地标签的信息
    console.log(`添加本地标签: ID=${localTab.id}, 标题="${localTab.title}", URL=${localTab.url}`);

    // 添加到标签映射
    mergedTabsMap.set(localTab.id, {
      ...localTab,
      syncStatus: 'synced',
      lastSyncedAt: currentTime
    });

    // 记录URL以便去重
    if (localTab.url) {
      if (!urlMap.has(localTab.url)) {
        urlMap.set(localTab.url, new Set<string>());
      }
      urlMap.get(localTab.url)?.add(localTab.id);
    }
  });

  // 将标签映射转换回数组
  const mergedTabs = Array.from(mergedTabsMap.values());

  // 记录合并结果
  console.log(`标签组 "${localGroup.name}" 合并结果: ${mergedTabs.length} 个标签`);

  // 记录每个合并后的标签信息
  mergedTabs.forEach((tab, index) => {
    console.log(`合并后标签 ${index+1}/${mergedTabs.length}: ID=${tab.id}, 标题="${tab.title}", URL=${tab.url}`);
  });

  // 如果合并后的标签数小于云端标签数或本地标签数，输出信息性日志
  if (mergedTabs.length < Math.max(cloudGroup.tabs.length, localGroup.tabs.length)) {
    console.log(`信息: 标签组 "${localGroup.name}" 合并后的标签数(${mergedTabs.length})小于原始标签数(本地:${localGroup.tabs.length}, 云端:${cloudGroup.tabs.length})，这是因为智能去除了重复标签`);
  }

  // 构建并返回合并后的标签组
  return {
    ...localGroup,
    tabs: mergedTabs,
    name: cloudGroup.name || localGroup.name, // 优先使用云端名称
    isLocked: cloudGroup.isLocked || localGroup.isLocked, // 优先使用云端锁定状态
    updatedAt: currentTime,
    syncStatus: 'synced',
    lastSyncedAt: currentTime
  };
};

// 删除相关函数已经移除，因为不再需要记录删除操作

/**
 * 获取需要同步到云端的标签组
 * @param groups 所有标签组
 * @returns 需要同步的标签组
 */
export const getGroupsToSync = (groups: TabGroup[]): TabGroup[] => {
  // 直接返回所有标签组，不再进行筛选
  return groups;
};
