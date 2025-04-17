import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { TabState, TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';
import { nanoid } from '@reduxjs/toolkit';
import { mergeTabGroups } from '@/utils/syncUtils';
import { syncToCloud } from '@/utils/syncHelpers';

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

export const loadGroups = createAsyncThunk(
  'tabs/loadGroups',
  async () => {
    const groups = await storage.getGroups();
    return groups;
  }
);

export const saveGroup = createAsyncThunk(
  'tabs/saveGroup',
  async (group: TabGroup, { dispatch, getState }) => {
    // 保存到本地
    const groups = await storage.getGroups();
    const updatedGroups = [group, ...groups];
    await storage.setGroups(updatedGroups);

    // 使用通用同步函数同步到云端
    await syncToCloud(dispatch, getState, '新标签组');

    return group;
  }
);

export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup, { getState, dispatch }) => {
    const groups = await storage.getGroups();

    // 不再需要记录删除的标签页

    // 更新标签组
    const updatedGroups = groups.map(g => g.id === group.id ? group : g);
    await storage.setGroups(updatedGroups);

    // 使用通用同步函数同步到云端
    await syncToCloud(dispatch, getState, '更新标签组');

    return group;
  }
);



export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string, { getState, dispatch }) => {
    const groups = await storage.getGroups();

    // 直接从本地存储中移除标签组
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await storage.setGroups(updatedGroups);

    // 使用通用同步函数同步到云端
    // 不等待同步完成，直接返回结果
    // 这样可以确保用户界面不会被阻塞
    syncToCloud(dispatch, getState, '删除标签组')
      .catch(err => {
        if (process.env.NODE_ENV === 'development') {
          console.error('同步删除标签组操作失败:', err);
        }
      });

    return groupId;
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabs/deleteAllGroups',
  async (_, { getState, dispatch }) => {
    const groups = await storage.getGroups();

    if (groups.length === 0) {
      return { count: 0 }; // 没有标签组可删除
    }

    // 直接清空本地标签组
    await storage.setGroups([]);

    // 使用通用同步函数同步到云端
    // 不等待同步完成，直接返回结果
    syncToCloud(dispatch, getState, '删除所有标签组')
      .catch(err => {
        if (process.env.NODE_ENV === 'development') {
          console.error('同步删除所有标签组操作失败:', err);
        }
      });

    return { count: groups.length };
  }
);

export const importGroups = createAsyncThunk(
  'tabs/importGroups',
  async (groups: TabGroup[], { getState, dispatch }) => {
    // 为导入的标签组和标签页生成新的ID
    const processedGroups = groups.map(group => ({
      ...group,
      id: nanoid(),
      tabs: group.tabs.map(tab => ({
        ...tab,
        id: nanoid(),
      })),
    }));

    // 合并现有标签组和导入的标签组
    const existingGroups = await storage.getGroups();
    const updatedGroups = [...processedGroups, ...existingGroups];
    await storage.setGroups(updatedGroups);

    // 使用通用同步函数同步到云端
    // 不等待同步完成，直接返回结果
    syncToCloud(dispatch, getState, '导入标签组')
      .catch(err => {
        if (process.env.NODE_ENV === 'development') {
          console.error('同步导入标签组操作失败:', err);
        }
      });

    return processedGroups;
  }
);



// 同步标签组到云端
export const syncTabsToCloud = createAsyncThunk<
  { syncTime: string; stats: any | null },
  { background?: boolean; overwriteCloud?: boolean } | void,
  { state: any }
>(
  'tabs/syncTabsToCloud',
  async (options, { getState, dispatch }) => {
    const background = options?.background || false;
    const overwriteCloud = options?.overwriteCloud || false;
    try {
      // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
      // 这样可以让 UI 先更新，然后再处理数据
      await new Promise(resolve => setTimeout(resolve, 10));

      // 检查用户是否已登录
      const { auth, tabs } = getState() as { auth: { isAuthenticated: boolean }, tabs: TabState, settings: UserSettings };

      if (!auth.isAuthenticated) {
        console.log('用户未登录，无法同步数据到云端');
        return {
          syncTime: new Date().toISOString(),
          stats: null
        };
      }

      // 记录同步模式和覆盖模式
      console.log(`开始${background ? '后台' : ''}同步标签组到云端${overwriteCloud ? '（覆盖模式）' : '（合并模式）'}...`);

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
          syncTime: new Date().toISOString(),
          stats: null
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
          stats: tabs.compressionStats
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
          lastSyncedAt: currentTime // 更新同步时间
        }))
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
            syncStatus: 'synced' as const
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
        stats: null
      };
    } catch (error) {
      console.error('同步标签组到云端失败:', error);
      throw error;
    }
  }
);

