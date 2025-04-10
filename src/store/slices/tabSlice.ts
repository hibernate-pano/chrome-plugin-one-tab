import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { TabState, TabGroup } from '@/types/tab';
import { storage } from '@/utils/storage';
import { sync as supabaseSync } from '@/utils/supabase';
import { nanoid } from '@reduxjs/toolkit';

const initialState: TabState = {
  groups: [],
  activeGroupId: null,
  isLoading: false,
  error: null,
  searchQuery: '',
  syncStatus: 'idle',
  lastSyncTime: null,
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
  async (group: TabGroup) => {
    const groups = await storage.getGroups();
    const updatedGroups = groups.map(g => g.id === group.id ? group : g);
    await storage.setGroups(updatedGroups);
    return group;
  }
);

export const deleteGroup = createAsyncThunk(
  'tabs/deleteGroup',
  async (groupId: string) => {
    const groups = await storage.getGroups();
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await storage.setGroups(updatedGroups);
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
export const syncTabsToCloud = createAsyncThunk(
  'tabs/syncTabsToCloud',
  async (_, { getState }) => {
    const { tabs } = getState() as { tabs: TabState };
    await supabaseSync.uploadTabGroups(tabs.groups);
    return new Date().toISOString();
  }
);

// 新增：从云端同步标签组
export const syncTabsFromCloud = createAsyncThunk(
  'tabs/syncTabsFromCloud',
  async () => {
    const groups = await supabaseSync.downloadTabGroups();
    // 保存到本地存储
    await storage.setGroups(groups);
    return {
      groups,
      syncTime: new Date().toISOString(),
    };
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
      .addCase(syncTabsToCloud.pending, (state) => {
        state.syncStatus = 'syncing';
      })
      .addCase(syncTabsToCloud.fulfilled, (state, action) => {
        state.syncStatus = 'success';
        state.lastSyncTime = action.payload;
      })
      .addCase(syncTabsToCloud.rejected, (state, action) => {
        state.syncStatus = 'error';
        state.error = action.error.message || '同步到云端失败';
      })

      // 从云端同步
      .addCase(syncTabsFromCloud.pending, (state) => {
        state.syncStatus = 'syncing';
        state.isLoading = true;
      })
      .addCase(syncTabsFromCloud.fulfilled, (state, action) => {
        state.syncStatus = 'success';
        state.isLoading = false;
        state.groups = action.payload.groups;
        state.lastSyncTime = action.payload.syncTime;
      })
      .addCase(syncTabsFromCloud.rejected, (state, action) => {
        state.syncStatus = 'error';
        state.isLoading = false;
        state.error = action.error.message || '从云端同步失败';
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