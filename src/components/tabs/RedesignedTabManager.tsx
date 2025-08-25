/**
 * 重新设计的标签管理器主页面
 * 基于空标签页面的设计规范，提供一致的视觉体验
 */

import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import { TabsEmptyState } from './TabsEmptyState';
import { SearchResultList } from '@/components/search/SearchResultList';
import { RedesignedTabGroupList } from './RedesignedTabGroupList';
import { AnimatedContainer, StaggeredContainer, ResponsiveContainer } from '@/shared/components';
import { cn } from '@/shared/utils/cn';

interface RedesignedTabManagerProps {
  searchQuery?: string;
  className?: string;
}

export const RedesignedTabManager: React.FC<RedesignedTabManagerProps> = ({
  searchQuery = '',
  className,
}) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabGroups);
  const { useDoubleColumnLayout } = useAppSelector(state => state.settings);
  const [showContent, setShowContent] = useState(false);

  // 加载标签组
  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // 延迟显示内容以实现平滑动画
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // 过滤标签组
  const filteredGroups = groups.filter(group => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      group.name.toLowerCase().includes(query) ||
      group.tabs.some(tab =>
        tab.title.toLowerCase().includes(query) ||
        tab.url.toLowerCase().includes(query)
      )
    );
  });

  // 处理保存所有标签
  const handleSaveAllTabs = async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { tabs }
      });
    } catch (error) {
      console.error('保存标签失败:', error);
    }
  };

  // 处理导入数据
  const handleImportData = () => {
    // TODO: 实现导入数据功能
    console.log('导入数据功能待实现');
  };

  // 处理显示教程
  const handleShowTutorial = () => {
    // TODO: 实现显示教程功能
    console.log('显示教程功能待实现');
  };

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">加载标签组...</p>
        </div>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <div className="text-center">
          <div className="w-12 h-12 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">加载失败</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button
            onClick={() => dispatch(loadGroups())}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  // 搜索结果
  if (searchQuery) {
    return (
      <AnimatedContainer animation="fadeIn" className={className}>
        <SearchResultList searchQuery={searchQuery} />
      </AnimatedContainer>
    );
  }

  // 空状态
  if (filteredGroups.length === 0) {
    return (
      <AnimatedContainer animation="slideUp" className={className}>
        <TabsEmptyState
          onSaveAllTabs={handleSaveAllTabs}
          onImportData={handleImportData}
          onShowTutorial={handleShowTutorial}
          showGuidedActions={true}
        />
      </AnimatedContainer>
    );
  }

  // 标签组列表
  return (
    <ResponsiveContainer maxWidth="xl" padding="md" className={className}>
      <div className="space-y-8">
        {/* 页面标题和统计 */}
        <AnimatedContainer animation="slideUp" delay={100}>
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-3">
              标签管理器
            </h1>
            <p className="text-lg text-gray-600 dark:text-gray-400">
              管理您保存的 {filteredGroups.length} 个标签组
            </p>
          </div>
        </AnimatedContainer>

        {/* 标签组列表 */}
        <StaggeredContainer staggerDelay={100}>
          <RedesignedTabGroupList
            groups={filteredGroups}
            useDoubleColumnLayout={useDoubleColumnLayout}
          />
        </StaggeredContainer>
      </div>
    </ResponsiveContainer>
  );
};

export default RedesignedTabManager;
