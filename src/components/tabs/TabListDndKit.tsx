import React, { useEffect, useState, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
// No need to import TabGroup type as we're not using it directly
import { SortableTabGroup } from '@/components/dnd/SortableTabGroup';
import { DndKitProvider } from '@/components/dnd/DndKitProvider';
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
  MeasuringStrategy
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy // 使用矩形排序策略，更适合复杂布局
} from '@dnd-kit/sortable';

interface TabListProps {
  searchQuery: string;
}

export const TabListDndKit: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector((state) => state.tabs.groups);
  const useDoubleColumnLayout = useAppSelector((state) => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  // 使用引用跟踪拖动状态
  const dragStateRef = useRef<{
    // 原始位置（拖动开始时）
    originalGroupId?: string;
    originalIndex?: number;
    // 当前目标位置（最后一次拖动过程中）
    currentGroupId?: string;
    currentIndex?: number;
    // 上一次拖动的目标位置（用于检测重复）
    lastOverGroupId?: string;
    lastOverIndex?: number;
    // 拖动方向
    direction?: 'up' | 'down' | 'none';
    // 拖动状态
    isDragging: boolean;
  }>({ isDragging: false });

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // Filter groups based on search query
  const filteredGroups = searchQuery ? [] : groups;

  // Create a list of sortable group IDs
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 简化拖拽传感器配置，提供更直观的体验
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 使用适度的激活约束，让用户有意识地触发拖拽
      activationConstraint: {
        distance: 3, // 3px激活距离，避免误触但仍然灵敏
        tolerance: 5, // 更宽松的容差
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const activeData = active.data.current;

    // 初始化拖动状态
    if (activeData) {
      // 记录原始位置信息
      if (activeData.type === 'tab') {
        dragStateRef.current = {
          originalGroupId: activeData.groupId,
          originalIndex: activeData.index,
          currentGroupId: activeData.groupId,
          currentIndex: activeData.index,
          direction: 'none',
          isDragging: true
        };

        if (process.env.NODE_ENV === 'development') {
          console.log('Drag Start:', {
            originalGroupId: dragStateRef.current.originalGroupId,
            originalIndex: dragStateRef.current.originalIndex,
            id: active.id
          });
        }
      } else {
        dragStateRef.current = { isDragging: true };
      }
    }

    setActiveId(active.id as string);
    setActiveData(activeData);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over, delta } = event;

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // If we don't have data, return
    if (!activeData || !overData) return;

    // Handle tab movement
    if (activeData.type === 'tab' && overData.type === 'tab') {
      const overGroupId = overData.groupId;
      const overIndex = overData.index;

      // 获取当前拖动状态
      const dragState = dragStateRef.current;

      // 如果目标位置与上次相同，不重复处理
      if (
        dragState.lastOverGroupId === overGroupId &&
        dragState.lastOverIndex === overIndex
      ) {
        return;
      }

      // 更新上一次的目标位置（用于检测重复）
      dragState.lastOverGroupId = overGroupId;
      dragState.lastOverIndex = overIndex;

      // 获取当前源位置（使用当前位置作为源）
      const sourceGroupId = dragState.currentGroupId || dragState.originalGroupId || '';
      const sourceIndex = dragState.currentIndex !== undefined ?
        dragState.currentIndex :
        (dragState.originalIndex !== undefined ? dragState.originalIndex : 0);

      // 计算拖动方向
      if (sourceGroupId === overGroupId) {
        if (sourceIndex < overIndex) {
          dragState.direction = 'down';
        } else if (sourceIndex > overIndex) {
          dragState.direction = 'up';
        } else {
          dragState.direction = 'none';
        }
      } else {
        // 跨组拖动时使用鼠标移动方向
        dragState.direction = delta.y > 0 ? 'down' : 'up';
      }

      // 更新当前位置
      dragState.currentGroupId = overGroupId;
      dragState.currentIndex = overIndex;

      // 在拖动过程中只更新UI，不更新源数据
      if (sourceGroupId) { // 确保有有效的源组ID
        dispatch(moveTabAndSync({
          sourceGroupId,
          sourceIndex,
          targetGroupId: overGroupId,
          targetIndex: overIndex,
          updateSourceInDrag: false,
          direction: dragState.direction // 传递拖动方向
        }));
      }

      if (process.env.NODE_ENV === 'development') {
        console.log('Drag Over:', {
          sourceGroupId,
          sourceIndex,
          targetGroupId: overGroupId,
          targetIndex: overIndex,
          direction: dragState.direction,
          delta: delta
        });
      }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) {
      setActiveId(null);
      setActiveData(null);
      dragStateRef.current.isDragging = false;
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) {
      setActiveId(null);
      setActiveData(null);
      dragStateRef.current.isDragging = false;
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    // If we don't have data, return
    if (!activeData || !overData) {
      setActiveId(null);
      setActiveData(null);
      dragStateRef.current.isDragging = false;
      return;
    }

    // Handle group movement
    if (activeData.type === 'group' && overData.type === 'group') {
      const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === activeId);
      const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === overId);

      if (activeIndex !== -1 && overIndex !== -1) {
        dispatch(moveGroupAndSync({ dragIndex: activeIndex, hoverIndex: overIndex }));
      }
    }
    // 标签拖动结束时的处理
    else if (activeData.type === 'tab' && overData.type === 'tab') {
      const dragState = dragStateRef.current;

      // 使用原始位置和最终目标位置
      const finalSourceGroupId = dragState.originalGroupId;
      const finalSourceIndex = dragState.originalIndex;
      const finalTargetGroupId = overData.groupId;
      const finalTargetIndex = overData.index;
      const direction = dragState.direction || 'none';

      if (process.env.NODE_ENV === 'development') {
        console.log('Drag End:', {
          originalGroupId: finalSourceGroupId,
          originalIndex: finalSourceIndex,
          targetGroupId: finalTargetGroupId,
          targetIndex: finalTargetIndex
        });
      }

      // 只有当源和目标不同时才需要最终更新
      if (finalSourceGroupId && finalSourceIndex !== undefined &&
        (finalSourceGroupId !== finalTargetGroupId || finalSourceIndex !== finalTargetIndex)) {

        // 在拖动结束时执行最终移动
        dispatch(moveTabAndSync({
          sourceGroupId: finalSourceGroupId,
          sourceIndex: finalSourceIndex,
          targetGroupId: finalTargetGroupId,
          targetIndex: finalTargetIndex,
          updateSourceInDrag: true, // 拖动完成，需要更新源位置
          direction // 传递拖动方向
        }));
      }
    }

    // 重置拖动状态
    dragStateRef.current = { isDragging: false };
    setActiveId(null);
    setActiveData(null);
  };

  // 简化拖拽覆盖层，提供更清晰的视觉反馈
  const renderDragOverlay = () => {
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
            <div className="truncate text-blue-600 text-sm">
              {tab.title}
            </div>
          </div>
        </div>
      );
    }

    if (activeData.type === 'group') {
      const { group } = activeData;
      return (
        <div className="drag-overlay group-overlay">
          <div className="flex items-center space-x-2">
            <div className="truncate font-medium text-gray-700">
              {group.name}
            </div>
            <div className="text-xs text-gray-500 whitespace-nowrap">
              {group.tabs.length} 个标签页
            </div>
          </div>
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
      ) : (
        <DndKitProvider
          sensors={sensors}
          collisionDetection={(args) => {
            // 使用鼠标指针位置作为主要碰撞检测方式
            // 这样可以确保拖动时能够准确地检测到鼠标下方的元素
            return pointerWithin(args);
          }}
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
                    .map((group) => (
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
                    .map((group) => (
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
                  <SortableTabGroup
                    key={group.id}
                    group={group}
                    index={index}
                  />
                ))}
              </div>
            </SortableContext>
          )}

          {/* Drag Overlay - 添加平滑动画 */}
          <DragOverlay dropAnimation={{
            duration: 150,
            easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
          }}>
            {renderDragOverlay()}
          </DragOverlay>
        </DndKitProvider>
      )}
    </div>
  );
};
