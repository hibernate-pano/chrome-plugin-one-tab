import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { TabState, TabGroup, UserSettings } from '@/types/tab';
import { storage } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';
import { nanoid } from '@reduxjs/toolkit';
import { getGroupsToSync, mergeTabGroups } from '@/utils/syncUtils';

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
  async (group: TabGroup) => {
    const groups = await storage.getGroups();
    const updatedGroups = [group, ...groups];
    await storage.setGroups(updatedGroups);
    return group;
  }
);

export const updateGroup = createAsyncThunk(
  'tabs/updateGroup',
  async (group: TabGroup, { getState }) => {
    const { settings } = getState() as { settings: UserSettings };
    const groups = await storage.getGroups();

    // 找到原来的标签组
    const originalGroup = groups.find(g => g.id === group.id);

    if (originalGroup) {
      // 找出被删除的标签页
      const currentTabIds = new Set(group.tabs.map(tab => tab.id));

      // 原来有但现在没有的标签页就是被删除的
      const deletedTabs = originalGroup.tabs.filter(tab => !currentTabIds.has(tab.id));

      // 如果有被删除的标签页，则将它们标记为已删除并保存到 deletedTabs 存储
      if (deletedTabs.length > 0 && settings.deleteStrategy === 'everywhere') {
        // 标记标签页为已删除
        const markedTabs = deletedTabs.map(tab => markTabForDeletion(tab, settings.deleteStrategy));

        // 获取已删除的标签页
        const deletedTabsStorage = await storage.getDeletedTabs();

        // 将新删除的标签页添加到存储中
        await storage.setDeletedTabs([...deletedTabsStorage, ...markedTabs]);

        console.log(`标记了 ${markedTabs.length} 个标签页为已删除`);
      }
    }

    // 更新标签组
    const updatedGroups = groups.map(g => g.id === group.id ? group : g);
    await storage.setGroups(updatedGroups);
    return group;
  }
);

import { markGroupForDeletion, markTabForDeletion } from '@/utils/syncUtils';

export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string, { getState }) => {
    const { settings } = getState() as { settings: UserSettings };
    const groups = await storage.getGroups();

    // 找到要删除的标签组
    const groupToDelete = groups.find(g => g.id === groupId);

    if (groupToDelete) {
      // 标记为删除而不是直接从数组中移除
      // 这样可以在同步时正确处理删除操作
      const markedGroup = markGroupForDeletion(groupToDelete, settings.deleteStrategy);

      // 如果删除策略是 'everywhere'，则从本地存储中移除
      // 但保留在 deletedGroups 数组中以便同步
      if (settings.deleteStrategy === 'everywhere') {
        // 更新本地存储，移除该标签组
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await storage.setGroups(updatedGroups);

        // 同时在 deletedGroups 中保存标记为删除的标签组
        const deletedGroups = await storage.getDeletedGroups();
        await storage.setDeletedGroups([...deletedGroups, markedGroup]);
      } else {
        // 如果删除策略是 'local-only'，则只在本地移除
        const updatedGroups = groups.filter(g => g.id !== groupId);
        await storage.setGroups(updatedGroups);
      }
    } else {
      // 如果找不到标签组，只从本地存储中移除
      const updatedGroups = groups.filter(g => g.id !== groupId);
      await storage.setGroups(updatedGroups);
    }

    return groupId;
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

    // 合并现有标签组和导入的标签组
    const existingGroups = await storage.getGroups();
    const updatedGroups = [...processedGroups, ...existingGroups];
    await storage.setGroups(updatedGroups);
    return processedGroups;
  }
);



// 新增：同步标签组到云端
export const syncTabsToCloud = createAsyncThunk<
  { syncTime: string; stats: any | null },
  { background?: boolean } | void,
  { state: { tabs: TabState; settings: UserSettings } }