// 新增：从云端同步标签组
export const syncTabsFromCloud = createAsyncThunk(
  'tabs/syncTabsFromCloud',
  async (options: { background?: boolean; forceRemoteStrategy?: boolean } | void, { getState, dispatch }) => {
    const background = options?.background || false;
    const forceRemoteStrategy = options?.forceRemoteStrategy || false;
    try {
      // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
      // 这样可以让 UI 先更新，然后再处理数据
      await new Promise(resolve => setTimeout(resolve, 10));

      // 检查用户是否已登录
      const { auth, tabs, settings } = getState() as { auth: { isAuthenticated: boolean }, tabs: TabState, settings: UserSettings };

      if (!auth.isAuthenticated) {
        console.log('用户未登录，无法从云端同步数据');
        return {
          groups: tabs.groups,
          syncTime: new Date().toISOString(),
          stats: null
        };
      }

      // 记录同步模式
      console.log(`开始${background ? '后台' : ''}从云端同步标签组...`);

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
        console.log(`[${index + 1}/${cloudGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`);

        // 详细记录每个云端标签组中的标签
        group.tabs.forEach((tab, tabIndex) => {
          console.log(`  - 云端标签 [${tabIndex + 1}/${tabCount}]: ID=${tab.id}, 标题="${tab.title}", URL=${tab.url}`);
        });
      });
      console.log(`云端总标签数: ${totalCloudTabs}`);

      // 详细记录每个本地标签组的信息
      console.log('本地标签组详情:');
      let totalLocalTabs = 0;
      localGroups.forEach((group, index) => {
        const tabCount = group.tabs.length;
        totalLocalTabs += tabCount;
        console.log(`[${index + 1}/${localGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`);
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
        console.log('使用覆盖模式：直接使用云端数据，不进行合并');
        // 直接使用云端数据，但需要确保格式正确
        mergedGroups = cloudGroups.map(group => ({
          ...group,
          syncStatus: 'synced' as const,
          lastSyncedAt: currentTime
        }));
      } else {
        // 使用智能合并策略
        console.log('使用合并模式：智能合并本地和云端数据');
        const syncStrategy = settings.syncStrategy;
        mergedGroups = mergeTabGroups(localGroups, cloudGroups, syncStrategy);
      }

      console.log('合并后的标签组数量:', mergedGroups.length);

      // 更新进度到 70%
      if (!background) {
        dispatch(updateSyncProgress({ progress: 70, operation: 'download' }));
      }

      // 详细记录合并后的每个标签组
      mergedGroups.forEach((group, index) => {
        console.log(`合并后标签组 [${index + 1}/${mergedGroups.length}]:`, {
          id: group.id,
          name: group.name,
          tabCount: group.tabs.length,
          syncStatus: group.syncStatus,
          updatedAt: group.updatedAt,
          lastSyncedAt: group.lastSyncedAt
        });
      });

      // 验证合并后标签组数据的完整性
      let totalMergedTabs = 0;
      mergedGroups.forEach((group) => {
        totalMergedTabs += group.tabs.length;
      });
      console.log(`合并后总标签数: ${totalMergedTabs}`);

      // 检查标签总数差异，输出信息性日志
      if (totalMergedTabs < Math.max(totalCloudTabs, totalLocalTabs)) {
        console.log(`信息: 合并后的标签总数(${totalMergedTabs})小于原始标签总数(本地:${totalLocalTabs}, 云端:${totalCloudTabs})，这通常是因为有重复标签或已删除标签，不影响正常使用`);
      }

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
        stats: null
      };
    } catch (error) {
      console.error('从云端同步标签组失败:', error);
      throw error;
    }
  }
);

// 新增：同步本地更改到云端 - 已禁用自动同步
export const syncLocalChangesToCloud = createAsyncThunk(
  'tabs/syncLocalChangesToCloud',
  async (_, { getState }) => {
    const { auth } = getState() as { auth: { isAuthenticated: boolean } };

    // 不再自动同步到云端，保证本地操作优先，避免卡顿
    if (process.env.NODE_ENV === 'development') {
      console.log('本地更改完成，跳过自动同步，保证操作丰满顺畅');
    }
    return auth.isAuthenticated; // 返回登录状态，但不执行同步
  }
);

// 更新标签组名称并同步到云端
export const updateGroupNameAndSync = createAsyncThunk(
  'tabs/updateGroupNameAndSync',
  async ({ groupId, name }: { groupId: string, name: string }, { getState, dispatch }) => {
    // 在 Redux 中更新标签组名称
    dispatch(updateGroupName({ groupId, name }));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => {
      if (g.id === groupId) {
        return { ...g, name, updatedAt: new Date().toISOString() };
      }
      return g;
    });
    await storage.setGroups(updatedGroups);

    // 使用通用同步函数同步到云端
    // 不等待同步完成，直接返回结果
    syncToCloud(dispatch, getState, '标签组名称更新')
      .catch(err => {
        if (process.env.NODE_ENV === 'development') {
          console.error('同步标签组名称更新操作失败:', err);
        }
      });

    return { groupId, name };
  }
);

