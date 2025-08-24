import React, { useEffect, useState, lazy } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, deleteGroup, moveGroupAndSync } from '@/store/slices/tabSlice';
import { runMigrations } from '@/utils/migrationUtils';

import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { TabGroup as TabGroupType } from '@/types/tab';

interface TabListProps {
  searchQuery: string;
}

// 新增：全局排序视图组件（后续实现）
const ReorderView = lazy(() => import('@/components/tabs/ReorderView'));

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabs);
  const { layoutMode, reorderMode } = useAppSelector(state => state.settings);
  const [isRestoreAllModalOpen, setIsRestoreAllModalOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TabGroupType | null>(null);

  useEffect(() => {
    // 先运行数据迁移，然后加载数据
    const initializeData = async () => {
      try {
        // 运行必要的数据迁移
        await runMigrations();

        // 加载标签组数据
        dispatch(loadGroups());
      } catch (error) {
        console.error('初始化数据失败:', error);
        // 即使迁移失败，也要尝试加载数据
        dispatch(loadGroups());
      }
    };

    initializeData();

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

    // 组件卸载时移除消息监听器
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [dispatch]);

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

  // 先按创建时间倒序排序
  const sortedGroups = [...groups].sort((a, b) => {
    // 优先使用 createdAt 进行排序
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return dateB.getTime() - dateA.getTime(); // 倒序，最新创建的在前面
  });

  // 当有搜索查询时，我们会使用 SearchResultList 组件显示匹配的标签
  // 这里只需要处理没有搜索查询时的标签组列表
  const filteredGroups = sortedGroups;

  if (filteredGroups.length === 0 && !searchQuery) {
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

  // 新增：全局排序模式入口
  if (reorderMode) {
    return (
      <React.Suspense fallback={<div>加载中...</div>}>
        <ReorderView />
      </React.Suspense>
    );
  }

  return (
    <div className="space-y-2">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : layoutMode === 'double' ? (
        // 双栏布局
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 md:gap-4">
          {/* 左栏 - 偶数索引的标签组 */}
          <div className="space-y-2 transition-all">
            {filteredGroups
              .filter((_, index) => index % 2 === 0)
              .map(group => {
                // 计算在原始数组中的实际索引
                const originalIndex = filteredGroups.findIndex(g => g.id === group.id);
                return (
                  <DraggableTabGroup
                    key={group.id}
                    group={group}
                    index={originalIndex}
                    moveGroup={(dragIndex, hoverIndex) => {
                      dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                    }}
                  />
                );
              })}
          </div>

          {/* 右栏 - 奇数索引的标签组 */}
          <div className="space-y-2 transition-all">
            {filteredGroups
              .filter((_, index) => index % 2 === 1)
              .map(group => {
                // 计算在原始数组中的实际索引
                const originalIndex = filteredGroups.findIndex(g => g.id === group.id);
                return (
                  <DraggableTabGroup
                    key={group.id}
                    group={group}
                    index={originalIndex}
                    moveGroup={(dragIndex, hoverIndex) => {
                      dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
                    }}
                  />
                );
              })}
          </div>
        </div>
      ) : (
        // 单栏布局
        <div className="space-y-2 transition-all">
          {filteredGroups.map((group, index) => (
            <DraggableTabGroup
              key={group.id}
              group={group}
              index={index}
              moveGroup={(dragIndex, hoverIndex) => {
                dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
              }}
            />
          ))}
        </div>
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
