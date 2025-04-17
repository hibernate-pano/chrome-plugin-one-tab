import React, { useEffect, useState, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
// No need to import TabGroup type as we're not using it directly
import { SortableTabGroup } from '@/components/dnd/SortableTabGroup';
import { DndKitProvider } from '@/components/dnd/DndKitProvider';
import {
  DragOverlay,
  closestCorners,
  pointerWithin,
  rectIntersection,
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

  // 添加一个引用来跟踪最后的移动操作
  const lastMoveRef = useRef<{
    sourceGroupId?: string;
    sourceIndex?: number;
    targetGroupId?: string;
    targetIndex?: number;
  } | null>(null);

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

    // 保存原始位置信息，用于拖动结束时的处理
    if (activeData && activeData.type === 'tab') {
      // 清除之前的原始位置信息（如果有）
      delete activeData.originalGroupId;
      delete activeData.originalIndex;

      // 保存新的原始位置信息
      activeData.originalGroupId = activeData.groupId;
      activeData.originalIndex = activeData.index;

      console.log('Drag Start:', {
        originalGroupId: activeData.originalGroupId,
        originalIndex: activeData.originalIndex,
        id: active.id
      });
    }

    setActiveId(active.id as string);
    setActiveData(activeData);

    // 重置最后移动操作
    lastMoveRef.current = null;
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
      // 获取当前拖动标签的实际位置信息
      // 注意：这里使用activeData中的位置信息，而不是从原始事件中获取
      // 这样可以确保连续拖动时使用最新的位置信息
      const activeGroupId = activeData.groupId;
      const activeIndex = activeData.index;
      const overGroupId = overData.groupId;
      const overIndex = overData.index;

      // 获取鼠标移动的方向和距离
      const mouseMovementY = delta.y;
      const isMovingUp = mouseMovementY < 0;
      const isMovingDown = mouseMovementY > 0;

      // If it's the same tab, return
      if (activeGroupId === overGroupId && activeIndex === overIndex) return;

      // 检查这次移动是否与最后一次移动相同，如果相同则不重复派发
      const lastMove = lastMoveRef.current;
      if (
        lastMove &&
        lastMove.sourceGroupId === activeGroupId &&
        lastMove.sourceIndex === activeIndex &&
        lastMove.targetGroupId === overGroupId &&
        lastMove.targetIndex === overIndex
      ) {
        return;
      }

      // 更新最后的移动操作
      lastMoveRef.current = {
        sourceGroupId: activeGroupId,
        sourceIndex: activeIndex,
        targetGroupId: overGroupId,
        targetIndex: overIndex
      };

      // 在拖动过程中，只更新目标位置的数据，而不更新拖动源的数据
      // 这使得连续拖动成为可能
      const movePayload = {
        sourceGroupId: activeGroupId,
        sourceIndex: activeIndex,
        targetGroupId: overGroupId,
        targetIndex: overIndex,
        updateSourceInDrag: false // 添加标志，表示在拖动中不更新源位置
      };

      // Dispatch move tab action
      dispatch(moveTabAndSync(movePayload));

      // 更新activeData中的位置信息，确保下一次拖动参考的是正确的新位置
      // 这是连续拖动的关键 - 我们需要立即更新拖动项的位置信息
      // 保存原始位置信息（如果还没有保存）
      if (!activeData.originalGroupId) {
        activeData.originalGroupId = activeGroupId;
      }
      if (activeData.originalIndex === undefined) {
        activeData.originalIndex = activeIndex;
      }

      // 计算拖动方向
      const isDraggingUp = activeIndex > overIndex;
      const isDraggingDown = activeIndex < overIndex;
      const isSameGroup = activeGroupId === overGroupId;

      // 更新当前位置
      activeData.groupId = overGroupId;
      activeData.index = overIndex;

      // 添加鼠标移动方向信息
      activeData.isMovingUp = isMovingUp;
      activeData.isMovingDown = isMovingDown;

      // 输出日志，帮助调试
      console.log('Drag Over:', {
        originalGroupId: activeData.originalGroupId,
        originalIndex: activeData.originalIndex,
        currentGroupId: activeData.groupId,
        currentIndex: activeData.index,
        direction: isDraggingUp ? 'up' : isDraggingDown ? 'down' : 'same',
        mouseDirection: isMovingUp ? 'up' : isMovingDown ? 'down' : 'none',
        isSameGroup,
        delta: delta
      });
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) {
      setActiveId(null);
      setActiveData(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) {
      setActiveId(null);
      setActiveData(null);
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    // If we don't have data, return
    if (!activeData || !overData) {
      setActiveId(null);
      setActiveData(null);
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
    // 标签拖动结束时的处理，确保最后一次应用完整移动
    else if (activeData.type === 'tab' && overData.type === 'tab') {
      // 使用原始位置信息作为源，使用overData作为目标
      const finalSourceGroupId = activeData.originalGroupId;
      const finalSourceIndex = activeData.originalIndex;
      const finalTargetGroupId = overData.groupId; // 使用overData中的目标组ID
      const finalTargetIndex = overData.index; // 使用overData中的目标索引

      // 计算拖动方向
      const isDraggingUp = finalSourceIndex !== undefined && finalSourceIndex > finalTargetIndex;
      const isDraggingDown = finalSourceIndex !== undefined && finalSourceIndex < finalTargetIndex;
      const isSameGroup = finalSourceGroupId === finalTargetGroupId;

      // 输出日志，帮助调试
      console.log('Drag End:', {
        originalGroupId: finalSourceGroupId,
        originalIndex: finalSourceIndex,
        targetGroupId: finalTargetGroupId,
        targetIndex: finalTargetIndex,
        activeDataGroupId: activeData.groupId,
        activeDataIndex: activeData.index,
        direction: isDraggingUp ? 'up' : isDraggingDown ? 'down' : 'same',
        isSameGroup
      });

      // 只有当源和目标不同时才需要最终更新
      if (finalSourceGroupId && finalSourceIndex !== undefined &&
        (finalSourceGroupId !== finalTargetGroupId || finalSourceIndex !== finalTargetIndex)) {

        // 在拖动结束时，我们需要使用原始源位置和最终目标位置
        dispatch(moveTabAndSync({
          sourceGroupId: finalSourceGroupId,
          sourceIndex: finalSourceIndex,
          targetGroupId: finalTargetGroupId,
          targetIndex: finalTargetIndex,
          updateSourceInDrag: true // 拖动完成，需要更新源位置
        }));
      }
    }

    // 重置最后移动操作
    lastMoveRef.current = null;
    setActiveId(null);
    setActiveData(null);
  };

  // 简化拖拽覆盖层，提供更清晰的视觉反馈
  const renderDragOverlay = () => {
    if (!activeId || !activeData) return null;

    if (activeData.type === 'tab') {
      const { tab } = activeData;
      return (
        <div className="flex items-center py-1 px-2 bg-white rounded border border-gray-300 shadow-md max-w-md">
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
        <div className="bg-white rounded-lg border border-gray-300 p-2 max-w-md shadow-md">
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
            // 使用更精确的碰撞检测算法组合
            // 首先使用 pointerWithin 检测鼠标指针所在的元素
            const pointerCollisions = pointerWithin(args);
            if (pointerCollisions.length > 0) {
              return pointerCollisions;
            }

            // 如果没有直接的指针碰撞，使用矩形交叉检测
            const rectCollisions = rectIntersection(args);
            if (rectCollisions.length > 0) {
              return rectCollisions;
            }

            // 最后使用最接近角点的算法
            return closestCorners(args);
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

          {/* Drag Overlay */}
          <DragOverlay dropAnimation={null}>
            {renderDragOverlay()}
          </DragOverlay>
        </DndKitProvider>
      )}
    </div>
  );
};
