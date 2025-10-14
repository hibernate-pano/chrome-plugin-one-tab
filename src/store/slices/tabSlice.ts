import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';
import { TabState, TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';
import { nanoid } from '@reduxjs/toolkit';
import { mergeTabGroups } from '@/utils/syncUtils';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { updateGroupWithVersion, updateDisplayOrder } from '@/utils/versionHelper';

// 为了解决"参数隐式具有"any"类型"的问题，添加明确的类型定义
// 注意：这些接口暂时保留，可能在未来的功能中使用

// 解决"速记属性...的范围内不存在任何值"的问题，显式声明actions


const initialState: TabState = {
  groups: [],
  activeGroupId: null,
  isLoading: false,
  error: null,
  searchQuery: '',
  syncStatus: 'idle',
  lastSyncTime: null,
  compressionStats: null,
  backgroundSync: false,
  syncProgress: 0,
  syncOperation: 'none',
};

export const loadGroups = createAsyncThunk('tabs/loadGroups', async () => {
  const groups = await storage.getGroups();

  // 过滤掉已软删除的标签组，避免UI显示
  const activeGroups = groups.filter(g => !g.isDeleted);

  // 确保标签组始终按创建时间倒序排列（最新创建的在前面）
  const sortedGroups = activeGroups.sort((a, b) => {
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });

  console.log(`[LoadGroups] 加载 ${sortedGroups.length} 个活跃标签组（已过滤 ${groups.length - activeGroups.length} 个已删除）`);

  return sortedGroups;
});

export const saveGroup = createAsyncThunk(
  'tabs/saveGroup',
  async (group: TabGroup) => {
    // 保存到本地
    const groups = await storage.getGroups();
    const updatedGroups = [group, ...groups];
    // 确保按创建时间倒序排列（最新创建的在前面）
    const sortedGroups = updatedGroups.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
    await storage.setGroups(sortedGroups);

    return group;
  }
);

export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup) => {
    const groups = await storage.getGroups();

    // 使用辅助函数增加版本号
    const updatedGroups = groups.map(g =>
      g.id === group.id ? updateGroupWithVersion(g, group) : g
    );

    await storage.setGroups(updatedGroups);

    return updatedGroups.find(g => g.id === group.id)!;
  }
);

export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string) => {
    const groups = await storage.getGroups();

    // 使用软删除：标记为已删除而非直接移除
    // 这样可以在同步时正确处理删除操作
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        const currentVersion = g.version || 1;
        return {
          ...g,
          isDeleted: true,
          version: currentVersion + 1, // 增加版本号
          updatedAt: new Date().toISOString()
        };
      }
      return g;
    });

    await storage.setGroups(updatedGroups);

    console.log(`[DeleteGroup] 软删除标签组: ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`);

    return groupId;
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabs/deleteAllGroups',
  async () => {
    const groups = await storage.getGroups();

    if (groups.length === 0) {
      return { count: 0 }; // 没有标签组可删除
    }

    // 直接清空本地标签组
    await storage.setGroups([]);

    return { count: groups.length };
  }
);

export const importGroups = createAsyncThunk(
  'tabs/importGroups',
  async (groups: TabGroup[]) => {
    // 为导入的标签组和标签页生成新的ID
    const processedGroups = groups.map(group => ({
      ...group,
      id: nanoid(),
      tabs: group.tabs.map(tab => ({
        ...tab,
        id: nanoid(),
      })),
    }));

    // 合并现有标签组和导入的标签组，并按创建时间倒序排列
    const existingGroups = await storage.getGroups();
    const updatedGroups = [...processedGroups, ...existingGroups];
    // 按创建时间倒序排列，确保最新创建的标签组在前面
    const sortedGroups = updatedGroups.sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
    await storage.setGroups(sortedGroups);

    return processedGroups;
  }
);

// 同步标签组到云端
export const syncTabsToCloud = createAsyncThunk<
  { syncTime: string; stats: any | null },
  { background?: boolean; overwriteCloud?: boolean } | void,
  { state: any }
