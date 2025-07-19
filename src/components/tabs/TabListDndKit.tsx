import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import { moveGroupAndSync, moveTabAndSync } from '@/features/tabs/store/dragOperationsSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
// No need to import TabGroup type as we're not using it directly
import { SortableTabGroup } from '@/components/dnd/SortableTabGroup';
import { DndKitProvider } from '@/components/dnd/DndKitProvider';
import { DragPerformanceTest } from '@/components/dnd/DragPerformanceTest';
import { dragPerformanceMonitor } from '@/shared/utils/dragPerformance';
import '@/styles/drag-drop.css';
import {
  DragOverlay,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  MeasuringStrategy,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy, // 使用矩形排序策略，更适合复杂布局
} from '@dnd-kit/sortable';

interface TabListProps {
  searchQuery: string;
}

export const TabListDndKit: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector(state => state.tabGroups.groups);
  const useDoubleColumnLayout = useAppSelector(state => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  // 保存拖拽初始状态的引用
  const initialDragState = useRef<{
    sourceGroupId: string | null;
    sourceIndex: number | null;
  }>({ sourceGroupId: null, sourceIndex: null });

  // 使用ref跟踪组件是否已卸载，防止在卸载后更新状态
  const isMounted = useRef(true);

  useEffect(() => {
    // 组件挂载时设置为true
    isMounted.current = true;

    // 组件卸载时设置为false
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // Filter groups based on search query
  const filteredGroups = searchQuery ? [] : groups;

  // Create a list of sortable group IDs - 使用useMemo优化性能
  const groupIds = useMemo(() =>
    filteredGroups.map(group => `group-${group.id}`),
    [filteredGroups]
  );

  // 配置拖拽传感器 - 优化性能和灵敏度
  const sensors = useMemo(() => useSensors(
    useSensor(PointerSensor, {
      // 适中的移动距离，避免意外触发同时保持响应性
      activationConstraint: {
        distance: 5,
        tolerance: 3,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  ), []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const activeData = active.data.current;

    // 开始性能监控
    if (process.env.NODE_ENV === 'development') {
      dragPerformanceMonitor.startMonitoring();
    }

    // 记录初始拖拽状态
    if (activeData?.type === 'tab') {
      initialDragState.current = {
        sourceGroupId: activeData.groupId,
        sourceIndex: activeData.index,
      };
    }

    if (isMounted.current) {
      setActiveId(active.id as string);
      setActiveData(activeData);
    }
  }, []);

  // 使用ref来跟踪上次的拖拽位置，避免频繁更新
  const lastDragPosition = useRef<{
    sourceGroupId: string;
    sourceIndex: number;
    targetGroupId: string;
    targetIndex: number;
  } | null>(null);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;

    if (!over || !isMounted.current) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // 如果没有数据，直接返回
    if (!activeData || !overData) return;

    // 处理标签拖拽 - 只进行视觉反馈，不实际移动数据
    if (activeData.type === 'tab' && overData.type === 'tab') {
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex =
        initialDragState.current.sourceIndex !== null
          ? initialDragState.current.sourceIndex
          : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 判断是否是同一标签组内的移动
      const isSameGroup = sourceGroupId === targetGroupId;

      // 不重复处理拖拽到自己的情况
      if (isSameGroup && sourceIndex === targetIndex) {
        return;
      }

      // 检查是否与上次位置相同，避免重复处理
      const currentPosition = { sourceGroupId, sourceIndex, targetGroupId, targetIndex };
      if (lastDragPosition.current &&
          lastDragPosition.current.sourceGroupId === sourceGroupId &&
          lastDragPosition.current.sourceIndex === sourceIndex &&
          lastDragPosition.current.targetGroupId === targetGroupId &&
          lastDragPosition.current.targetIndex === targetIndex) {
        return;
      }

      lastDragPosition.current = currentPosition;

      // 只更新视觉状态，不触发实际的数据移动
      if (isMounted.current) {
        setActiveData({
          ...activeData,
          groupId: targetGroupId,
        });
      }
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // 清理拖拽位置缓存
    lastDragPosition.current = null;

    const { active, over } = event;

    // 清理状态的通用函数
    const cleanupState = () => {
      if (isMounted.current) {
        setActiveId(null);
        setActiveData(null);
      }
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
    };

    if (!over || !isMounted.current) {
      cleanupState();
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) {
      cleanupState();
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    // 如果没有数据，直接返回
    if (!activeData || !overData) {
      cleanupState();
      return;
    }

    // 处理标签拖拽
    if (activeData.type === 'tab' && overData.type === 'tab') {
      // 使用初始拖拽状态，而不是当前可能已经改变的activeData
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex =
        initialDragState.current.sourceIndex !== null
          ? initialDragState.current.sourceIndex
          : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 只有当位置真正发生变化时才执行移动
      if (sourceGroupId !== targetGroupId || sourceIndex !== targetIndex) {
        try {
          // 在拖动结束时执行最终更新
          dispatch(
            moveTabAndSync({
              sourceGroupId,
              sourceIndex,
              targetGroupId,
              targetIndex,
              updateSourceInDrag: true,
            })
          );
        } catch (error) {
          console.error('拖拽结束时更新标签位置失败:', error);
        }
      }
    }
    // 处理组拖拽
    else if (activeData.type === 'group' && overData.type === 'group') {
      const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === activeId);
      const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === overId);

      if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
        try {
          dispatch(moveGroupAndSync({ dragIndex: activeIndex, hoverIndex: overIndex }));
        } catch (error) {
          console.error('拖拽结束时更新标签组位置失败:', error);
        }
      }
    }

    // 停止性能监控
    if (process.env.NODE_ENV === 'development') {
      dragPerformanceMonitor.stopMonitoring();
    }

    // 清理所有状态
    cleanupState();
  }, [dispatch, filteredGroups]);

  // 渲染拖拽覆盖层 - 使用useCallback优化性能
  const renderDragOverlay = useCallback(() => {
    if (!activeId || !activeData) return null;

    if (activeData.type === 'tab') {
      const { tab } = activeData;
      return (
        <div className="drag-overlay tab-overlay">
          <div className="flex items-center space-x-2 flex-1 min-w-0">
            {tab.favicon ? (
              <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
            ) : (
              <div className="w-4 h-4 bg-gray-200 flex-shrink-0"></div>
            )}
            <div className="truncate text-blue-600 text-sm">{tab.title}</div>
          </div>
        </div>
      );
    }

    if (activeData.type === 'group') {
      const { group } = activeData;
      return (
        <div className="drag-overlay group-overlay">
          <div className="flex items-center space-x-2">
            <div className="truncate font-medium text-gray-700">{group.name}</div>
            <div className="text-xs text-gray-500 whitespace-nowrap">
              {group.tabs.length} 个标签页
            </div>
          </div>
        </div>
      );
    }

    return null;
  }, [activeId, activeData]);

  return (
    <div className="space-y-2">
      {/* 搜索结果或标签组列表 */}
      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : (
        <DndKitProvider
          sensors={sensors}
          collisionDetection={pointerWithin}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {useDoubleColumnLayout ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 0)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>

                {/* 右栏 - 奇数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 1)
                    .map(group => (
                      <SortableTabGroup
                        key={group.id}
                        group={group}
                        index={filteredGroups.findIndex(g => g.id === group.id)}
                      />
                    ))}
                </div>
              </div>
            </SortableContext>
          ) : (
            // 单栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="space-y-2">
                {filteredGroups.map((group, index) => (
                  <SortableTabGroup key={group.id} group={group} index={index} />
                ))}
              </div>
            </SortableContext>
          )}

          {/* Drag Overlay - 添加平滑动画 */}
          <DragOverlay
            dropAnimation={{
              duration: 150,
              easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
            }}
          >
            {renderDragOverlay()}
          </DragOverlay>
        </DndKitProvider>
      )}

      {/* 开发环境下的性能监控 */}
      <DragPerformanceTest />
    </div>
  );
};
