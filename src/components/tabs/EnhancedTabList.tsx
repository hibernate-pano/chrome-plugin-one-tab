/**
 * 增强版标签列表组件
 * 集成批量操作功能的标签列表
 */
import React, { useEffect, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups, deleteGroup, updateGroup } from '@/features/tabs/store/tabGroupsSlice';
import { deleteTab } from '@/features/tabs/store/tabsSlice';
import { BatchOperationToolbar, SelectableTabGroup } from '@/features/batch-operations/components';
import { SearchResultList } from '@/components/search/SearchResultList';
import { TabsEmptyState } from '@/components/tabs/TabsEmptyState';
import { cn } from '@/shared/utils/cn';

interface EnhancedTabListProps {
  searchQuery?: string;
  className?: string;
}

export const EnhancedTabList: React.FC<EnhancedTabListProps> = ({
  searchQuery = '',
  className,
}) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabGroups);
  const { selectionMode } = useAppSelector(state => state.batchOperations);
  const { useDoubleColumnLayout } = useAppSelector(state => state.settings);

  // 加载标签组
  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // 过滤搜索结果
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) {
      return groups;
    }

    const query = searchQuery.toLowerCase();
    return groups.filter(group => {
      // 搜索标签组名称
      if (group.name.toLowerCase().includes(query)) {
        return true;
      }
      
      // 搜索标签页标题和URL
      return group.tabs.some(tab => 
        tab.title?.toLowerCase().includes(query) ||
        tab.url?.toLowerCase().includes(query)
      );
    });
  }, [groups, searchQuery]);

  // 处理标签组操作
  const handleOpenAllTabs = async (group: any) => {
    try {
      for (const tab of group.tabs) {
        await chrome.tabs.create({ url: tab.url, active: false });
      }
    } catch (error) {
      console.error('打开标签页失败:', error);
    }
  };

  const handleDeleteGroup = (groupId: string) => {
    dispatch(deleteGroup(groupId));
  };

  const handleUpdateGroup = (group: any) => {
    dispatch(updateGroup(group));
  };

  const handleDeleteTab = (tabId: string) => {
    dispatch(deleteTab(tabId));
  };

  // 处理保存所有标签页
  const handleSaveAllTabs = async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const validTabs = tabs.filter(tab => {
        if (tab.url) {
          return !tab.url.startsWith('chrome://') && 
                 !tab.url.startsWith('chrome-extension://') && 
                 !tab.url.startsWith('edge://');
        }
        return tab.title && tab.title.trim() !== '';
      });

      if (validTabs.length > 0) {
        // 这里可以调用保存标签组的action
        console.log('保存标签页:', validTabs);
      }
    } catch (error) {
      console.error('保存标签页失败:', error);
    }
  };

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center py-12", className)}>
        <div className="flex items-center space-x-3">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-gray-600 dark:text-gray-400">加载中...</span>
        </div>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className={cn("flex items-center justify-center py-12", className)}>
        <div className="text-center">
          <div className="text-red-500 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <p className="text-gray-600 dark:text-gray-400">{error}</p>
          <button
            onClick={() => dispatch(loadGroups())}
            className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  // 空状态
  if (groups.length === 0) {
    return (
      <div className={className}>
        <TabsEmptyState
          onSaveAllTabs={handleSaveAllTabs}
          showGuidedActions={true}
        />
      </div>
    );
  }

  // 搜索结果为空
  if (searchQuery && filteredGroups.length === 0) {
    return (
      <div className={cn("flex items-center justify-center py-12", className)}>
        <div className="text-center">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            未找到匹配结果
          </h3>
          <p className="text-gray-600 dark:text-gray-400">
            尝试使用不同的关键词搜索
          </p>
        </div>
      </div>
    );
  }

  // 搜索模式
  if (searchQuery) {
    return (
      <div className={className}>
        <SearchResultList 
          searchQuery={searchQuery}
          groups={filteredGroups}
        />
      </div>
    );
  }

  // 正常列表模式
  return (
    <div className={className}>
      {/* 批量操作工具栏 */}
      <BatchOperationToolbar />

      {/* 标签组列表 */}
      <div className={cn(
        "p-4",
        useDoubleColumnLayout && "grid grid-cols-2 gap-4",
        !useDoubleColumnLayout && "space-y-4"
      )}>
        {filteredGroups.map((group) => (
          <SelectableTabGroup
            key={group.id}
            group={group}
            onOpenAllTabs={() => handleOpenAllTabs(group)}
            onDeleteGroup={handleDeleteGroup}
            onUpdateGroup={handleUpdateGroup}
            onDeleteTab={handleDeleteTab}
            className={cn(
              "transition-all duration-200",
              selectionMode === 'groups' && "hover:shadow-lg"
            )}
          />
        ))}
      </div>

      {/* 底部统计信息 */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
        <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>
            共 {groups.length} 个标签组，{groups.reduce((sum, group) => sum + group.tabs.length, 0)} 个标签页
          </span>
          <span>
            {selectionMode === 'groups' && '多选模式已启用'}
          </span>
        </div>
      </div>
    </div>
  );
};
