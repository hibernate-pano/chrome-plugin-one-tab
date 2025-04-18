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

  // 保存拖拽初始状态的引用
  const initialDragState = useRef<{
    sourceGroupId: string | null;
    sourceIndex: number | null;
  }>({ sourceGroupId: null, sourceIndex: null });

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // Filter groups based on search query
  const filteredGroups = searchQuery ? [] : groups;

  // Create a list of sortable group IDs
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 配置拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 只需要很小的移动距离就可以触发拖拽，提高灵敏度
      activationConstraint: {
        distance: 3,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const activeData = active.data.current;

    // 记录初始拖拽状态
    if (activeData?.type === 'tab') {
      initialDragState.current = {
        sourceGroupId: activeData.groupId,
        sourceIndex: activeData.index
      };
    }

    // 记录开始拖拽的元素信息
    console.log('[DEBUG] Drag Start:', {
      id: active.id,
      type: activeData?.type,
      groupId: activeData?.groupId,
      index: activeData?.index
    });

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

    // 如果没有数据，直接返回
    if (!activeData || !overData) return;

    // 处理标签拖拽
    if (activeData.type === 'tab' && overData.type === 'tab') {
      // 始终使用初始拖拽状态，而不是当前可能已经改变的activeData
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex = initialDragState.current.sourceIndex !== null ?
        initialDragState.current.sourceIndex : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 判断是否是同一标签组内的移动
      const isSameGroup = sourceGroupId === targetGroupId;

      // 不重复处理拖拽到自己的情况
      if (isSameGroup && sourceIndex === targetIndex) {
        return;
      }

      // 计算拖动方向
      const direction = delta.y > 0 ? 'down' : (delta.y < 0 ? 'up' : 'none');

      console.log('[DEBUG] Drag Over:', {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        isSameGroup,
        direction,
        delta
      });

      // 实时更新UI - 使用原始源索引
      dispatch(moveTabAndSync({
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        updateSourceInDrag: false
      }));

      // 不更新activeData中的索引，保持原始索引不变
      // 只更新组ID，以便显示正确的拖拽预览
      activeData.groupId = targetGroupId;
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over, delta } = event;

    if (!over) {
      setActiveId(null);
      setActiveData(null);
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) {
      setActiveId(null);
      setActiveData(null);
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    // 如果没有数据，直接返回
    if (!activeData || !overData) {
      setActiveId(null);
      setActiveData(null);
      initialDragState.current = { sourceGroupId: null, sourceIndex: null };
      return;
    }

    // 处理标签拖拽
    if (activeData.type === 'tab' && overData.type === 'tab') {
      // 使用初始拖拽状态，而不是当前可能已经改变的activeData
      const sourceGroupId = initialDragState.current.sourceGroupId || activeData.groupId;
      const sourceIndex = initialDragState.current.sourceIndex !== null ?
        initialDragState.current.sourceIndex : activeData.index;

      const targetGroupId = overData.groupId;
      const targetIndex = overData.index;

      // 计算拖动方向
      const direction = delta?.y > 0 ? 'down' : (delta?.y < 0 ? 'up' : 'none');

      console.log('[DEBUG] Drag End:', {
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        direction,
        delta
      });

      // 在拖动结束时执行最终更新
      dispatch(moveTabAndSync({
        sourceGroupId,
        sourceIndex,
        targetGroupId,
        targetIndex,
        updateSourceInDrag: true
      }));
    }
    // 处理组拖拽
    else if (activeData.type === 'group' && overData.type === 'group') {
      const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === activeId);
      const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === overId);

      if (activeIndex !== -1 && overIndex !== -1) {
        dispatch(moveGroupAndSync({ dragIndex: activeIndex, hoverIndex: overIndex }));
      }
    }

    // 清理所有状态
    setActiveId(null);
    setActiveData(null);
    initialDragState.current = { sourceGroupId: null, sourceIndex: null };
  };

  // 渲染拖拽覆盖层
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
