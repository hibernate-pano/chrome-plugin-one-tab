import React, { useState, useCallback, useEffect, memo } from 'react';
import { SearchQuery, SearchMode, searchService } from '../../services/SearchService';
import { searchHistoryService, SearchHistoryItem } from '../../services/SearchHistoryService';
import { useDebounce } from '@/shared/hooks/useMemoryOptimization';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { logger } from '@/shared/utils/logger';

interface AdvancedSearchPanelProps {
  onSearch: (query: SearchQuery) => void;
  onClose: () => void;
  initialQuery?: Partial<SearchQuery>;
}

const AdvancedSearchPanelComponent: React.FC<AdvancedSearchPanelProps> = ({
  onSearch,
  onClose,
  initialQuery = {}
}) => {
  const [query, setQuery] = useState<SearchQuery>({
    keyword: '',
    mode: SearchMode.SIMPLE,
    fuzzyThreshold: 0.6,
    caseSensitive: false,
    wholeWord: false,
    filters: {},
    sortBy: 'relevance',
    sortOrder: 'desc',
    ...initialQuery
  });

  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // 防抖的搜索建议获取
  const debouncedGetSuggestions = useDebounce(
    async (keyword: string) => {
      if (keyword.length >= 2) {
        try {
          const historySuggestions = await searchHistoryService.getSearchSuggestions(keyword, 5);
          setSuggestions(historySuggestions);
        } catch (error) {
          logger.error('获取搜索建议失败', error);
        }
      } else {
        setSuggestions([]);
      }
    },
    300,
    []
  );

  // 加载搜索历史
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await searchHistoryService.getSearchHistory();
        setSearchHistory(history.slice(0, 10)); // 只显示最近10条
      } catch (error) {
        logger.error('加载搜索历史失败', error);
      }
    };

    loadHistory();
  }, []);

  // 监听关键词变化，获取搜索建议
  useEffect(() => {
    debouncedGetSuggestions(query.keyword);
  }, [query.keyword, debouncedGetSuggestions]);

  // 更新查询
  const updateQuery = useCallback((updates: Partial<SearchQuery>) => {
    setQuery(prev => ({ ...prev, ...updates }));
  }, []);

  // 更新过滤器
  const updateFilters = useCallback((filterUpdates: Partial<SearchQuery['filters']>) => {
    setQuery(prev => ({
      ...prev,
      filters: { ...prev.filters, ...filterUpdates }
    }));
  }, []);

  // 执行搜索
  const handleSearch = useCallback(() => {
    onSearch(query);
    onClose();
  }, [query, onSearch, onClose]);

  // 使用历史搜索
  const useHistorySearch = useCallback((historyItem: SearchHistoryItem) => {
    setQuery(historyItem.query);
  }, []);

  // 使用搜索建议
  const useSuggestion = useCallback((suggestion: string) => {
    updateQuery({ keyword: suggestion });
    setSuggestions([]);
  }, [updateQuery]);

  // 重置查询
  const resetQuery = useCallback(() => {
    setQuery({
      keyword: '',
      mode: SearchMode.SIMPLE,
      fuzzyThreshold: 0.6,
      caseSensitive: false,
      wholeWord: false,
      filters: {},
      sortBy: 'relevance',
      sortOrder: 'desc'
    });
  }, []);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          {/* 标题栏 */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              高级搜索
            </h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* 搜索输入 */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              搜索关键词
            </label>
            <div className="relative">
              <input
                type="text"
                value={query.keyword}
                onChange={(e) => updateQuery({ keyword: e.target.value })}
                placeholder="输入搜索关键词..."
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
              />
              
              {/* 搜索建议 */}
              {suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg mt-1 shadow-lg z-10">
                  {suggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      onClick={() => useSuggestion(suggestion)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-600 first:rounded-t-lg last:rounded-b-lg"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 搜索模式 */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              搜索模式
            </label>
            <div className="grid grid-cols-2 gap-2">
              {Object.values(SearchMode).map((mode) => (
                <label key={mode} className="flex items-center">
                  <input
                    type="radio"
                    name="searchMode"
                    value={mode}
                    checked={query.mode === mode}
                    onChange={(e) => updateQuery({ mode: e.target.value as SearchMode })}
                    className="mr-2"
                  />
                  <span className="text-sm">
                    {mode === SearchMode.SIMPLE && '简单搜索'}
                    {mode === SearchMode.FUZZY && '模糊匹配'}
                    {mode === SearchMode.REGEX && '正则表达式'}
                    {mode === SearchMode.ADVANCED && '高级搜索'}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 模糊匹配阈值 */}
          {query.mode === SearchMode.FUZZY && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                模糊匹配阈值: {query.fuzzyThreshold}
              </label>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={query.fuzzyThreshold}
                onChange={(e) => updateQuery({ fuzzyThreshold: parseFloat(e.target.value) })}
                className="w-full"
              />
            </div>
          )}

          {/* 搜索选项 */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              搜索选项
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={query.caseSensitive}
                  onChange={(e) => updateQuery({ caseSensitive: e.target.checked })}
                  className="mr-2"
                />
                <span className="text-sm">区分大小写</span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={query.wholeWord}
                  onChange={(e) => updateQuery({ wholeWord: e.target.checked })}
                  className="mr-2"
                />
                <span className="text-sm">全词匹配</span>
              </label>
            </div>
          </div>

          {/* 过滤器 */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              过滤条件
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <input
                  type="text"
                  placeholder="标签组名称"
                  value={query.filters.groupName || ''}
                  onChange={(e) => updateFilters({ groupName: e.target.value || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white"
                />
              </div>
              <div>
                <input
                  type="text"
                  placeholder="域名"
                  value={query.filters.domain || ''}
                  onChange={(e) => updateFilters({ domain: e.target.value || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>
          </div>

          {/* 搜索历史 */}
          {searchHistory.length > 0 && (
            <div className="mb-6">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
              >
                搜索历史
                <svg
                  className={`w-4 h-4 ml-1 transform transition-transform ${showHistory ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {showHistory && (
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {searchHistory.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => useHistorySearch(item)}
                      className="w-full text-left px-3 py-2 bg-gray-50 dark:bg-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                    >
                      <div className="text-sm font-medium">{item.query.keyword}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {item.resultCount} 个结果 • {new Date(item.timestamp).toLocaleDateString()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end space-x-3">
            <button
              onClick={resetQuery}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              重置
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSearch}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              搜索
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const AdvancedSearchPanel = memo(
  AdvancedSearchPanelComponent,
  createMemoComparison(['onSearch', 'onClose', 'initialQuery'])
);
