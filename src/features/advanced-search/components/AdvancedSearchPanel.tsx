/**
 * 高级搜索面板组件
 * 提供多维度的搜索和过滤选项
 */
import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import {
  updateFilters,
  resetFilters,
  setSorting,
  setActiveFilterTab,
  toggleAdvancedPanel,
  saveSearch,
  loadSavedSearch,
  deleteSavedSearch,
} from '../store/advancedSearchSlice';
import { cn } from '@/shared/utils/cn';

interface AdvancedSearchPanelProps {
  className?: string;
}

export const AdvancedSearchPanel: React.FC<AdvancedSearchPanelProps> = ({
  className,
}) => {
  const dispatch = useAppDispatch();

  // 标记未使用的函数（避免TypeScript警告）
  void deleteSavedSearch;
  const { 
    filters, 
    sortBy, 
    sortOrder, 
    isAdvancedPanelOpen, 
    activeFilterTab,
    savedSearches 
  } = useAppSelector(state => state.advancedSearch);
  
  const [saveSearchName, setSaveSearchName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // 过滤器标签页
  const filterTabs = [
    { id: 'basic', label: '基础', icon: '🔍' },
    { id: 'date', label: '日期', icon: '📅' },
    { id: 'domain', label: '域名', icon: '🌐' },
    { id: 'content', label: '内容', icon: '📄' },
  ] as const;

  // 处理保存搜索
  const handleSaveSearch = () => {
    if (saveSearchName.trim()) {
      dispatch(saveSearch({ name: saveSearchName.trim() }));
      setSaveSearchName('');
      setShowSaveDialog(false);
    }
  };

  if (!isAdvancedPanelOpen) {
    return (
      <div className={cn("flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700", className)}>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => dispatch(toggleAdvancedPanel())}
            className="flex items-center space-x-2 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4" />
            </svg>
            <span>高级搜索</span>
          </button>
          
          {savedSearches.length > 0 && (
            <div className="flex items-center space-x-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">快速搜索:</span>
              {savedSearches.slice(0, 3).map(search => (
                <button
                  key={search.id}
                  onClick={() => dispatch(loadSavedSearch(search.id))}
                  className="px-2 py-1 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  {search.name}
                </button>
              ))}
            </div>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          <select
            value={`${sortBy}-${sortOrder}`}
            onChange={(e) => {
              const [newSortBy, newSortOrder] = e.target.value.split('-') as [typeof sortBy, typeof sortOrder];
              dispatch(setSorting({ sortBy: newSortBy, sortOrder: newSortOrder }));
            }}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value="date-desc">最新创建</option>
            <option value="date-asc">最早创建</option>
            <option value="name-asc">名称 A-Z</option>
            <option value="name-desc">名称 Z-A</option>
            <option value="tabCount-desc">标签页最多</option>
            <option value="tabCount-asc">标签页最少</option>
            <option value="domain-asc">域名 A-Z</option>
          </select>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700", className)}>
      {/* 头部控制栏 */}
      <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center space-x-3">
          <button
            onClick={() => dispatch(toggleAdvancedPanel())}
            className="flex items-center space-x-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="font-medium">高级搜索</span>
          </button>
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowSaveDialog(true)}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            保存搜索
          </button>
          <button
            onClick={() => dispatch(resetFilters())}
            className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* 过滤器标签页 */}
      <div className="flex border-b border-gray-100 dark:border-gray-700">
        {filterTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => dispatch(setActiveFilterTab(tab.id))}
            className={cn(
              "flex items-center space-x-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
              activeFilterTab === tab.id
                ? "border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            )}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 过滤器内容 */}
      <div className="p-4">
        {activeFilterTab === 'basic' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  最少标签页数
                </label>
                <input
                  type="number"
                  min="0"
                  value={filters.minTabCount || ''}
                  onChange={(e) => dispatch(updateFilters({ 
                    minTabCount: e.target.value ? parseInt(e.target.value) : undefined 
                  }))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  placeholder="不限制"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  最多标签页数
                </label>
                <input
                  type="number"
                  min="0"
                  value={filters.maxTabCount || ''}
                  onChange={(e) => dispatch(updateFilters({ 
                    maxTabCount: e.target.value ? parseInt(e.target.value) : undefined 
                  }))}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  placeholder="不限制"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.isLocked === true}
                  onChange={(e) => dispatch(updateFilters({ 
                    isLocked: e.target.checked ? true : undefined 
                  }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">只显示已锁定的标签组</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.isLocked === false}
                  onChange={(e) => dispatch(updateFilters({ 
                    isLocked: e.target.checked ? false : undefined 
                  }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">只显示未锁定的标签组</span>
              </label>
            </div>
          </div>
        )}

        {activeFilterTab === 'date' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                创建时间范围
              </label>
              <select
                value={filters.dateRange}
                onChange={(e) => dispatch(updateFilters({ dateRange: e.target.value as any }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="all">全部时间</option>
                <option value="today">今天</option>
                <option value="week">最近一周</option>
                <option value="month">最近一个月</option>
                <option value="custom">自定义范围</option>
              </select>
            </div>
            
            {filters.dateRange === 'custom' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    开始日期
                  </label>
                  <input
                    type="date"
                    value={filters.customDateStart || ''}
                    onChange={(e) => dispatch(updateFilters({ customDateStart: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    结束日期
                  </label>
                  <input
                    type="date"
                    value={filters.customDateEnd || ''}
                    onChange={(e) => dispatch(updateFilters({ customDateEnd: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {activeFilterTab === 'domain' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                包含域名 (用逗号分隔)
              </label>
              <input
                type="text"
                value={filters.domains.join(', ')}
                onChange={(e) => dispatch(updateFilters({ 
                  domains: e.target.value.split(',').map(d => d.trim()).filter(Boolean)
                }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="例如: github.com, stackoverflow.com"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                排除域名 (用逗号分隔)
              </label>
              <input
                type="text"
                value={filters.excludeDomains.join(', ')}
                onChange={(e) => dispatch(updateFilters({ 
                  excludeDomains: e.target.value.split(',').map(d => d.trim()).filter(Boolean)
                }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="例如: ads.google.com, facebook.com"
              />
            </div>
            
            <div className="space-y-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.isHttps === true}
                  onChange={(e) => dispatch(updateFilters({ 
                    isHttps: e.target.checked ? true : undefined 
                  }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">只显示 HTTPS 网站</span>
              </label>
            </div>
          </div>
        )}

        {activeFilterTab === 'content' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.includeUrls}
                  onChange={(e) => dispatch(updateFilters({ includeUrls: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">搜索 URL</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.includeTitles}
                  onChange={(e) => dispatch(updateFilters({ includeTitles: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">搜索标题</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.useRegex}
                  onChange={(e) => dispatch(updateFilters({ useRegex: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">使用正则表达式</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.caseSensitive}
                  onChange={(e) => dispatch(updateFilters({ caseSensitive: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">区分大小写</span>
              </label>
            </div>
            
            <div className="space-y-2">
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.hasTitle}
                  onChange={(e) => dispatch(updateFilters({ hasTitle: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">必须有标题</span>
              </label>
              
              <label className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={filters.hasFavicon}
                  onChange={(e) => dispatch(updateFilters({ hasFavicon: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">必须有图标</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* 保存搜索对话框 */}
      {showSaveDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              保存搜索条件
            </h3>
            <input
              type="text"
              value={saveSearchName}
              onChange={(e) => setSaveSearchName(e.target.value)}
              placeholder="输入搜索名称"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 mb-4"
              autoFocus
            />
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveSearch}
                disabled={!saveSearchName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
