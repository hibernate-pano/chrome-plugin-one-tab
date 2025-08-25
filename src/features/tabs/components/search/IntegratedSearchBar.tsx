import React, { useState, useCallback, useEffect, memo } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { SearchQuery, SearchMode, searchService } from '../../services/SearchService';
import { searchHistoryService } from '../../services/SearchHistoryService';
import { AdvancedSearchPanel } from './AdvancedSearchPanel';
import { SearchHistoryPanel } from './SearchHistoryPanel';
import { useDebounce } from '@/shared/hooks/useMemoryOptimization';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { logger } from '@/shared/utils/logger';

interface IntegratedSearchBarProps {
  onSearch: (query: SearchQuery) => void;
  placeholder?: string;
  className?: string;
}

const IntegratedSearchBarComponent: React.FC<IntegratedSearchBarProps> = ({
  onSearch,
  placeholder = '搜索标签组和标签...',
  className = ''
}) => {
  const { groups } = useAppSelector(state => state.tabGroups);
  const [searchValue, setSearchValue] = useState('');
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  // 防抖的搜索建议获取
  const debouncedGetSuggestions = useDebounce(
    async (keyword: string) => {
      if (keyword.length >= 2) {
        try {
          const [historySuggestions, contentSuggestions] = await Promise.all([
            searchHistoryService.getSearchSuggestions(keyword, 3),
            searchService.getSearchSuggestions(groups, keyword, SearchMode.SIMPLE)
          ]);
          
          // 合并并去重建议
          const allSuggestions = [...new Set([...historySuggestions, ...contentSuggestions])];
          setSuggestions(allSuggestions.slice(0, 8));
          setShowSuggestions(true);
        } catch (error) {
          logger.error('获取搜索建议失败', error);
        }
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    300,
    [groups]
  );

  // 监听搜索值变化
  useEffect(() => {
    debouncedGetSuggestions(searchValue);
  }, [searchValue, debouncedGetSuggestions]);

  // 执行搜索
  const handleSearch = useCallback(async (query?: SearchQuery) => {
    const searchQuery = query || {
      keyword: searchValue.trim(),
      mode: SearchMode.SIMPLE,
      filters: {},
      sortBy: 'relevance' as const,
      sortOrder: 'desc' as const
    };

    if (!searchQuery.keyword && Object.keys(searchQuery.filters).length === 0) {
      return;
    }

    try {
      setIsSearching(true);
      const startTime = performance.now();
      
      // 执行搜索
      const result = await searchService.search(groups, searchQuery);
      
      const executionTime = performance.now() - startTime;
      
      // 保存搜索历史
      await searchHistoryService.addSearchHistory(
        searchQuery,
        result.totalCount,
        executionTime
      );
      
      // 调用父组件的搜索回调
      onSearch(searchQuery);
      
      // 隐藏建议
      setShowSuggestions(false);
      
      logger.debug('搜索完成', {
        keyword: searchQuery.keyword,
        resultCount: result.totalCount,
        executionTime: `${executionTime.toFixed(2)}ms`
      });
    } catch (error) {
      logger.error('搜索失败', error);
    } finally {
      setIsSearching(false);
    }
  }, [searchValue, groups, onSearch]);

  // 处理输入变化
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchValue(e.target.value);
  }, []);

  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  }, [handleSearch]);

  // 使用建议
  const handleUseSuggestion = useCallback((suggestion: string) => {
    setSearchValue(suggestion);
    setShowSuggestions(false);
    // 自动执行搜索
    setTimeout(() => {
      handleSearch({
        keyword: suggestion,
        mode: SearchMode.SIMPLE,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      });
    }, 100);
  }, [handleSearch]);

  // 清空搜索
  const handleClearSearch = useCallback(() => {
    setSearchValue('');
    setSuggestions([]);
    setShowSuggestions(false);
    // 执行空搜索以显示所有结果
    onSearch({
      keyword: '',
      mode: SearchMode.SIMPLE,
      filters: {},
      sortBy: 'relevance',
      sortOrder: 'desc'
    });
  }, [onSearch]);

  // 处理高级搜索
  const handleAdvancedSearch = useCallback((query: SearchQuery) => {
    setSearchValue(query.keyword);
    handleSearch(query);
  }, [handleSearch]);

  // 处理历史搜索选择
  const handleHistorySearch = useCallback((query: SearchQuery) => {
    setSearchValue(query.keyword);
    handleSearch(query);
  }, [handleSearch]);

  return (
    <div className={`relative ${className}`}>
      {/* 搜索输入框 */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <svg
            className="h-5 w-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        
        <input
          type="text"
          value={searchValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => searchValue.length >= 2 && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder={placeholder}
          className="block w-full pl-10 pr-20 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
        />
        
        {/* 右侧按钮组 */}
        <div className="absolute inset-y-0 right-0 flex items-center space-x-1 pr-2">
          {searchValue && (
            <button
              onClick={handleClearSearch}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title="清空搜索"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          
          <button
            onClick={() => setShowSearchHistory(true)}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="搜索历史"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          
          <button
            onClick={() => setShowAdvancedSearch(true)}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="高级搜索"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4" />
            </svg>
          </button>
          
          {isSearching ? (
            <div className="p-1">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <button
              onClick={() => handleSearch()}
              className="p-1 text-blue-600 hover:text-blue-700 transition-colors"
              title="搜索"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 搜索建议下拉列表 */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg mt-1 shadow-lg z-20 max-h-64 overflow-y-auto">
          {suggestions.map((suggestion, index) => (
            <button
              key={index}
              onClick={() => handleUseSuggestion(suggestion)}
              className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-600 first:rounded-t-lg last:rounded-b-lg transition-colors"
            >
              <div className="flex items-center space-x-2">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="text-gray-900 dark:text-white">{suggestion}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 高级搜索面板 */}
      {showAdvancedSearch && (
        <AdvancedSearchPanel
          onSearch={handleAdvancedSearch}
          onClose={() => setShowAdvancedSearch(false)}
          initialQuery={{ keyword: searchValue }}
        />
      )}

      {/* 搜索历史面板 */}
      {showSearchHistory && (
        <SearchHistoryPanel
          onSelectSearch={handleHistorySearch}
          onClose={() => setShowSearchHistory(false)}
        />
      )}
    </div>
  );
};

// 使用memo优化组件性能
export const IntegratedSearchBar = memo(
  IntegratedSearchBarComponent,
  createMemoComparison(['onSearch', 'placeholder', 'className'])
);
