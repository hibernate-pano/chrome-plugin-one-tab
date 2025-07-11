/**
 * 标签组状态管理
 * 处理标签组的创建、删除、重命名等操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { TabGroup } from '@/shared/types/tab';
import { nanoid } from '@reduxjs/toolkit';

interface TabGroupsState {
  groups: TabGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
}

const initialState: TabGroupsState = {
  groups: [],
  activeGroupId: null,
  isLoading: false,
  error: null,
  searchQuery: '',
};

// 异步操作
export const loadGroups = createAsyncThunk('tabGroups/loadGroups', async () => {
  logger.debug('加载标签组');
  const groups = await storage.getGroups();
  return groups;
});

export const saveGroup = createAsyncThunk(
  'tabGroups/saveGroup',
  async (group: Omit<TabGroup, 'id' | 'createdAt' | 'updatedAt'>) => {
    logger.debug('保存新标签组', { name: group.name, tabCount: group.tabs.length });
    
    const newGroup: TabGroup = {
      ...group,
      id: nanoid(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const groups = await storage.getGroups();
    const updatedGroups = [newGroup, ...groups];
    await storage.setGroups(updatedGroups);
    
    return newGroup;
  }
);

export const updateGroup = createAsyncThunk(
  'tabGroups/updateGroup',
  async (group: TabGroup) => {
    logger.debug('更新标签组', { id: group.id, name: group.name });
    
    const groups = await storage.getGroups();
    const updatedGroup = {
      ...group,
      updatedAt: new Date().toISOString(),
    };
    
    const updatedGroups = groups.map(g => g.id === group.id ? updatedGroup : g);
    await storage.setGroups(updatedGroups);
    
    return updatedGroup;
  }
);

export const deleteGroup = createAsyncThunk(
  'tabGroups/deleteGroup',
  async (groupId: string) => {
    logger.debug('删除标签组', { groupId });
    
    const groups = await storage.getGroups();
    const updatedGroups = groups.filter(g => g.id !== groupId);
    await storage.setGroups(updatedGroups);
    
    return groupId;
  }
);

export const updateGroupName = createAsyncThunk(
  'tabGroups/updateGroupName',
  async ({ groupId, name }: { groupId: string; name: string }) => {
    logger.debug('更新标签组名称', { groupId, name });
    
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }
    
    const updatedGroup = {
      ...group,
      name,
      updatedAt: new Date().toISOString(),
    };
    
    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);
    
    return { groupId, name };
  }
);

export const toggleGroupLock = createAsyncThunk(
  'tabGroups/toggleGroupLock',
  async (groupId: string) => {
    logger.debug('切换标签组锁定状态', { groupId });
    
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }
    
    const updatedGroup = {
      ...group,
      isLocked: !group.isLocked,
      updatedAt: new Date().toISOString(),
    };
    
    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);
    
    return { groupId, isLocked: updatedGroup.isLocked };
  }
);

export const deleteAllGroups = createAsyncThunk(
  'tabGroups/deleteAllGroups',
  async () => {
    logger.debug('删除所有标签组');
    
    const groups = await storage.getGroups();
    const count = groups.length;
    
    await storage.setGroups([]);
    
    return { count };
  }
);

// Slice定义
const tabGroupsSlice = createSlice({
  name: 'tabGroups',
  initialState,
  reducers: {
    setActiveGroup: (state, action: PayloadAction<string | null>) => {
      state.activeGroupId = action.payload;
    },
    
    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.searchQuery = action.payload;
    },
    
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    
    // 临时更新组名（用于编辑时的即时反馈）
    updateGroupNameLocal: (state, action: PayloadAction<{ groupId: string; name: string }>) => {
      const { groupId, name } = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.name = name;
      }
    },
    
    // 临时切换锁定状态（用于切换时的即时反馈）
    toggleGroupLockLocal: (state, action: PayloadAction<string>) => {
      const groupId = action.payload;
      const group = state.groups.find(g => g.id === groupId);
      if (group) {
        group.isLocked = !group.isLocked;
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // loadGroups
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
      
      // saveGroup
      .addCase(saveGroup.fulfilled, (state, action) => {
        state.groups.unshift(action.payload);
      })
      
      // updateGroup
      .addCase(updateGroup.fulfilled, (state, action) => {
        const index = state.groups.findIndex(g => g.id === action.payload.id);
        if (index !== -1) {
          state.groups[index] = action.payload;
        }
      })
      
      // deleteGroup
      .addCase(deleteGroup.fulfilled, (state, action) => {
        state.groups = state.groups.filter(g => g.id !== action.payload);
        if (state.activeGroupId === action.payload) {
          state.activeGroupId = null;
        }
      })
      
      // updateGroupName
      .addCase(updateGroupName.fulfilled, (state, action) => {
        const { groupId, name } = action.payload;
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
          group.name = name;
          group.updatedAt = new Date().toISOString();
        }
      })
      
      // toggleGroupLock
      .addCase(toggleGroupLock.fulfilled, (state, action) => {
        const { groupId, isLocked } = action.payload;
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
          group.isLocked = isLocked;
          group.updatedAt = new Date().toISOString();
        }
      })
      
      // deleteAllGroups
      .addCase(deleteAllGroups.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteAllGroups.fulfilled, (state) => {
        state.isLoading = false;
        state.groups = [];
        state.activeGroupId = null;
      })
      .addCase(deleteAllGroups.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '删除所有标签组失败';
      });
  },
});

export const {
  setActiveGroup,
  setSearchQuery,
  setError,
  updateGroupNameLocal,
  toggleGroupLockLocal,
} = tabGroupsSlice.actions;

export default tabGroupsSlice.reducer;