>('tabs/syncTabsToCloud', async (options, { getState, dispatch }) => {
  const background = options?.background || false;
  const overwriteCloud = options?.overwriteCloud || false;
  try {
    // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
    // 这样可以让 UI 先更新，然后再处理数据
    await new Promise(resolve => setTimeout(resolve, 10));

    // 检查用户是否已登录
    const { auth, tabs } = getState() as {
      auth: { isAuthenticated: boolean };
      tabs: TabState;
      settings: UserSettings;
    };

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

    // 设置初始进度和操作类型
    if (!background) {
      dispatch(updateSyncProgress({ progress: 0, operation: 'upload' }));
    }

    // 检查是否有标签组需要同步
    if (!tabs.groups || tabs.groups.length === 0) {
      console.log('没有标签组需要同步');
      if (!background) {
        dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
      }
      return {
        syncTime: tabs.lastSyncTime || new Date().toISOString(),
        stats: tabs.compressionStats,
      };
    }

    // 获取需要同步的标签组
    // 直接同步所有标签组，不再考虑已删除的标签组
    const groupsToSync = tabs.groups;

    if (groupsToSync.length === 0) {
      console.log('没有需要同步的标签组');
      if (!background) {
        dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
      }
      return {
        syncTime: tabs.lastSyncTime || new Date().toISOString(),
        stats: tabs.compressionStats,
      };
    }

    console.log(`将同步 ${groupsToSync.length} 个标签组到云端`);

    // 更新进度到 20%
    if (!background) {
      dispatch(updateSyncProgress({ progress: 20, operation: 'upload' }));
    }

    // 确保所有标签组都有必要的字段
    const currentTime = new Date().toISOString();
    const validGroups = groupsToSync.map(group => ({
      ...group,
      createdAt: group.createdAt || currentTime,
      updatedAt: group.updatedAt || currentTime,
      isLocked: typeof group.isLocked === 'boolean' ? group.isLocked : false,
      lastSyncedAt: currentTime, // 更新同步时间
      tabs: group.tabs.map(tab => ({
        ...tab,
        createdAt: tab.createdAt || currentTime,
        lastAccessed: tab.lastAccessed || currentTime,
        lastSyncedAt: currentTime, // 更新同步时间
      })),
    }));

    // 更新进度到 50%
    if (!background) {
      dispatch(updateSyncProgress({ progress: 50, operation: 'upload' }));
    }

    // 上传标签组，传递覆盖模式参数
    await supabaseSync.uploadTabGroups(validGroups, overwriteCloud);

    // 更新进度到 70%
    if (!background) {
      dispatch(updateSyncProgress({ progress: 70, operation: 'upload' }));
    }

    // 更新本地标签组的同步状态
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

    // 保存更新后的标签组
    await storage.setGroups(updatedGroups as TabGroup[]);

    // 更新最后同步时间
    await storage.setLastSyncTime(currentTime);

    // 更新进度到 100%
    if (!background) {
      dispatch(updateSyncProgress({ progress: 100, operation: 'none' }));
    }

    // 不再需要处理已删除的数据

    return {
      syncTime: currentTime,
      stats: null,
    };
  } catch (error) {
    console.error('同步标签组到云端失败:', error);
    throw error;
  }
});

