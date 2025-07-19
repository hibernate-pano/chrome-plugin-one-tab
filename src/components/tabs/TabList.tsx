import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups, deleteGroup } from '@/features/tabs/store/tabGroupsSlice';

import { TabGroup } from './TabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { TabGroup as TabGroupType } from '@/types/tab';
import { VirtualList } from '@/shared/components/VirtualList/VirtualList';
import { useMemoryMonitor, usePagination } from '@/shared/hooks/useMemoryOptimization';
import { useComponentCleanup } from '@/shared/hooks/useComponentCleanup';

interface TabListProps {
  searchQuery: string;
}

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabGroups);
  const { useDoubleColumnLayout } = useAppSelector(state => state.settings);
  const [isRestoreAllModalOpen, setIsRestoreAllModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TabGroupType | null>(null);

  // 内存监控和清理
  const memoryInfo = useMemoryMonitor('TabList');
  const { addCleanupTask } = useComponentCleanup('TabList');

  useEffect(() => {
    dispatch(loadGroups());

    // 添加消息监听器，监听数据刷新消息
    const messageListener = (message: any) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        console.log('收到刷新标签列表消息，重新加载数据');
        dispatch(loadGroups());
      }
      return true; // 异步响应
    };

    // 注册消息监听器
    chrome.runtime.onMessage.addListener(messageListener);

    // 使用清理任务管理器
    addCleanupTask(
      () => chrome.runtime.onMessage.removeListener(messageListener),
      'message-listener',
      10
    );
  }, [dispatch, addCleanupTask]);

  // 优化的数据处理，使用useMemo避免重复计算
  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime();
    });
  }, [groups]);

  // 分页处理大量数据
  const {
    currentData: paginatedGroups,
    currentPage,
    totalPages,
    hasNext,
    hasPrev,
    nextPage,
    prevPage,
  } = usePagination(sortedGroups, 20); // 每页20个标签组

  // 渲染单个标签组的回调
  const renderTabGroup = useCallback((group: TabGroupType, index: number) => {
    return (
      <TabGroup
        key={group.id}
        group={group}
        onDelete={() => dispatch(deleteGroup(group.id))}
        onSelect={() => setSelectedGroup(group)}
      />
    );
  }, [dispatch]);

  // 键提取器
  const keyExtractor = useCallback((group: TabGroupType, index: number) => group.id, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-600">{error}</div>;
  }

  if (sortedGroups.length === 0 && !searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center py-8 space-y-3 text-gray-500 bg-white border border-gray-200 p-4">
        <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-10 w-10 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-gray-700">没有保存的标签页</h3>
        <p className="text-gray-500 max-w-md text-center">
          点击右上角的"保存所有标签"按钮开始保存您的标签页。保存后的标签页将显示在这里。
        </p>
        <button
          onClick={() => {
            chrome.runtime.sendMessage({
              type: 'SAVE_ALL_TABS',
              data: { tabs: [] },
            });
          }}
          className="mt-2 px-4 py-1.5 bg-primary-600 text-white rounded hover:bg-primary-700 transition-colors text-sm"
        >
          保存所有标签
        </button>
      </div>
    );
  }

  const handleRestoreAll = () => {
    if (!selectedGroup) return;

    // 收集所有标签页的 URL
    const urls = selectedGroup.tabs.map(tab => tab.url);

    // 如果标签组没有锁定，先在UI中删除标签组
    if (!selectedGroup.isLocked) {
      // 先在Redux中删除标签组，立即更新UI
      dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: selectedGroup.id });

      // 然后异步完成存储操作
      dispatch(deleteGroup(selectedGroup.id))
        .then(() => {
          console.log(`删除标签组: ${selectedGroup.id}`);
        })
        .catch(error => {
          console.error('删除标签组失败:', error);
        });
    }

    // 关闭对话框
    setIsRestoreAllModalOpen(false);
    setSelectedGroup(null);

    // 最后发送消息给后台脚本打开标签页
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'OPEN_TABS',
        data: { urls },
      });
    }, 100); // 小延迟确保 UI 先更新
  };

  return (
    <div className="space-y-2">
      {/* 内存使用信息（仅开发环境） */}
      {process.env.NODE_ENV === 'development' && memoryInfo && (
        <div className="text-xs text-gray-500 p-2 bg-gray-50 rounded">
          内存使用: {(memoryInfo.usedJSHeapSize / 1024 / 1024).toFixed(2)}MB /
          {(memoryInfo.totalJSHeapSize / 1024 / 1024).toFixed(2)}MB
        </div>
      )}

      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : (
        <>
          {/* 分页信息 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between p-2 bg-gray-50 rounded text-sm">
              <span className="text-gray-600">
                第 {currentPage + 1} 页，共 {totalPages} 页 ({sortedGroups.length} 个标签组)
              </span>
              <div className="flex space-x-2">
                <button
                  onClick={prevPage}
                  disabled={!hasPrev}
                  className="px-2 py-1 bg-white border rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  上一页
                </button>
                <button
                  onClick={nextPage}
                  disabled={!hasNext}
                  className="px-2 py-1 bg-white border rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  下一页
                </button>
              </div>
            </div>
          )}

          {useDoubleColumnLayout ? (
            // 双栏布局 - 使用虚拟化
            <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
              {/* 左栏 */}
              <div className="space-y-2">
                <VirtualList
                  items={paginatedGroups.filter((_, index) => index % 2 === 0)}
                  itemHeight={120} // 估计的标签组高度
                  containerHeight={600} // 容器高度
                  renderItem={renderTabGroup}
                  keyExtractor={keyExtractor}
                  overscan={3}
                />
              </div>

              {/* 右栏 */}
              <div className="space-y-2">
                <VirtualList
                  items={paginatedGroups.filter((_, index) => index % 2 === 1)}
                  itemHeight={120}
                  containerHeight={600}
                  renderItem={renderTabGroup}
                  keyExtractor={keyExtractor}
                  overscan={3}
                />
              </div>
            </div>
          ) : (
            // 单栏布局 - 使用虚拟化
            <VirtualList
              items={paginatedGroups}
              itemHeight={120}
              containerHeight={600}
              renderItem={renderTabGroup}
              keyExtractor={keyExtractor}
              overscan={5}
              className="space-y-2"
            />
          )}
        </>
      )}

      {/* 恢复所有标签确认对话框 */}
      {isRestoreAllModalOpen && selectedGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium mb-4">恢复所有标签页</h3>
            <p className="mb-4">
              确定要恢复标签组 "{selectedGroup.name}" 中的所有 {selectedGroup.tabs.length}{' '}
              个标签页吗？
            </p>

            <div className="flex justify-end space-x-2">
              <button
                onClick={() => {
                  setIsRestoreAllModalOpen(false);
                  setSelectedGroup(null);
                }}
                className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                取消
              </button>
              <button
                onClick={handleRestoreAll}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TabList;