// 切换标签组锁定状态并同步到云端
export const toggleGroupLockAndSync = createAsyncThunk(
  'tabs/toggleGroupLockAndSync',
  async (groupId: string, { getState, dispatch }) => {
    // 在 Redux 中切换标签组锁定状态
    dispatch(toggleGroupLock(groupId));

    // 在本地存储中更新标签组
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);

    if (group) {
      const updatedGroup = {
        ...group,
        isLocked: !group.isLocked,
        updatedAt: new Date().toISOString()
      };

      const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
      await storage.setGroups(updatedGroups);

      // 使用通用同步函数同步到云端
      // 不等待同步完成，直接返回结果
      syncToCloud(dispatch, getState, '标签组锁定状态更新')
        .catch(err => {
          if (process.env.NODE_ENV === 'development') {
            console.error('同步标签组锁定状态更新操作失败:', err);
          }
        });

      return { groupId, isLocked: updatedGroup.isLocked };
    }

    return { groupId, isLocked: false };
  }
);

// 移动标签组并同步到云端
export const moveGroupAndSync = createAsyncThunk(
  'tabs/moveGroupAndSync',
  async ({ dragIndex, hoverIndex }: { dragIndex: number, hoverIndex: number }, { getState, dispatch }) => {
    try {
      // 在 Redux 中移动标签组
      dispatch(moveGroup({ dragIndex, hoverIndex }));

      // 使用 setTimeout 延迟执行存储操作，避免阻塞 UI
      setTimeout(async () => {
        try {
          // 在本地存储中更新标签组顺序
          const groups = await storage.getGroups();

          // 检查索引是否有效
          if (dragIndex < 0 || dragIndex >= groups.length || hoverIndex < 0 || hoverIndex >= groups.length) {
            console.error('无效的标签组索引:', { dragIndex, hoverIndex, groupsLength: groups.length });
            return;
          }

          const dragGroup = groups[dragIndex];

          // 创建新的数组以避免直接修改原数组
          const newGroups = [...groups];
          // 删除拖拽的标签组
          newGroups.splice(dragIndex, 1);
          // 在新位置插入标签组
          newGroups.splice(hoverIndex, 0, dragGroup);

          // 更新本地存储
          await storage.setGroups(newGroups);

          // 使用通用同步函数同步到云端
          // 不等待同步完成，直接返回结果
          // 使用延迟同步，避免频繁的拖拽操作导致过多的同步请求
          setTimeout(() => {
            syncToCloud(dispatch, getState, '标签组顺序更新')
              .catch(err => {
                if (process.env.NODE_ENV === 'development') {
                  console.error('同步标签组顺序更新操作失败:', err);
                }
              });
          }, 1000); // 延迟1秒后同步，避免频繁请求
        } catch (error) {
          console.error('存储标签组移动操作失败:', error);
        }
      }, 100); // 延迟100ms执行存储操作

      return { dragIndex, hoverIndex };
    } catch (error) {
      console.error('移动标签组操作失败:', error);
      throw error;
    }
  }
);

