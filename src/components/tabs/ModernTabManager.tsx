/**
 * 现代化标签管理器主组件
 * 全面重新设计的视觉体验，具有现代感和高度的交互性
 */

import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import { ModernEmptyState, ModernLoadingState } from './ModernEmptyState';
import { SearchResultList } from '@/components/search/SearchResultList';
import { ModernTabGroupList } from './ModernTabGroupList';
import { ModernCard } from '@/shared/components/ModernCard/ModernCard';
import { ModernIcon } from '@/shared/components/ModernIcon/ModernIcon';
import { DecorativeElement } from '@/shared/components/ModernIllustration/ModernIllustration';
import { cn } from '@/shared/utils/cn';

interface ModernTabManagerProps {
  searchQuery?: string;
  className?: string;
}

export const ModernTabManager: React.FC<ModernTabManagerProps> = ({
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
    const timer = setTimeout(() => setShowContent(true), 200);
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

  // 计算统计信息
  const stats = {
    totalGroups: filteredGroups.length,
    totalTabs: filteredGroups.reduce((sum, group) => sum + group.tabs.length, 0),
    uniqueDomains: new Set(
      filteredGroups.flatMap(group => 
        group.tabs.map(tab => {
          try {
            return new URL(tab.url).hostname;
          } catch {
            return 'unknown';
          }
        })
      )
    ).size,
  };

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
    console.log('导入数据功能待实现');
  };

  // 处理显示教程
  const handleShowTutorial = () => {
    console.log('显示教程功能待实现');
  };

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('relative min-h-screen', className)}>
        {/* 背景装饰 */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <DecorativeElement
            type="gradient-orb"
            size="lg"
            className="absolute top-20 right-20 opacity-20"
            animated
          />
          <DecorativeElement
            type="waves"
            size="lg"
            color="secondary"
            className="absolute bottom-0 left-0 opacity-10"
            animated
          />
        </div>
        
        <ModernLoadingState message="正在加载您的标签组..." />
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn('relative min-h-screen flex items-center justify-center', className)}>
        <ModernCard variant="elevated" size="lg" className="max-w-md text-center space-y-6">
          <div className="w-16 h-16 mx-auto bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center">
            <ModernIcon name="warning" size="lg" className="text-red-600 dark:text-red-400" />
          </div>
          <div>
            <h3 className="modern-text-h4 modern-text-primary mb-2">加载失败</h3>
            <p className="modern-text-body modern-text-secondary mb-4">{error}</p>
            <button
              onClick={() => dispatch(loadGroups())}
              className="modern-button-primary px-6 py-3 rounded-xl hover:scale-105 transition-all duration-300"
            >
              <ModernIcon name="refresh" size="sm" className="mr-2" />
              重试
            </button>
          </div>
        </ModernCard>
      </div>
    );
  }

  // 搜索结果
  if (searchQuery) {
    return (
      <div className={cn('relative min-h-screen', className)}>
        {/* 背景装饰 */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <DecorativeElement
            type="dots"
            size="md"
            color="primary"
            className="absolute top-10 left-10 opacity-15"
            animated
          />
          <DecorativeElement
            type="circles"
            size="lg"
            color="accent"
            className="absolute bottom-20 right-10 opacity-10"
            animated
          />
        </div>
        
        <div className="relative z-10 animate-fade-in">
          <SearchResultList searchQuery={searchQuery} />
        </div>
      </div>
    );
  }

  // 空状态
  if (filteredGroups.length === 0) {
    return (
      <div className={cn('relative', className)}>
        <ModernEmptyState
          onSaveAllTabs={handleSaveAllTabs}
          onImportData={handleImportData}
          onShowTutorial={handleShowTutorial}
          showGuidedActions={true}
        />
      </div>
    );
  }

  // 标签组列表
  return (
    <div className={cn('relative min-h-screen', className)}>
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <DecorativeElement
          type="gradient-orb"
          size="xl"
          className="absolute -top-20 -right-20 opacity-10"
          animated
        />
        <DecorativeElement
          type="grid"
          size="lg"
          color="neutral"
          className="absolute top-0 left-0 opacity-5"
        />
        <DecorativeElement
          type="waves"
          size="lg"
          color="primary"
          className="absolute bottom-0 right-0 opacity-10"
          animated
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* 页面标题和统计 */}
        <div className="text-center space-y-6 animate-fade-in-up">
          <div className="space-y-4">
            <h1 className="modern-text-display gradient-text font-bold">
              标签管理器
            </h1>
            <p className="modern-text-body-lg modern-text-secondary max-w-2xl mx-auto">
              智能管理您的浏览器标签页，提升工作效率，让数字生活更加井然有序
            </p>
          </div>

          {/* 统计卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <ModernCard
              variant="glass"
              size="md"
              className="text-center space-y-3 animate-scale-in stagger-1"
            >
              <div className="w-12 h-12 mx-auto bg-gradient-to-br from-blue-500 to-cyan-500 rounded-xl flex items-center justify-center">
                <ModernIcon name="folder" size="lg" className="text-white" />
              </div>
              <div>
                <div className="modern-text-h3 gradient-text font-bold">{stats.totalGroups}</div>
                <div className="modern-text-caption modern-text-tertiary">标签组</div>
              </div>
            </ModernCard>

            <ModernCard
              variant="glass"
              size="md"
              className="text-center space-y-3 animate-scale-in stagger-2"
            >
              <div className="w-12 h-12 mx-auto bg-gradient-to-br from-green-500 to-emerald-500 rounded-xl flex items-center justify-center">
                <ModernIcon name="tab" size="lg" className="text-white" />
              </div>
              <div>
                <div className="modern-text-h3 gradient-text-secondary font-bold">{stats.totalTabs}</div>
                <div className="modern-text-caption modern-text-tertiary">已保存标签</div>
              </div>
            </ModernCard>

            <ModernCard
              variant="glass"
              size="md"
              className="text-center space-y-3 animate-scale-in stagger-3"
            >
              <div className="w-12 h-12 mx-auto bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center">
                <ModernIcon name="globe" size="lg" className="text-white" />
              </div>
              <div>
                <div className="modern-text-h3 gradient-text font-bold">{stats.uniqueDomains}</div>
                <div className="modern-text-caption modern-text-tertiary">不同网站</div>
              </div>
            </ModernCard>
          </div>
        </div>

        {/* 标签组列表 */}
        <div className="animate-fade-in-up animate-delay-500">
          <ModernTabGroupList
            groups={filteredGroups}
            useDoubleColumnLayout={useDoubleColumnLayout}
          />
        </div>
      </div>
    </div>
  );
};

export default ModernTabManager;
