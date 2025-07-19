/**
 * 高级搜索状态管理
 * 处理多维度搜索和过滤功能
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { TabGroup, Tab } from '@/shared/types/tab';

export type SearchMode = 'simple' | 'advanced';
export type SortBy = 'name' | 'date' | 'tabCount' | 'domain';
export type SortOrder = 'asc' | 'desc';
export type DateRange = 'all' | 'today' | 'week' | 'month' | 'custom';

interface SearchFilters {
  // 基础搜索
  query: string;
  
  // 日期过滤
  dateRange: DateRange;
  customDateStart?: string;
  customDateEnd?: string;
  
  // 域名过滤
  domains: string[];
  excludeDomains: string[];
  
  // 标签组属性过滤
  isLocked?: boolean;
  minTabCount?: number;
  maxTabCount?: number;
  
  // 标签页属性过滤
  hasTitle: boolean;
  hasFavicon: boolean;
  isHttps?: boolean;
  
  // 内容过滤
  includeUrls: boolean;
  includeTitles: boolean;
  useRegex: boolean;
  caseSensitive: boolean;
}

interface SearchResult {
  groups: TabGroup[];
  totalGroups: number;
  totalTabs: number;
  searchTime: number; // 搜索耗时（毫秒）
}

interface AdvancedSearchState {
  // 搜索模式
  mode: SearchMode;
  
  // 搜索过滤器
  filters: SearchFilters;
  
  // 排序设置
  sortBy: SortBy;
  sortOrder: SortOrder;
  
  // 搜索结果
  results: SearchResult | null;
  
  // 搜索历史
  searchHistory: Array<{
    id: string;
    query: string;
    filters: Partial<SearchFilters>;
    timestamp: string;
    resultCount: number;
  }>;
  
  // 常用搜索
  savedSearches: Array<{
    id: string;
    name: string;
    filters: SearchFilters;
    createdAt: string;
  }>;
  
  // 状态
  isSearching: boolean;
  error: string | null;
  
  // UI状态
  isAdvancedPanelOpen: boolean;
  activeFilterTab: 'basic' | 'date' | 'domain' | 'content';
}

const defaultFilters: SearchFilters = {
  query: '',
  dateRange: 'all',
  domains: [],
  excludeDomains: [],
  hasTitle: true,
  hasFavicon: false,
  includeUrls: true,
  includeTitles: true,
  useRegex: false,
  caseSensitive: false,
};

const initialState: AdvancedSearchState = {
  mode: 'simple',
  filters: defaultFilters,
  sortBy: 'date',
  sortOrder: 'desc',
  results: null,
  searchHistory: [],
  savedSearches: [],
  isSearching: false,
  error: null,
  isAdvancedPanelOpen: false,
  activeFilterTab: 'basic',
};

// 异步搜索操作
export const performAdvancedSearch = createAsyncThunk(
  'advancedSearch/performSearch',
  async ({ groups, filters, sortBy, sortOrder }: {
    groups: TabGroup[];
    filters: SearchFilters;
    sortBy: SortBy;
    sortOrder: SortOrder;
  }) => {
    const startTime = Date.now();
    
    logger.debug('执行高级搜索', { filters, sortBy, sortOrder });
    
    // 过滤标签组
    let filteredGroups = groups.filter(group => {
      // 基础查询过滤
      if (filters.query) {
        const query = filters.caseSensitive ? filters.query : filters.query.toLowerCase();
        const searchText = filters.caseSensitive ? 
          `${group.name} ${group.tabs.map(tab => `${tab.title} ${tab.url}`).join(' ')}` :
          `${group.name} ${group.tabs.map(tab => `${tab.title} ${tab.url}`).join(' ')}`.toLowerCase();
        
        if (filters.useRegex) {
          try {
            const regex = new RegExp(query, filters.caseSensitive ? 'g' : 'gi');
            if (!regex.test(searchText)) return false;
          } catch (error) {
            // 正则表达式无效，使用普通搜索
            if (!searchText.includes(query)) return false;
          }
        } else {
          if (!searchText.includes(query)) return false;
        }
      }
      
      // 日期范围过滤
      if (filters.dateRange !== 'all') {
        const groupDate = new Date(group.createdAt);
        const now = new Date();
        
        switch (filters.dateRange) {
          case 'today':
            if (groupDate.toDateString() !== now.toDateString()) return false;
            break;
          case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            if (groupDate < weekAgo) return false;
            break;
          case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            if (groupDate < monthAgo) return false;
            break;
          case 'custom':
            if (filters.customDateStart && groupDate < new Date(filters.customDateStart)) return false;
            if (filters.customDateEnd && groupDate > new Date(filters.customDateEnd)) return false;
            break;
        }
      }
      
      // 标签组属性过滤
      if (filters.isLocked !== undefined && group.isLocked !== filters.isLocked) return false;
      if (filters.minTabCount !== undefined && group.tabs.length < filters.minTabCount) return false;
      if (filters.maxTabCount !== undefined && group.tabs.length > filters.maxTabCount) return false;
      
      // 域名过滤
      if (filters.domains.length > 0) {
        const groupDomains = group.tabs.map(tab => {
          try {
            return new URL(tab.url).hostname;
          } catch {
            return '';
          }
        }).filter(Boolean);
        
        const hasIncludedDomain = filters.domains.some(domain => 
          groupDomains.some(groupDomain => groupDomain.includes(domain))
        );
        if (!hasIncludedDomain) return false;
      }
      
      if (filters.excludeDomains.length > 0) {
        const groupDomains = group.tabs.map(tab => {
          try {
            return new URL(tab.url).hostname;
          } catch {
            return '';
          }
        }).filter(Boolean);
        
        const hasExcludedDomain = filters.excludeDomains.some(domain => 
          groupDomains.some(groupDomain => groupDomain.includes(domain))
        );
        if (hasExcludedDomain) return false;
      }
      
      // 标签页属性过滤
      if (filters.hasTitle && group.tabs.some(tab => !tab.title || tab.title.trim() === '')) return false;
      if (filters.hasFavicon && group.tabs.some(tab => !tab.favicon)) return false;
      if (filters.isHttps !== undefined) {
        const hasHttps = group.tabs.some(tab => tab.url.startsWith('https://'));
        if (filters.isHttps && !hasHttps) return false;
        if (!filters.isHttps && hasHttps) return false;
      }
      
      return true;
    });
    
    // 排序
    filteredGroups.sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'tabCount':
          comparison = a.tabs.length - b.tabs.length;
          break;
        case 'domain':
          const aDomain = a.tabs[0] ? new URL(a.tabs[0].url).hostname : '';
          const bDomain = b.tabs[0] ? new URL(b.tabs[0].url).hostname : '';
          comparison = aDomain.localeCompare(bDomain);
          break;
      }
      
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    
    const searchTime = Date.now() - startTime;
    const totalTabs = filteredGroups.reduce((sum, group) => sum + group.tabs.length, 0);
    
    return {
      groups: filteredGroups,
      totalGroups: filteredGroups.length,
      totalTabs,
      searchTime,
    };
  }
);

// 高级搜索slice
const advancedSearchSlice = createSlice({
  name: 'advancedSearch',
  initialState,
  reducers: {
    // 设置搜索模式
    setSearchMode: (state, action: PayloadAction<SearchMode>) => {
      state.mode = action.payload;
    },

    // 更新过滤器
    updateFilters: (state, action: PayloadAction<Partial<SearchFilters>>) => {
      state.filters = { ...state.filters, ...action.payload };
    },

    // 重置过滤器
    resetFilters: (state) => {
      state.filters = defaultFilters;
    },

    // 设置排序
    setSorting: (state, action: PayloadAction<{ sortBy: SortBy; sortOrder: SortOrder }>) => {
      state.sortBy = action.payload.sortBy;
      state.sortOrder = action.payload.sortOrder;
    },

    // 切换高级面板
    toggleAdvancedPanel: (state) => {
      state.isAdvancedPanelOpen = !state.isAdvancedPanelOpen;
    },

    // 设置活动过滤器标签
    setActiveFilterTab: (state, action: PayloadAction<'basic' | 'date' | 'domain' | 'content'>) => {
      state.activeFilterTab = action.payload;
    },

    // 添加搜索历史
    addSearchHistory: (state, action: PayloadAction<{
      query: string;
      filters: Partial<SearchFilters>;
      resultCount: number;
    }>) => {
      const historyItem = {
        id: `search-${Date.now()}`,
        timestamp: new Date().toISOString(),
        ...action.payload,
      };
      
      state.searchHistory.unshift(historyItem);
      
      // 只保留最近20个搜索记录
      if (state.searchHistory.length > 20) {
        state.searchHistory = state.searchHistory.slice(0, 20);
      }
    },

    // 保存搜索
    saveSearch: (state, action: PayloadAction<{ name: string }>) => {
      const savedSearch = {
        id: `saved-${Date.now()}`,
        name: action.payload.name,
        filters: state.filters,
        createdAt: new Date().toISOString(),
      };
      
      state.savedSearches.push(savedSearch);
    },

    // 删除保存的搜索
    deleteSavedSearch: (state, action: PayloadAction<string>) => {
      state.savedSearches = state.savedSearches.filter(search => search.id !== action.payload);
    },

    // 加载保存的搜索
    loadSavedSearch: (state, action: PayloadAction<string>) => {
      const savedSearch = state.savedSearches.find(search => search.id === action.payload);
      if (savedSearch) {
        state.filters = savedSearch.filters;
      }
    },

    // 清除搜索结果
    clearResults: (state) => {
      state.results = null;
    },

    // 清除错误
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(performAdvancedSearch.pending, (state) => {
        state.isSearching = true;
        state.error = null;
      })
      .addCase(performAdvancedSearch.fulfilled, (state, action) => {
        state.isSearching = false;
        state.results = action.payload;
        
        // 添加到搜索历史
        if (state.filters.query) {
          advancedSearchSlice.caseReducers.addSearchHistory(state, {
            type: 'addSearchHistory',
            payload: {
              query: state.filters.query,
              filters: state.filters,
              resultCount: action.payload.totalGroups,
            },
          });
        }
      })
      .addCase(performAdvancedSearch.rejected, (state, action) => {
        state.isSearching = false;
        state.error = action.error.message || '搜索失败';
      });
  },
});

export const {
  setSearchMode,
  updateFilters,
  resetFilters,
  setSorting,
  toggleAdvancedPanel,
  setActiveFilterTab,
  addSearchHistory,
  saveSearch,
  deleteSavedSearch,
  loadSavedSearch,
  clearResults,
  clearError,
} = advancedSearchSlice.actions;

export default advancedSearchSlice.reducer;