// 移动标签页并同步到云端
export const moveTabAndSync = createAsyncThunk(
  'tabs/moveTabAndSync',
  async ({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }: {
    sourceGroupId: string,
    sourceIndex: number,
    targetGroupId: string,
    targetIndex: number
  }, { getState, dispatch }) => {
    try {
      // 在 Redux 中移动标签页
      dispatch(moveTab({ sourceGroupId, sourceIndex, targetGroupId, targetIndex }));

      // 使用 setTimeout 延迟执行存储操作，避免阻塞 UI
      setTimeout(async () => {
        try {
          // 在本地存储中更新标签页位置
          const groups = await storage.getGroups();
          const sourceGroup = groups.find(g => g.id === sourceGroupId);
          const targetGroup = groups.find(g => g.id === targetGroupId);

          if (sourceGroup && targetGroup) {
            // 获取要移动的标签页
            const tab = sourceGroup.tabs[sourceIndex];

            // 创建新的标签页数组以避免直接修改原数组
            const newSourceTabs = [...sourceGroup.tabs];
            const newTargetTabs = sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

            // 从源标签组中删除标签页
            newSourceTabs.splice(sourceIndex, 1);

            // 如果是同一个标签组内移动，需要考虑删除后索引的变化
            if (sourceGroupId === targetGroupId && sourceIndex < targetIndex) {
              newTargetTabs.splice(targetIndex - 1, 0, tab);
            } else {
              newTargetTabs.splice(targetIndex, 0, tab);
            }

            // 更新源标签组和目标标签组
            sourceGroup.tabs = newSourceTabs;
            sourceGroup.updatedAt = new Date().toISOString();

            if (sourceGroupId !== targetGroupId) {
              targetGroup.tabs = newTargetTabs;
              targetGroup.updatedAt = new Date().toISOString();
            }

            // 更新本地存储
            const updatedGroups = groups.map(g => {
              if (g.id === sourceGroupId) return sourceGroup;
              if (g.id === targetGroupId) return targetGroup;
              return g;
            });

            await storage.setGroups(updatedGroups);

            // 使用通用同步函数同步到云端
            // 不等待同步完成，直接返回结果
            // 使用延迟同步，避免频繁的拖拽操作导致过多的同步请求
            setTimeout(() => {
              syncToCloud(dispatch, getState, '标签页移动')
                .catch(err => {
                  if (process.env.NODE_ENV === 'development') {
                    console.error('同步标签页移动操作失败:', err);
                  }
                });
            }, 1000); // 延迟1秒后同步，避免频繁请求
          }
        } catch (error) {
          console.error('存储标签页移动操作失败:', error);
        }
      }, 100); // 延迟100ms执行存储操作

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
        group.updatedAt = new Date().toISOString();
      }
    },
    setGroups: (state, action) => {
      state.groups = action.payload;
      state.isLoading = false;
      state.error = null;
    },
    toggleGroupLock: (state, action) => {
      const group = state.groups.find(g => g.id === action.payload);
      if (group) {
        group.isLocked = !group.isLocked;
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
    moveTab: (state, action) => {
      const { sourceGroupId, sourceIndex, targetGroupId, targetIndex } = action.payload;
      // 找到源标签组和目标标签组
      const sourceGroup = state.groups.find(g => g.id === sourceGroupId);
      const targetGroup = state.groups.find(g => g.id === targetGroupId);

      if (sourceGroup && targetGroup) {
        // 获取要移动的标签页
        const tab = sourceGroup.tabs[sourceIndex];
        // 创建新的标签页数组以避免直接修改原数组
        const newSourceTabs = [...sourceGroup.tabs];
        const newTargetTabs = sourceGroupId === targetGroupId ? newSourceTabs : [...targetGroup.tabs];

        // 从源标签组中删除标签页
        newSourceTabs.splice(sourceIndex, 1);

        // 如果是同一个标签组内移动，需要考虑删除后索引的变化
        if (sourceGroupId === targetGroupId && sourceIndex < targetIndex) {
          newTargetTabs.splice(targetIndex - 1, 0, tab);
        } else {
          newTargetTabs.splice(targetIndex, 0, tab);
        }

        // 更新源标签组和目标标签组
        sourceGroup.tabs = newSourceTabs;
        sourceGroup.updatedAt = new Date().toISOString();

        if (sourceGroupId !== targetGroupId) {
          targetGroup.tabs = newTargetTabs;
          targetGroup.updatedAt = new Date().toISOString();
        }
      }
    },

    // 更新同步进度
    updateSyncProgress: (state, action) => {
      const { progress, operation } = action.payload;
      state.syncProgress = progress;
      state.syncOperation = operation;
    },
  },
  extraReducers: builder => {
    builder
      .addCase(loadGroups.pending, (state) => {
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
        state.groups.unshift(action.payload);
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

      .addCase(importGroups.pending, state => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(importGroups.fulfilled, (state, action) => {
        state.isLoading = false;
        state.groups = [...action.payload, ...state.groups];
      })
      .addCase(importGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '导入失败';
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
        state.groups = action.payload.groups;
        state.lastSyncTime = action.payload.syncTime;
        state.compressionStats = action.payload.stats || null;

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
      });
  },
});

export const selectFilteredGroups = (state: { tabs: TabState }) => {
  const { groups, searchQuery } = state.tabs;
  if (!searchQuery) return groups;

  const query = searchQuery.toLowerCase();
  return groups.filter(group => {
    if (group.name.toLowerCase().includes(query)) return true;

    return group.tabs.some(tab =>
      tab.title.toLowerCase().includes(query) ||
      tab.url.toLowerCase().includes(query)
    );
  });
};

export const {
  setActiveGroup,
  updateGroupName,
  toggleGroupLock,
  setSearchQuery,
  setSyncStatus,
  moveGroup,
  moveTab,
  updateSyncProgress
} = tabSlice.actions;

export default tabSlice.reducer;