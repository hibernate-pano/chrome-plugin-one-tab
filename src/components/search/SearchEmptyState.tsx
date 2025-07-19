/**
 * 搜索空状态组件
 * 专门为搜索结果设计的空状态界面
 */

import React, { useState, useEffect } from 'react';
import { EmptyState, EmptyStateAction } from '@/shared/components/EmptyState/EmptyState';
import { cn } from '@/shared/utils/cn';

export interface SearchEmptyStateProps {
  searchQuery: string;
  onClearSearch?: () => void;
  onShowAllTabs?: () => void;
  onImportData?: () => void;
  className?: string;
}

const SearchEmptyState: React.FC<SearchEmptyStateProps> = ({
  searchQuery,
  onClearSearch,
  onShowAllTabs,
  onImportData,
  className,
}) => {
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowSuggestions(true), 500);
    return () => clearTimeout(timer);
  }, []);

  // 构建操作按钮
  const actions: EmptyStateAction[] = [];

  if (onClearSearch) {
    actions.push({
      label: '清除搜索',
      onClick: onClearSearch,
      variant: 'primary',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ),
    });
  }

  if (onShowAllTabs) {
    actions.push({
      label: '查看所有标签',
      onClick: onShowAllTabs,
      variant: 'secondary',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
      ),
    });
  }

  // 搜索建议
  const suggestions = [
    '尝试使用更简短的关键词',
    '检查拼写是否正确',
    '使用标签页标题或网址进行搜索',
    '尝试搜索网站域名，如 "github"',
  ];

  // 自定义插图
  const customIllustration = (
    <div className="relative">
      {/* 搜索图标 */}
      <div className="relative">
        <div className="w-16 h-16 bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700 rounded-full flex items-center justify-center shadow-lg">
          <svg
            className="w-8 h-8 text-gray-500 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* 搜索词气泡 */}
        <div className="absolute -top-8 left-1/2 transform -translate-x-1/2">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md border border-gray-200 dark:border-gray-700 px-3 py-1 relative">
            <span className="text-sm text-gray-600 dark:text-gray-400 font-mono">
              "{searchQuery.length > 20 ? searchQuery.substring(0, 20) + '...' : searchQuery}"
            </span>
            <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-200 dark:border-t-gray-700"></div>
          </div>
        </div>

        {/* 动画波纹 */}
        <div className="absolute inset-0 rounded-full border-2 border-gray-300 dark:border-gray-600 animate-ping opacity-20"></div>
        <div className="absolute inset-2 rounded-full border-2 border-gray-400 dark:border-gray-500 animate-ping opacity-30 animation-delay-200"></div>
      </div>
    </div>
  );

  return (
    <div className={cn('relative', className)}>
      <EmptyState
        title="没有找到匹配的标签"
        description={`没有找到包含 "${searchQuery}" 的标签页`}
        customIllustration={customIllustration}
        actions={actions}
        animated={true}
        size="md"
      />

      {/* 搜索建议 */}
      {showSuggestions && (
        <div className={cn(
          'mt-8 max-w-md mx-auto transition-all duration-700 ease-out',
          showSuggestions ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3 text-center">
            搜索建议
          </h4>
          <ul className="space-y-2">
            {suggestions.map((suggestion, index) => (
              <li
                key={index}
                className={cn(
                  'flex items-start text-sm text-gray-600 dark:text-gray-400 transition-all duration-500 ease-out',
                  showSuggestions ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
                )}
                style={{ transitionDelay: `${index * 100 + 200}ms` }}
              >
                <svg className="w-4 h-4 text-blue-500 mt-0.5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4" />
                </svg>
                {suggestion}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 快速操作 */}
      {onImportData && (
        <div className="mt-6 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            还没有足够的标签页？
          </p>
          <button
            onClick={onImportData}
            className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium"
          >
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
            导入现有数据
          </button>
        </div>
      )}
    </div>
  );
};

export { SearchEmptyState };
export default SearchEmptyState;