// 新增：从云端同步标签组
export const syncTabsFromCloud = createAsyncThunk(
  'tabs/syncTabsFromCloud',
  async (
    options: { background?: boolean; forceRemoteStrategy?: boolean } | void,
    { getState, dispatch }
  ) => {
    const background = options?.background || false;
    const forceRemoteStrategy = options?.forceRemoteStrategy || false;
    try {
      // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
      // 这样可以让 UI 先更新，然后再处理数据
      await new Promise(resolve => setTimeout(resolve, 10));

      // 检查用户是否已登录
      const { auth, tabs, settings } = getState() as {
        auth: { isAuthenticated: boolean };
        tabs: TabState;
        settings: UserSettings;
      };

      if (!auth.isAuthenticated) {
        console.log('用户未登录，无法从云端同步数据');
        return {
          groups: tabs.groups,
          syncTime: new Date().toISOString(),
          stats: null,
        };
      }

      // 记录同步模式
      // 开始同步

      // 设置初始进度和操作类型
      if (!background) {
        dispatch(updateSyncProgress({ progress: 0, operation: 'download' }));
      }

      // 获取云端数据
      const result = await supabaseSync.downloadTabGroups();

      // 更新进度到 30%
      if (!background) {
        dispatch(updateSyncProgress({ progress: 30, operation: 'download' }));
      }

      // 处理返回结果
      const cloudGroups = result as TabGroup[];

      // 获取本地数据
      let localGroups = tabs.groups;

      // 增强日志输出，显示更详细的信息
      console.log('云端标签组数量:', cloudGroups.length);
      console.log('本地标签组数量:', localGroups.length);

      // 如果是覆盖模式，则清空本地数据
      if (forceRemoteStrategy) {
        console.log('覆盖模式: 清空本地数据，只使用云端数据');
        localGroups = [];
      }

      // 详细记录每个云端标签组的信息
      console.log('云端标签组详情:');
      let totalCloudTabs = 0;
      cloudGroups.forEach((group, index) => {
        const tabCount = group.tabs.length;
        totalCloudTabs += tabCount;
        console.log(
          `[${index + 1}/${cloudGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`
        );

        // 详细记录每个云端标签组中的标签
        group.tabs.forEach((tab, tabIndex) => {
          console.log(
            `  - 云端标签 [${tabIndex + 1}/${tabCount}]: ID=${tab.id}, 标题="${tab.title}", URL=${tab.url}`
          );
        });
      });
      console.log(`云端总标签数: ${totalCloudTabs}`);

      // 详细记录每个本地标签组的信息
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

      // 更新进度到 50%
      if (!background) {
        dispatch(updateSyncProgress({ progress: 50, operation: 'download' }));
      }

      // 获取当前时间，移动到这里以避免引用错误
      const currentTime = new Date().toISOString();

      let mergedGroups;

      // 如果是覆盖模式，直接使用云端数据，不进行合并
      if (forceRemoteStrategy) {
        // 使用覆盖模式
        // 直接使用云端数据，但需要确保格式正确
        mergedGroups = cloudGroups.map(group => ({
          ...group,
          syncStatus: 'synced' as const,
          lastSyncedAt: currentTime,
        }));
      } else {
        // 使用智能合并策略
        // 使用合并模式
        const syncStrategy = settings.syncStrategy;
        mergedGroups = mergeTabGroups(localGroups, cloudGroups, syncStrategy);
      }

      // 合并完成

      // 更新进度到 70%
      if (!background) {
        dispatch(updateSyncProgress({ progress: 70, operation: 'download' }));
      }

      // 合并完成，继续处理

      // 保存到本地存储
      await storage.setGroups(mergedGroups);

      // 更新进度到 90%
      if (!background) {
        dispatch(updateSyncProgress({ progress: 90, operation: 'download' }));
      }

      // 更新最后同步时间
      await storage.setLastSyncTime(currentTime);

      // 检查是否有冲突需要用户解决
      const hasConflicts = mergedGroups.some(group => group.syncStatus === 'conflict');

      if (hasConflicts && settings.syncStrategy === 'ask') {
        console.log('检测到数据冲突，需要用户解决');
        // 在这里可以触发一个通知或弹窗，提示用户解决冲突
      }

      // 更新进度到 100%
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
  }
);

// 已禁用自动同步 - 此函数仅用于检查登录状态
export const syncLocalChangesToCloud = createAsyncThunk(
  'tabs/syncLocalChangesToCloud',
  async (_, { getState }) => {
    const { auth } = getState() as { auth: { isAuthenticated: boolean } };
    return auth.isAuthenticated;
  }
);

// 更新标签组名称并同步到云端
export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string; name: string }, { dispatch }) => {
    // 在 Redux 中更新标签组名称
    dispatch(updateGroupName({ groupId, name }));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return updateGroupWithVersion(g, { name });
      }
      return g;
    });
    await storage.setGroups(updatedGroups);

    console.log(`[UpdateGroupName] 更新标签组 ${groupId}, 新版本: ${(groups.find(g => g.id === groupId)?.version || 1) + 1}`);

    return { groupId, name };
  }
);

// 切换标签组锁定状态并同步到云端
export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { dispatch }) => {
    // 在 Redux 中切换标签组锁定状态
    dispatch(toggleGroupLock(groupId));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (group) {
      const updatedGroup = updateGroupWithVersion(group, {
        isLocked: !group.isLocked
      });

      const updatedGroups = groups.map(g => (g.id === groupId ? updatedGroup : g));
      await storage.setGroups(updatedGroups);

      console.log(`[ToggleLock] 切换锁定状态 ${groupId}, 新版本: ${updatedGroup.version}`);

      return { groupId, isLocked: updatedGroup.isLocked };
    }

    return { groupId, isLocked: false };
  }
);

/**
 * 移动标签组并同步到云端
 * 优化性能：
 * 1. 使用requestAnimationFrame延迟存储操作
 * 2. 使用节流函数减少云端同步频率
 * 3. 批量处理本地存储操作
 */
