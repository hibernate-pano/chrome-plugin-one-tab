/**
 * 标签页基础状态管理
 * 处理标签页的基本增删改查操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { Tab } from '@/shared/types/tab';

interface TabsState {
  tabs: Record<string, Tab>;
  selectedTabIds: string[];
  isLoading: boolean;
  error: string | null;
}

const initialState: TabsState = {
  tabs: {},
  selectedTabIds: [],
  isLoading: false,
  error: null,
};

// 异步操作
export const loadTab = createAsyncThunk(
  'tabs/loadTab',
  async (tabId: string) => {
    logger.debug('加载标签页', { tabId });
    // 从存储中加载特定标签页
    const groups = await storage.getGroups();
    for (const group of groups) {
      const tab = group.tabs.find(t => t.id === tabId);
      if (tab) {
        return tab;
      }
    }
    throw new Error(`标签页 ${tabId} 未找到`);
  }
);

export const deleteTab = createAsyncThunk(
  'tabs/deleteTab',
  async ({ groupId, tabId }: { groupId: string; tabId: string }) => {
    logger.debug('删除标签页', { groupId, tabId });
    
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }
    
    const updatedTabs = group.tabs.filter(t => t.id !== tabId);
    const updatedGroup = {
      ...group,
      tabs: updatedTabs,
      updatedAt: new Date().toISOString(),
    };
    
    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);
    
    return { groupId, tabId, shouldDeleteGroup: updatedTabs.length === 0 && !group.isLocked };
  }
);

export const updateTab = createAsyncThunk(
  'tabs/updateTab',
  async ({ groupId, tab }: { groupId: string; tab: Tab }) => {
    logger.debug('更新标签页', { groupId, tabId: tab.id });
    
    const groups = await storage.getGroups();
    const group = groups.find(g => g.id === groupId);
    
    if (!group) {
      throw new Error(`标签组 ${groupId} 未找到`);
    }
    
    const updatedTabs = group.tabs.map(t => t.id === tab.id ? { ...tab, updatedAt: new Date().toISOString() } : t);
    const updatedGroup = {
      ...group,
      tabs: updatedTabs,
      updatedAt: new Date().toISOString(),
    };
    
    const updatedGroups = groups.map(g => g.id === groupId ? updatedGroup : g);
    await storage.setGroups(updatedGroups);
    
    return { groupId, tab };
  }
);

// Slice定义
const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    selectTab: (state, action: PayloadAction<string>) => {
      const tabId = action.payload;
      if (!state.selectedTabIds.includes(tabId)) {
        state.selectedTabIds.push(tabId);
      }
    },
    
    deselectTab: (state, action: PayloadAction<string>) => {
      const tabId = action.payload;
      state.selectedTabIds = state.selectedTabIds.filter(id => id !== tabId);
    },
    
    selectAllTabs: (state, action: PayloadAction<string[]>) => {
      state.selectedTabIds = action.payload;
    },
    
    clearSelection: (state) => {
      state.selectedTabIds = [];
    },
    
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // loadTab
      .addCase(loadTab.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadTab.fulfilled, (state, action) => {
        state.isLoading = false;
        state.tabs[action.payload.id] = action.payload;
      })
      .addCase(loadTab.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '加载标签页失败';
      })
      
      // deleteTab
      .addCase(deleteTab.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteTab.fulfilled, (state, action) => {
        state.isLoading = false;
        const { tabId } = action.payload;
        delete state.tabs[tabId];
        state.selectedTabIds = state.selectedTabIds.filter(id => id !== tabId);
      })
      .addCase(deleteTab.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '删除标签页失败';
      })
      
      // updateTab
      .addCase(updateTab.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateTab.fulfilled, (state, action) => {
        state.isLoading = false;
        const { tab } = action.payload;
        state.tabs[tab.id] = tab;
      })
      .addCase(updateTab.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '更新标签页失败';
      });
  },
});

export const { selectTab, deselectTab, selectAllTabs, clearSelection, setError } = tabsSlice.actions;
export default tabsSlice.reducer;