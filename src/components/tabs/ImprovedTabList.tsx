import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import { moveTab, moveGroup } from '@/features/tabs/store/dragOperationsSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
import { SimpleDraggableTabGroup } from '@/components/dnd/SimpleDraggableTabGroup';
import { TabsEmptyState } from './TabsEmptyState';
import '@/styles/drag-drop.css';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  UniqueIdentifier,
  pointerWithin
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { TabGroup } from '@/shared/types/tab';

interface ImprovedTabListProps {
  searchQuery: string;
}

export const ImprovedTabList: React.FC<ImprovedTabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector((state) => state.tabGroups.groups) || [];
  const useDoubleColumnLayout = useAppSelector((state) => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  useEffect(() => {
    // 初始加载标签组数据
    const result = dispatch(loadGroups());

    // 只在开发环境显示详细日志
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 ImprovedTabList 初始化，加载标签组数据');

      result
        .then((actionResult: any) => {
          if (actionResult.payload && Array.isArray(actionResult.payload)) {
            console.log('🔍 加载的标签组数量:', actionResult.payload.length);
          }
        })
        .catch((error) => {
          console.error('🔍 loadGroups 加载失败:', error);
        });
    }

    // 监听来自 background 的刷新消息
    const handleMessage = (message: any) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        console.log('收到刷新标签列表的消息，重新加载数据');
        console.log('🔍 收到刷新消息 - 准备dispatch loadGroups');
        dispatch(loadGroups());
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);

    // 优化页面可见性监听，减少不必要的刷新
    let lastVisibilityChange = 0;
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        const now = Date.now();
        // 防抖：5秒内只允许一次可见性刷新
        if (now - lastVisibilityChange > 5000) {
          console.log('页面变为可见，重新加载标签组数据');
          dispatch(loadGroups());
          lastVisibilityChange = now;
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 移除定期刷新机制，避免不必要的性能开销
    // 实时同步已经通过WebSocket处理数据更新
    // const refreshInterval = setInterval(() => {
    //   console.log('🔍 定期刷新 - 准备dispatch loadGroups');
    //   dispatch(loadGroups());
    // }, 10000);

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // clearInterval(refreshInterval); // 已移除定期刷新
    };
  }, [dispatch]);

  // 过滤标签组
  const filteredGroups = searchQuery ? [] : (groups || []);

  // 移除了详细的状态调试日志

  // 创建标签组ID列表
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 配置拖拽传感器 - 优化灵敏度
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 稍微增加一点距离避免意外拖拽
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // 处理拖拽开始
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id);
    setActiveData(active.data.current);
  };

  // 处理拖拽悬停 - 简化逻辑，只处理跨组拖拽
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // 只处理标签页拖拽到不同组的情况
    if (activeData?.type === 'tab' && overData?.type === 'tab') {
      const sourceGroupId = activeData.groupId;
      const targetGroupId = overData.groupId;

      // 如果是跨组拖拽，才进行预处理
      if (sourceGroupId !== targetGroupId) {
        const sourceIndex = activeData.index;
        const targetIndex = overData.index;

        dispatch(moveTab({
          sourceGroupId,
          sourceIndex,
          targetGroupId,
          targetIndex
        }));
      }
    }
  };

  // 处理拖拽结束
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const activeData = active.data.current;
      const overData = over.data.current;

      // 处理标签页拖拽
      if (activeData?.type === 'tab' && overData?.type === 'tab') {
        const sourceGroupId = activeData.groupId;
        const sourceIndex = activeData.index;
        const targetGroupId = overData.groupId;
        const targetIndex = overData.index;

        // 执行最终的标签页移动
        dispatch(moveTab({
          sourceGroupId,
          sourceIndex,
          targetGroupId,
          targetIndex
        }));
      }
      // 处理标签组拖拽
      else if (activeData?.type === 'group' && overData?.type === 'group') {
        const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === active.id);
        const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === over.id);

        if (activeIndex !== -1 && overIndex !== -1) {
          // 执行标签组移动
          dispatch(moveGroup({ dragIndex: activeIndex, hoverIndex: overIndex }));
        }
      }
    }

    // 清理状态
    setActiveId(null);
    setActiveData(null);
  };

  // 渲染拖拽覆盖层
  const renderDragOverlay = () => {
    if (!activeId || !activeData) return null;

    // 渲染标签页覆盖层
    if (activeData.type === 'tab') {
      const tab = activeData.tab;
      return (
        <div className="flex items-center py-2 px-3 bg-white dark:bg-gray-800 border border-blue-400 rounded-lg shadow-lg opacity-90">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="w-4 h-4 mr-2 flex-shrink-0" />
          ) : (
            <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 mr-2 flex-shrink-0 rounded" />
          )}
          <span className="truncate text-sm font-medium">{tab.title}</span>
        </div>
      );
    }
    // 渲染标签组覆盖层
    else if (activeData.type === 'group') {
      const group = activeData.group;
      return (
        <div className="bg-white dark:bg-gray-800 border border-blue-400 rounded-lg shadow-lg p-3 opacity-90">
          <div className="font-medium text-sm">{group.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{group.tabs.length} 个标签页</div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-2">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : filteredGroups.length === 0 ? (
        /* 空状态显示 */
        <TabsEmptyState
          onSaveAllTabs={() => {
            // 这里可以触发保存所有标签的操作
            console.log('Save all tabs triggered from empty state');
          }}
          onImportData={() => {
            // 这里可以触发导入数据的操作
            console.log('Import data triggered from empty state');
          }}
          onShowTutorial={() => {
            // 这里可以触发显示教程的操作
            console.log('Show tutorial triggered from empty state');
          }}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {useDoubleColumnLayout ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_: TabGroup, index: number) => index % 2 === 0)
                    .map((group: TabGroup) => (
                      <SimpleDraggableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex((g: TabGroup) => g.id === group.id)}
                      />
                    ))}
                </div>

                {/* 右栏 - 奇数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_: TabGroup, index: number) => index % 2 === 1)
                    .map((group: TabGroup) => (
                      <SimpleDraggableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex((g: TabGroup) => g.id === group.id)}
                      />
                    ))}
                </div>
              </div>
            </SortableContext>
          ) : (
            // 单栏布局
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {filteredGroups.map((group: TabGroup, index: number) => (
                  <SimpleDraggableTabGroup
                    key={group.id}
                    group={group}
                    index={index}
                  />
                ))}
              </div>
            </SortableContext>
          )}

          {/* 拖拽覆盖层 */}
          <DragOverlay
            dropAnimation={{
              duration: 250,
              easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            }}
          >
            {renderDragOverlay()}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
};