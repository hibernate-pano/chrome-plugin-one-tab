import React, { useState, useEffect, useCallback, memo } from 'react';
import { searchHistoryService, SearchHistoryItem, SearchStatistics } from '../../services/SearchHistoryService';
import { SearchQuery, SearchMode } from '../../services/SearchService';
import { createMemoComparison } from '@/shared/utils/performanceOptimizer';
import { logger } from '@/shared/utils/logger';

interface SearchHistoryPanelProps {
  onSelectSearch: (query: SearchQuery) => void;
  onClose: () => void;
}

const SearchHistoryPanelComponent: React.FC<SearchHistoryPanelProps> = ({
  onSelectSearch,
  onClose
}) => {
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [favoriteSearches, setFavoriteSearches] = useState<SearchHistoryItem[]>([]);
  const [statistics, setStatistics] = useState<SearchStatistics | null>(null);
  const [activeTab, setActiveTab] = useState<'history' | 'favorites' | 'stats'>('history');
  const [isLoading, setIsLoading] = useState(true);

  // 加载数据
  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [history, favorites, stats] = await Promise.all([
        searchHistoryService.getSearchHistory(),
        searchHistoryService.getFavoriteSearches(),
        searchHistoryService.getSearchStatistics()
      ]);
      
      setSearchHistory(history);
      setFavoriteSearches(favorites);
      setStatistics(stats);
    } catch (error) {
      logger.error('加载搜索历史数据失败', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 切换收藏状态
  const handleToggleFavorite = useCallback(async (searchId: string) => {
    try {
      await searchHistoryService.toggleFavorite(searchId);
      await loadData(); // 重新加载数据
    } catch (error) {
      logger.error('切换收藏状态失败', error);
    }
  }, [loadData]);

  // 删除搜索历史
  const handleDeleteSearch = useCallback(async (searchId: string) => {
    try {
      await searchHistoryService.deleteSearchHistory(searchId);
      await loadData(); // 重新加载数据
    } catch (error) {
      logger.error('删除搜索历史失败', error);
    }
  }, [loadData]);

  // 清空搜索历史
  const handleClearHistory = useCallback(async (keepFavorites: boolean = true) => {
    try {
      await searchHistoryService.clearSearchHistory(keepFavorites);
      await loadData(); // 重新加载数据
    } catch (error) {
      logger.error('清空搜索历史失败', error);
    }
  }, [loadData]);

  // 使用搜索
  const handleUseSearch = useCallback((item: SearchHistoryItem) => {
    onSelectSearch(item.query);
    onClose();
  }, [onSelectSearch, onClose]);

  // 格式化搜索模式显示
  const formatSearchMode = (mode: SearchMode): string => {
    switch (mode) {
      case SearchMode.SIMPLE: return '简单';
      case SearchMode.FUZZY: return '模糊';
      case SearchMode.REGEX: return '正则';
      case SearchMode.ADVANCED: return '高级';
      default: return '未知';
    }
  };

  // 格式化时间显示
  const formatTime = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
      return '今天';
    } else if (diffDays === 1) {
      return '昨天';
    } else if (diffDays < 7) {
      return `${diffDays}天前`;
    } else {
      return date.toLocaleDateString();
    }
  };

  // 渲染搜索项
  const renderSearchItem = (item: SearchHistoryItem, showFavoriteButton: boolean = true) => (
    <div
      key={item.id}
      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
    >
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleUseSearch(item)}>
        <div className="flex items-center space-x-2 mb-1">
          <span className="font-medium text-gray-900 dark:text-white truncate">
            {item.query.keyword || '(空搜索)'}
          </span>
          <span className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded">
            {formatSearchMode(item.query.mode)}
          </span>
          {item.isFavorite && (
            <span className="text-yellow-500">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            </span>
          )}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {item.resultCount} 个结果 • {formatTime(item.timestamp)} • {item.executionTime.toFixed(1)}ms
        </div>
        {Object.keys(item.query.filters).length > 0 && (
          <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            过滤器: {Object.keys(item.query.filters).join(', ')}
          </div>
        )}
      </div>
      
      <div className="flex items-center space-x-2 ml-3">
        {showFavoriteButton && (
          <button
            onClick={() => handleToggleFavorite(item.id)}
            className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-500 transition-colors ${
              item.isFavorite ? 'text-yellow-500' : 'text-gray-400'
            }`}
            title={item.isFavorite ? '取消收藏' : '添加收藏'}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </button>
        )}
        <button
          onClick={() => handleDeleteSearch(item.id)}
          className="p-1 text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-gray-500 rounded transition-colors"
          title="删除"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6">
          <div className="flex items-center space-x-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            <span className="text-gray-700 dark:text-gray-300">加载搜索历史...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden">
        <div className="p-6">
          {/* 标题栏 */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              搜索历史
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

          {/* 标签页 */}
          <div className="flex border-b border-gray-200 dark:border-gray-600 mb-6">
            <button
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'history'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              搜索历史 ({searchHistory.length})
            </button>
            <button
              onClick={() => setActiveTab('favorites')}
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'favorites'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              收藏搜索 ({favoriteSearches.length})
            </button>
            <button
              onClick={() => setActiveTab('stats')}
              className={`px-4 py-2 font-medium transition-colors ${
                activeTab === 'stats'
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              }`}
            >
              搜索统计
            </button>
          </div>

          {/* 内容区域 */}
          <div className="max-h-96 overflow-y-auto">
            {activeTab === 'history' && (
              <div>
                {searchHistory.length > 0 ? (
                  <div className="space-y-3">
                    <div className="flex justify-end mb-3">
                      <button
                        onClick={() => handleClearHistory(true)}
                        className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      >
                        清空历史（保留收藏）
                      </button>
                    </div>
                    {searchHistory.map(item => renderSearchItem(item))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    暂无搜索历史
                  </div>
                )}
              </div>
            )}

            {activeTab === 'favorites' && (
              <div>
                {favoriteSearches.length > 0 ? (
                  <div className="space-y-3">
                    {favoriteSearches.map(item => renderSearchItem(item, false))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    暂无收藏的搜索
                  </div>
                )}
              </div>
            )}

            {activeTab === 'stats' && statistics && (
              <div className="space-y-6">
                {/* 基础统计 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                    <div className="text-2xl font-bold text-blue-600">{statistics.totalSearches}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">总搜索次数</div>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                    <div className="text-2xl font-bold text-green-600">{statistics.averageExecutionTime.toFixed(1)}ms</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">平均执行时间</div>
                  </div>
                </div>

                {/* 热门关键词 */}
                {statistics.mostUsedKeywords.length > 0 && (
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">热门关键词</h3>
                    <div className="space-y-2">
                      {statistics.mostUsedKeywords.slice(0, 5).map((item, index) => (
                        <div key={index} className="flex justify-between items-center">
                          <span className="text-gray-700 dark:text-gray-300">{item.keyword}</span>
                          <span className="text-sm text-gray-500 dark:text-gray-400">{item.count} 次</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 搜索模式使用统计 */}
                <div>
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">搜索模式使用</h3>
                  <div className="space-y-2">
                    {Object.entries(statistics.searchModeUsage).map(([mode, count]) => (
                      <div key={mode} className="flex justify-between items-center">
                        <span className="text-gray-700 dark:text-gray-300">{formatSearchMode(mode as SearchMode)}</span>
                        <span className="text-sm text-gray-500 dark:text-gray-400">{count} 次</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// 使用memo优化组件性能
export const SearchHistoryPanel = memo(
  SearchHistoryPanelComponent,
  createMemoComparison(['onSelectSearch', 'onClose'])
);
