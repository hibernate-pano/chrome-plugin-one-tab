import React, { useEffect, useState, lazy, useMemo, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, deleteGroup, moveGroupAndSync } from '@/store/slices/tabSlice';
import { runMigrations } from '@/utils/migrationUtils';

import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { TabGroup as TabGroupType } from '@/types/tab';
import { EmptyState } from '@/components/common/EmptyState';
import { PersonalizedWelcome, QuickActionTips } from '@/components/common/PersonalizedWelcome';
import { TabListSkeleton } from '@/components/common/Skeleton';

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
    return <TabListSkeleton count={5} />;
  }

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-600">{error}</div>;
  }

  // 使用 useMemo 缓存排序结果，避免每次渲染都重新排序
  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      const dateA = new Date(a.createdAt);
      const dateB = new Date(b.createdAt);
      return dateB.getTime() - dateA.getTime(); // 倒序，最新创建的在前面
    });
  }, [groups]);

  // 当有搜索查询时，我们会使用 SearchResultList 组件显示匹配的标签
  // 这里只需要处理没有搜索查询时的标签组列表
  const filteredGroups = sortedGroups;

  // 使用 useCallback 优化 moveGroup 回调函数
  const handleMoveGroup = useCallback(
    (dragIndex: number, hoverIndex: number) => {
      dispatch(moveGroupAndSync({ dragIndex, hoverIndex }));
    },
    [dispatch]
  );

  // 使用 useMemo 缓存双栏布局的分组
  const { leftColumnGroups, rightColumnGroups } = useMemo(() => {
    if (layoutMode !== 'double') {
      return { leftColumnGroups: [], rightColumnGroups: [] };
    }

    const left: Array<{ group: TabGroupType; index: number }> = [];
    const right: Array<{ group: TabGroupType; index: number }> = [];

    filteredGroups.forEach((group, index) => {
      if (index % 2 === 0) {
        left.push({ group, index });
      } else {
        right.push({ group, index });
      }
    });

    return { leftColumnGroups: left, rightColumnGroups: right };
  }, [filteredGroups, layoutMode]);

  if (filteredGroups.length === 0 && !searchQuery) {
    return (
      <div className="space-y-4">
        <PersonalizedWelcome tabCount={filteredGroups.length} className="flat-card p-6" />
        <div className="flat-card p-6">
          <EmptyState
            title="开始您的标签页管理之旅"
            description="点击右上角的「保存所有标签」按钮开始保存您的标签页。保存后的标签页将显示在这里。"
            action={
              <button
                onClick={() => {
                  chrome.runtime.sendMessage({
                    type: 'SAVE_ALL_TABS',
                    data: { tabs: [] },
                  });
                }}
                className="px-6 py-2 text-sm font-medium flat-button-primary flat-interaction"
              >
                保存所有标签
              </button>
            }
          />
        </div>
        <QuickActionTips className="flat-card p-4" />
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
    <div className="space-y-2 fade-in">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : layoutMode === 'double' ? (
        // 双栏布局 - 使用优化后的预计算数据
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 md:gap-4">
          {/* 左栏 - 偶数索引的标签组 */}
          <div className="space-y-2 transition-all">
            {leftColumnGroups.map(({ group, index }) => (
              <DraggableTabGroup
                key={group.id}
                group={group}
                index={index}
                moveGroup={handleMoveGroup}
              />
            ))}
          </div>

          {/* 右栏 - 奇数索引的标签组 */}
          <div className="space-y-2 transition-all">
            {rightColumnGroups.map(({ group, index }) => (
              <DraggableTabGroup
                key={group.id}
                group={group}
                index={index}
                moveGroup={handleMoveGroup}
              />
            ))}
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
              moveGroup={handleMoveGroup}
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