export const moveGroupAndSync = createAsyncThunk(
  'tabs/moveGroupAndSync',
  async (
    { dragIndex, hoverIndex }: { dragIndex: number; hoverIndex: number },
    { dispatch }
  ) => {
    try {
      // 在 Redux 中移动标签组 - 立即更新UI
      dispatch(moveGroup({ dragIndex, hoverIndex }));

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      // 这样可以确保UI更新优先，存储操作不会阻塞渲染
      requestAnimationFrame(async () => {
        try {
          // 在本地存储中更新标签组顺序
          const groups = await storage.getGroups();

          // 检查索引是否有效
          if (
            dragIndex < 0 ||
            dragIndex >= groups.length ||
            hoverIndex < 0 ||
            hoverIndex >= groups.length
          ) {
            console.error('无效的标签组索引:', {
              dragIndex,
              hoverIndex,
              groupsLength: groups.length,
            });
            return;
          }

          const dragGroup = groups[dragIndex];

          // 创建新的数组以避免直接修改原数组
          const newGroups = [...groups];
          // 删除拖拽的标签组
          newGroups.splice(dragIndex, 1);
          // 在新位置插入标签组
          newGroups.splice(hoverIndex, 0, dragGroup);

          // ⭐ 关键：更新所有标签组的 displayOrder 和 version
          const updatedGroups = updateDisplayOrder(newGroups);

          // 更新本地存储 - 批量操作
          await storage.setGroups(updatedGroups);

          console.log(`[MoveGroup] 已更新所有标签组的 displayOrder`);

        } catch (error) {
          console.error('存储标签组移动操作失败:', error);
        }
      });

      return { dragIndex, hoverIndex };
    } catch (error) {
      console.error('移动标签组操作失败:', error);
      throw error;
    }
  }
);