>(
  'tabs/syncTabsToCloud',
  async (options, { getState }) => {
    const background = options?.background || false;
    try {
      // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
      // 这样可以让 UI 先更新，然后再处理数据
      await new Promise(resolve => setTimeout(resolve, 10));

      const { tabs } = getState() as { tabs: TabState, settings: UserSettings };

      // 记录同步模式
      console.log(`开始${background ? '后台' : ''}同步标签组到云端...`);

      // 检查是否有标签组需要同步
      if (!tabs.groups || tabs.groups.length === 0) {
        console.log('没有标签组需要同步');
        return {
          syncTime: new Date().toISOString(),
          stats: null
        };
      }

      // 获取需要同步的标签组
      const groupsToSync = getGroupsToSync(tabs.groups);

      // 获取已删除的标签组
      const deletedGroups = await storage.getDeletedGroups();
      console.log(`找到 ${deletedGroups.length} 个已删除的标签组需要同步`);

      // 获取已删除的标签页
      const deletedTabs = await storage.getDeletedTabs();
      console.log(`找到 ${deletedTabs.length} 个已删除的标签页需要同步`);

      // 打印已删除的标签组和标签页的详细信息，便于调试
      if (deletedGroups.length > 0) {
        console.log('已删除的标签组详情:');
        deletedGroups.forEach(group => {
          console.log(`- ID: ${group.id}, 名称: ${group.name}, 删除时间: ${group.updatedAt}`);
        });
      }

      if (deletedTabs.length > 0) {
        console.log('已删除的标签页详情:');
        deletedTabs.forEach(tab => {
          console.log(`- ID: ${tab.id}, 标题: ${tab.title}, URL: ${tab.url}`);
        });
      }

      // 合并正常标签组和已删除标签组
      const allGroupsToSync = [...groupsToSync];

      if (allGroupsToSync.length === 0) {
        console.log('没有需要同步的变更');
        return {
          syncTime: tabs.lastSyncTime || new Date().toISOString(),
          stats: tabs.compressionStats
        };
      }

      console.log(`将同步 ${allGroupsToSync.length} 个标签组到云端（包含 ${deletedGroups.length} 个已删除的标签组和 ${deletedTabs.length} 个已删除的标签页）`);

      // 确保所有标签组都有必要的字段
      const currentTime = new Date().toISOString();
      const validGroups = allGroupsToSync.map(group => ({
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

      // 上传标签组并获取压缩统计信息
      const result = await supabaseSync.uploadTabGroups(validGroups, deletedGroups, deletedTabs);

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

      // 清理已同步的已删除数据
      if (deletedGroups.length > 0 || deletedTabs.length > 0) {
        // 将已删除的标签组标记为已同步
        if (deletedGroups.length > 0) {
          const updatedDeletedGroups = deletedGroups.map(group => ({
            ...group,
            lastSyncedAt: currentTime,
            syncStatus: 'synced' as const
          }));

          // 保存更新后的已删除标签组
          await storage.setDeletedGroups(updatedDeletedGroups);
        }

        // 将已删除的标签页标记为已同步
        if (deletedTabs.length > 0) {
          const updatedDeletedTabs = deletedTabs.map(tab => ({
            ...tab,
            lastSyncedAt: currentTime,
            syncStatus: 'synced' as const
          }));

          // 保存更新后的已删除标签页
          await storage.setDeletedTabs(updatedDeletedTabs);
        }

        // 清理过期的已删除数据
        await storage.cleanupDeletedGroups();
      }

      return {
        syncTime: currentTime,
        stats: result?.compressionStats || null
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
  async (options: { background?: boolean } | void, { getState }) => {
    const background = options?.background || false;
    try {
      // 使用 setTimeout 延迟执行数据处理，避免阻塞主线程
      // 这样可以让 UI 先更新，然后再处理数据
      await new Promise(resolve => setTimeout(resolve, 10));

      // 记录同步模式
      console.log(`开始${background ? '后台' : ''}从云端同步标签组...`);

      // 获取云端数据
      const result = await supabaseSync.downloadTabGroups();

      // 处理返回结果
      const cloudGroups = result as TabGroup[];
      const compressionStats = null; // 我们简化了返回结构，不再使用复杂的对象

      // 获取本地数据和设置
      const { tabs, settings } = getState() as { tabs: TabState, settings: UserSettings };
      const localGroups = tabs.groups;

      // 增强日志输出，显示更详细的信息
      console.log('云端标签组数量:', cloudGroups.length);
      console.log('本地标签组数量:', localGroups.length);
      
      // 详细记录每个云端标签组的信息
      console.log('云端标签组详情:');
      let totalCloudTabs = 0;
      cloudGroups.forEach((group, index) => {
        const tabCount = group.tabs.length;
        totalCloudTabs += tabCount;
        console.log(`[${index+1}/${cloudGroups.length}] ID: ${group.id}, 名称: "${group.name}", 标签数: ${tabCount}, 更新时间: ${group.updatedAt}`);
      });
      console.log(`云端总标签数: ${totalCloudTabs}`);
      
      // 获取已删除的标签组
      const deletedGroups = await storage.getDeletedGroups();
      console.log(`本地已删除标签组数量: ${deletedGroups.length}`);

      // 使用智能合并策略，包含已删除的标签组
      const mergedGroups = mergeTabGroups(localGroups, cloudGroups, settings.syncStrategy, deletedGroups);

      console.log('合并后的标签组数量:', mergedGroups.length);
      
      // 验证合并后标签组数据的完整性
      let totalMergedTabs = 0;
      mergedGroups.forEach((group) => {
        totalMergedTabs += group.tabs.length;
      });
      console.log(`合并后总标签数: ${totalMergedTabs}`);
      
      // 检查是否有标签丢失
      if (totalMergedTabs < totalCloudTabs && settings.syncStrategy !== 'local') {
        console.warn(`警告: 合并后的标签总数(${totalMergedTabs})小于云端标签总数(${totalCloudTabs})，可能有数据丢失!`);
      }

      // 获取当前时间
      const currentTime = new Date().toISOString();

      // 保存到本地存储
      await storage.setGroups(mergedGroups);

      // 更新最后同步时间
      await storage.setLastSyncTime(currentTime);

      // 检查是否有冲突需要用户解决
      const hasConflicts = mergedGroups.some(group => group.syncStatus === 'conflict');

      if (hasConflicts && settings.syncStrategy === 'ask') {
        console.log('检测到数据冲突，需要用户解决');
        // 在这里可以触发一个通知或弹窗，提示用户解决冲突
      }

      return {
        groups: mergedGroups,
        syncTime: new Date().toISOString(),
        stats: compressionStats
      };
    } catch (error) {
      console.error('从云端同步标签组失败:', error);
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
  moveTab
} = tabSlice.actions;

export default tabSlice.reducer;