// 移动标签页并同步到云端
// 清理重复标签功能
export const cleanDuplicateTabs = createAsyncThunk(
  'tabs/cleanDuplicateTabs',
  async () => {
    // 保存原始数据，用于错误回滚
    let originalGroups: TabGroup[] = [];

    try {
      // 获取所有标签组并保存原始状态
      originalGroups = await storage.getGroups();
      const groups = [...originalGroups]; // 创建副本进行操作

      // 创建URL映射，记录每个URL对应的标签页
      const urlMap = new Map<string, { tab: any; groupId: string }[]>();

      // 扫描所有标签页，按URL分组
      groups.forEach(group => {
        group.tabs.forEach(tab => {
          if (tab.url) {
            // 对于loading://开头的URL，需要特殊处理
            const urlKey = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;

            if (!urlMap.has(urlKey)) {
              urlMap.set(urlKey, []);
            }
            urlMap.get(urlKey)?.push({ tab, groupId: group.id });
          }
        });
      });

      // 处理重复标签页
      let removedTabsCount = 0;
      const updatedGroups = [...groups];

      urlMap.forEach(tabsWithSameUrl => {
        if (tabsWithSameUrl.length > 1) {
          // 按lastAccessed时间排序，保留最新的标签页
          tabsWithSameUrl.sort(
            (a, b) =>
              new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
          );

          // 保留第一个（最新的），删除其余的
          for (let i = 1; i < tabsWithSameUrl.length; i++) {
            const { groupId, tab } = tabsWithSameUrl[i];
            const groupIndex = updatedGroups.findIndex(g => g.id === groupId);

            if (groupIndex !== -1) {
              // 从标签组中删除该标签页
              updatedGroups[groupIndex].tabs = updatedGroups[groupIndex].tabs.filter(
                t => t.id !== tab.id
              );
              removedTabsCount++;

              // 更新标签组的updatedAt时间和版本号
              const currentVersion = updatedGroups[groupIndex].version || 1;
              updatedGroups[groupIndex].updatedAt = new Date().toISOString();
              updatedGroups[groupIndex].version = currentVersion + 1;
            }
          }
        }
      });

      // 清理空标签组（在重复标签清理后进行）
      let removedGroupsCount = 0;
      const finalGroups = updatedGroups.filter(group => {
        // 如果标签组为空且不是锁定状态，则删除
        if (group.tabs.length === 0 && !group.isLocked) {
          removedGroupsCount++;
          return false; // 从数组中移除
        }
        return true; // 保留
      });

      // 原子性操作：先保存到本地存储
      try {
        await storage.setGroups(finalGroups);
      } catch (storageError) {
        console.error('保存到本地存储失败，操作回滚:', storageError);
        // 如果保存失败，不进行任何更改
        throw new Error('保存失败，操作已取消');
      }

      return {
        removedTabsCount,
        removedGroupsCount,
        updatedGroups: finalGroups
      };
    } catch (error) {
      console.error('清理重复标签和空标签组失败:', error);

      // 如果操作过程中出现错误，尝试恢复原始状态
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

/**
 * 移动标签页并同步到云端
 * 优化性能：
 * 1. 使用requestAnimationFrame延迟存储操作
 * 2. 使用节流函数减少云端同步频率
 * 3. 批量处理本地存储操作
 * 4. 优化拖拽过程中的状态更新
 * 5. 自动清理拖拽后的空标签组
 */
export const moveTabAndSync = createAsyncThunk(
  'tabs/moveTabAndSync',
  async (
    {
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex,
      updateSourceInDrag = true,
    }: {
      sourceGroupId: string;
      sourceIndex: number;
      targetGroupId: string;
      targetIndex: number;
      updateSourceInDrag?: boolean;
    },
    { dispatch }
  ) => {
    try {
      // 在 Redux 中移动标签页 - 立即更新UI
      dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

      // 如果是在拖动过程中且不需要更新源，跳过存储操作
      // 这是一个优化，避免在拖拽过程中频繁更新存储
      if (!updateSourceInDrag) {
        return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
      }

      // 使用 requestAnimationFrame 在下一帧执行存储操作，优化性能
      // 这样可以确保UI更新优先，存储操作不会阻塞渲染
      requestAnimationFrame(async () => {
        try {
          // 在本地存储中更新标签页位置
          const groups = await storage.getGroups();
          const sourceGroup = groups.find(g => g.id === sourceGroupId);
          const targetGroup = groups.find(g => g.id === targetGroupId);

          if (sourceGroup && targetGroup) {
            // 获取要移动的标签页
            const tab = sourceGroup.tabs[sourceIndex];

            if (!tab) {
              console.error('找不到要移动的标签页:', { sourceGroupId, sourceIndex });
              return;
            }

            // 创建新的标签页数组以避免直接修改原数组
            const newSourceTabs = [...sourceGroup.tabs];
            const newTargetTabs =
              sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

            // 从源标签组中删除标签页
            newSourceTabs.splice(sourceIndex, 1);

            // 修复：计算调整后的目标索引
            // 对于同组内移动，无论拖动方向如何，都直接使用 targetIndex
            // 这与 Redux reducer 中的逻辑保持一致
            let adjustedIndex = targetIndex;

            // 确保索引在有效范围内
            adjustedIndex = Math.max(0, Math.min(adjustedIndex, newTargetTabs.length));

            // 插入标签到目标位置
            newTargetTabs.splice(adjustedIndex, 0, tab);

            // 更新源标签组和目标标签组 - 使用不可变更新
            const sourceVersion = sourceGroup.version || 1;
            const updatedSourceGroup = {
              ...sourceGroup,
              tabs: newSourceTabs,
              updatedAt: new Date().toISOString(),
              version: sourceVersion + 1,
            };

            let updatedTargetGroup = targetGroup;
            if (sourceGroupId !== targetGroupId) {
              const targetVersion = targetGroup.version || 1;
              updatedTargetGroup = {
                ...targetGroup,
                tabs: newTargetTabs,
                updatedAt: new Date().toISOString(),
                version: targetVersion + 1,
              };
            }

            // 批量更新本地存储 - 一次性更新所有变更
            let updatedGroups = groups
              .map(g => {
                if (g.id === sourceGroupId) return updatedSourceGroup;
                if (g.id === targetGroupId) return updatedTargetGroup;
                return g;
              });

            // 自动清理空标签组（仅在跨组移动时检查源标签组）
            if (sourceGroupId !== targetGroupId && updatedSourceGroup && updatedSourceGroup.tabs.length === 0) {
              try {
                // 使用工具函数检查是否应该被自动删除（考虑锁定状态等）
                if (shouldAutoDeleteAfterTabRemoval(updatedSourceGroup, '')) {
                  console.log(`[拖拽自动清理] 检测到空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);

                  // 从存储数组中移除空标签组
                  updatedGroups = updatedGroups.filter(g => g.id !== sourceGroupId);

                  // 延迟删除Redux状态中的标签组，避免与UI组件的删除逻辑冲突
                  setTimeout(() => {
                    try {
                      dispatch(deleteGroup(sourceGroupId));
                    } catch (deleteError) {
                      console.error(`[拖拽自动清理] 删除Redux状态失败:`, deleteError);
                    }
                  }, 100);

                  console.log(`[拖拽自动清理] 已从存储中移除空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);
                } else {
                  console.log(`[拖拽自动清理] 跳过不符合删除条件的空标签组: ${updatedSourceGroup.name} (ID: ${sourceGroupId})`);
                }
              } catch (cleanupError) {
                console.error(`[拖拽自动清理] 清理空标签组时发生错误:`, cleanupError);
                // 清理失败时不影响主要的存储操作
              }
            }

            await storage.setGroups(updatedGroups);

          }
        } catch (error) {
          console.error('存储标签页移动操作失败:', error);
        }
      });

      return { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
    } catch (error) {
      console.error('移动标签页操作失败:', error);
      throw error;
    }
  }
);

export const tabSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    setActiveGroup: (state, action) => {
      state.activeGroupId = action.payload;
    },
    updateGroupName: (state, action) => {
      const { groupId, name } = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.name = name;
        group.version = (group.version || 1) + 1; // 添加版本号
        group.updatedAt = new Date().toISOString();
      }
    },
    toggleGroupLock: (state, action) => {
      const group = state.groups.find(g => g.id === action.payload);
      if (group) {
        group.isLocked = !group.isLocked;
        group.version = (group.version || 1) + 1; // 添加版本号
        group.updatedAt = new Date().toISOString();
      }
    },
    setSearchQuery: (state, action) => {
      state.searchQuery = action.payload;
    },
    // 新增：设置同步状态
    setSyncStatus: (state, action) => {
      state.syncStatus = action.payload;
    },
    moveGroup: (state, action) => {
      const { dragIndex, hoverIndex } = action.payload;
      const dragGroup = state.groups[dragIndex];
      // 创建新的数组以避免直接修改原数组
      const newGroups = [...state.groups];
      // 删除拖拽的标签组
      newGroups.splice(dragIndex, 1);
      // 在新位置插入标签组
      newGroups.splice(hoverIndex, 0, dragGroup);
      // 更新状态
      state.groups = newGroups;
    },
    /**
     * 移动标签页 - 优化版本
     * 性能优化：
     * 1. 减少不必要的数组复制
     * 2. 使用immer的不可变更新模式
     * 3. 优化条件判断逻辑
     */
    moveTab: (state, action) => {
      const { sourceGroupId, sourceIndex, targetGroupId, targetIndex } = action.payload;

      // 找到源标签组和目标标签组
      const sourceGroup = state.groups.find(g => g.id === sourceGroupId);
      const targetGroup = state.groups.find(g => g.id === targetGroupId);

      // 验证源组和目标组存在，以及它们的 tabs 数组
      if (!sourceGroup || !targetGroup ||
        !sourceGroup.tabs || !Array.isArray(sourceGroup.tabs) ||
        !targetGroup.tabs || !Array.isArray(targetGroup.tabs)) {
        console.error('无效的标签组数据:', {
          sourceGroup: sourceGroup?.id,
          targetGroup: targetGroup?.id,
          sourceTabsValid: Array.isArray(sourceGroup?.tabs),
          targetTabsValid: Array.isArray(targetGroup?.tabs)
        });
        return;
      }

      // 验证源索引有效
      if (sourceIndex < 0 || sourceIndex >= sourceGroup.tabs.length) {
        console.error('无效的源标签索引:', { sourceIndex, tabsLength: sourceGroup.tabs.length });
        return;
      }

      // 获取要移动的标签页（创建深拷贝避免引用问题）
      const tab = { ...sourceGroup.tabs[sourceIndex] };

      // 更新时间戳
      const now = new Date().toISOString();

      // 处理同一组内移动
      if (sourceGroupId === targetGroupId) {
        // 创建新的标签数组，避免直接修改原数组
        const newTabs = [...sourceGroup.tabs];

        // 先移除源标签
        newTabs.splice(sourceIndex, 1);

        // 修复：计算调整后的目标索引
        // 无论拖动方向如何，都直接使用 targetIndex 作为插入位置
        // 这样可以确保标签页准确移动到用户指示的目标位置
        //
        // 原来的逻辑问题：
        // - 从上向下拖动时，targetIndex - 1 会导致插入位置偏前一位
        // - 从下向上拖动时，直接使用 targetIndex 是正确的
        //
        // 修正后的逻辑：
        // - 无论方向，都使用 targetIndex，因为用户期望插入到目标位置
        const adjustedIndex = Math.max(0, Math.min(targetIndex, newTabs.length));

        // 插入到目标位置
        newTabs.splice(adjustedIndex, 0, tab);

        // 更新标签组 - 使用不可变更新
        const updatedSourceGroup = {
          ...sourceGroup,
          tabs: newTabs,
          updatedAt: now,
        };

        // 更新state中的标签组
        state.groups = state.groups.map(g => (g.id === sourceGroupId ? updatedSourceGroup : g));
      }
      // 处理跨组移动
      else {
        // 从源组移除标签 - 创建新的标签数组
        const newSourceTabs = sourceGroup.tabs.filter((_, i) => i !== sourceIndex);

        // 更新源标签组 - 使用不可变更新
        const updatedSourceGroup = {
          ...sourceGroup,
          tabs: newSourceTabs,
          updatedAt: now,
        };

        // 准备目标组的新标签数组
        const newTargetTabs = [...targetGroup.tabs];

        // 检查目标组中是否已经有这个标签（避免重复）
        const existingIndex = newTargetTabs.findIndex(t => t.id === tab.id);
        if (existingIndex !== -1) {
          newTargetTabs.splice(existingIndex, 1);
        }

        // 确保目标索引在有效范围内
        const safeTargetIndex = Math.max(0, Math.min(targetIndex, newTargetTabs.length));

        // 插入到目标位置
        newTargetTabs.splice(safeTargetIndex, 0, tab);

        // 更新目标标签组 - 使用不可变更新
        const updatedTargetGroup = {
          ...targetGroup,
          tabs: newTargetTabs,
          updatedAt: now,
        };

        // 更新state中的标签组
        state.groups = state.groups
          .map(g => {
            if (g.id === sourceGroupId) return updatedSourceGroup;
            if (g.id === targetGroupId) return updatedTargetGroup;
            return g;
          })
        // 不在此处移除空标签组，交由 SortableTabGroup 组件通过 isMarkedForDeletion 处理
        // .filter(g => g.tabs.length > 0 || g.isLocked);

        // 不再立即重置活动组，让SortableTabGroup组件处理
        // if (
        //   state.activeGroupId === sourceGroupId &&
        //   updatedSourceGroup.tabs.length === 0 &&
        //   !updatedSourceGroup.isLocked
        // ) {
        //   state.activeGroupId = null;
        // }
      }
    },

    // 更新同步进度
    updateSyncProgress: (state, action) => {
      const { progress, operation } = action.payload;
      state.syncProgress = progress;
      state.syncOperation = operation;
    },
    // 设置标签组数据（用于性能测试等场景）
    setGroups: (state, action) => {
      state.groups = action.payload;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(loadGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadGroups.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload;
      })
      .addCase(loadGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '加载标签组失败';
      })
      .addCase(saveGroup.fulfilled, (state, action) => {
        // 添加新标签组并按创建时间倒序排列
        state.groups.unshift(action.payload);
        state.groups.sort((a, b) => {
          const dateA = new Date(a.createdAt);
          const dateB = new Date(b.createdAt);
          return dateB.getTime() - dateA.getTime();
        });
      })
      .addCase(updateGroup.fulfilled, (state, action) => {
        const index = state.groups.findIndex(g => g.id === action.payload.id);
        if (index !== -1) {
          state.groups[index] = action.payload;
        }
      })
      .addCase(deleteGroup.fulfilled, (state, action) => {
        state.groups = state.groups.filter(g => g.id !== action.payload);
        if (state.activeGroupId === action.payload) {
          state.activeGroupId = null;
        }
      })
      .addCase(deleteAllGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteAllGroups.fulfilled, state => {
        state.isLoading = false;
        state.groups = [];
        state.activeGroupId = null;
      })
      .addCase(deleteAllGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '删除所有标签组失败';
      })

      // 同步到云端
      .addCase(syncTabsToCloud.pending, (state, action) => {
        // 只有在非后台同步时才更新状态
        const isBackground = action.meta.arg?.background || false;
        state.backgroundSync = isBackground;

        if (!isBackground) {
          state.syncStatus = 'syncing';
        }
      })
      .addCase(syncTabsToCloud.fulfilled, (state, action) => {
        // 更新同步时间和统计信息，但只有在非后台同步时才更新状态
        state.lastSyncTime = action.payload.syncTime;
        state.compressionStats = action.payload.stats || null;

        if (!state.backgroundSync) {
          state.syncStatus = 'success';
        }

        // 后台同步完成后重置标志
        state.backgroundSync = false;
      })
      .addCase(syncTabsToCloud.rejected, (state, action) => {
        // 只有在非后台同步时才更新错误状态
        if (!state.backgroundSync) {
          state.syncStatus = 'error';
          state.error = action.error.message || '同步到云端失败';
        }

        // 后台同步完成后重置标志
        state.backgroundSync = false;
      })

      // 从云端同步
      .addCase(syncTabsFromCloud.pending, (state, action) => {
        // 只有在非后台同步时才更新状态
        const isBackground = action.meta.arg?.background || false;
        state.backgroundSync = isBackground;

        if (!isBackground) {
          state.syncStatus = 'syncing';
          state.isLoading = true;
        }
      })
      .addCase(syncTabsFromCloud.fulfilled, (state, action) => {
        // 始终更新数据，但只有在非后台同步时才更新状态
        // 过滤掉已软删除的标签组，避免UI显示
        const activeGroups = action.payload.groups.filter(g => !g.isDeleted);
        state.groups = activeGroups;
        state.lastSyncTime = action.payload.syncTime;
        state.compressionStats = action.payload.stats || null;

        console.log(`[SyncFromCloud] 已同步 ${activeGroups.length} 个活跃标签组（已过滤 ${action.payload.groups.length - activeGroups.length} 个已删除）`);

        if (!state.backgroundSync) {
          state.syncStatus = 'success';
          state.isLoading = false;
        }

        // 后台同步完成后重置标志
        state.backgroundSync = false;
      })
      .addCase(syncTabsFromCloud.rejected, (state, action) => {
        // 只有在非后台同步时才更新错误状态
        if (!state.backgroundSync) {
          state.syncStatus = 'error';
          state.isLoading = false;
          state.error = action.error.message || '从云端同步失败';
        }

        // 后台同步完成后重置标志
        state.backgroundSync = false;
      })

      // 同步本地更改到云端
      .addCase(syncLocalChangesToCloud.pending, () => {
        // 不更新UI状态，因为这是后台操作
      })
      .addCase(syncLocalChangesToCloud.fulfilled, () => {
        // 不更新UI状态，因为这是后台操作
      })
      .addCase(syncLocalChangesToCloud.rejected, () => {
        // 不更新UI状态，因为这是后台操作
      })

      // 更新标签组名称并同步到云端
      .addCase(updateGroupNameAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(updateGroupNameAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(updateGroupNameAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 切换标签组锁定状态并同步到云端
      .addCase(toggleGroupLockAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(toggleGroupLockAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 移动标签组并同步到云端
      .addCase(moveGroupAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveGroupAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveGroupAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 移动标签页并同步到云端
      .addCase(moveTabAndSync.pending, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveTabAndSync.fulfilled, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })
      .addCase(moveTabAndSync.rejected, () => {
        // 不更新UI状态，因为已经在 reducer 中更新了
      })

      // 清理重复标签和空标签组
      .addCase(cleanDuplicateTabs.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(cleanDuplicateTabs.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = action.payload.updatedGroups;
      })
      .addCase(cleanDuplicateTabs.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '清理重复标签和空标签组失败';
      });
  },
});

// 将 actions 单独导出，避免循环依赖
export const {
  setActiveGroup,
  updateGroupName,
  toggleGroupLock,
  setSearchQuery,
  setSyncStatus,
  moveGroup,
  moveTab,
  updateSyncProgress,
  setGroups,
} = tabSlice.actions;

// 新增：删除单个标签页
export const deleteTabAndSync = createAsyncThunk<
  { group: TabGroup | null },
  { groupId: string; tabId: string },
  { state: any }
>('tabs/deleteTabAndSync', async ({ groupId, tabId }: { groupId: string; tabId: string }) => {
  try {
    // 在本地存储中删除标签
    const groups = await storage.getGroups();
    const groupIndex = groups.findIndex(g => g.id === groupId);

    if (groupIndex !== -1) {
      const currentGroup = groups[groupIndex];

      // 使用工具函数检查删除标签页后是否应该自动删除标签组
      if (shouldAutoDeleteAfterTabRemoval(currentGroup, tabId)) {
        // 自动删除空的未锁定标签组
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await storage.setGroups(updatedGroups);

        console.log(`自动删除空标签组: ${currentGroup.name} (ID: ${groupId})`);
        return { group: null };
      } else {
        // 更新标签组，移除指定的标签页
        const updatedTabs = currentGroup.tabs.filter(tab => tab.id !== tabId);
        const currentVersion = currentGroup.version || 1;
        const updatedGroup = {
          ...currentGroup,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString(),
          version: currentVersion + 1,
        };

        // 更新本地存储
        const updatedGroups = [...groups];
        updatedGroups[groupIndex] = updatedGroup;
        await storage.setGroups(updatedGroups);

        console.log(`从标签组删除标签页: ${currentGroup.name}, 剩余标签页: ${updatedTabs.length}`);
        return { group: updatedGroup };
      }
    }

    return { group: null };
  } catch (error) {
    console.error('删除标签页操作失败:', error);
    throw error;
  }
});

// 使用createSelector创建记忆化选择器，避免不必要的重新计算
export const selectFilteredGroups = createSelector(
  [
    (state: { tabs: TabState }) => state.tabs.groups,
    (state: { tabs: TabState }) => state.tabs.searchQuery,
  ],
  (groups, searchQuery) => {
    if (!searchQuery) return groups;

    const query = searchQuery.toLowerCase();
    return groups.filter(group => {
      // 先检查组名，这是一个快速检查
      if (group.name.toLowerCase().includes(query)) return true;

      // 然后检查标签，这可能更耗时
      return group.tabs.some(
        tab => tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)
      );
    });
  }
);

export default tabSlice.reducer;
