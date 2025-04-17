import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
// No need to import TabGroup type as we're not using it directly
import { SortableTabGroup } from '@/components/dnd/SortableTabGroup';
import { DndKitProvider } from '@/components/dnd/DndKitProvider';
import {
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent
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

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // Filter groups based on search query
  const filteredGroups = searchQuery ? [] : groups;

  // Create a list of sortable group IDs
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // Set up sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 1, // 减少激活距离，使拖动更容易触发
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as string);
    setActiveData(active.data.current);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;

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
      const activeGroupId = activeData.groupId;
      const activeIndex = activeData.index;
      const overGroupId = overData.groupId;
      const overIndex = overData.index;

      // If it's the same tab, return
      if (activeGroupId === overGroupId && activeIndex === overIndex) return;

      // Dispatch move tab action
      dispatch(moveTabAndSync({
        sourceGroupId: activeGroupId,
        sourceIndex: activeIndex,
        targetGroupId: overGroupId,
        targetIndex: overIndex
      }));
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

    setActiveId(null);
    setActiveData(null);
  };

  // Render drag overlay content
  const renderDragOverlay = () => {
    if (!activeId || !activeData) return null;

    if (activeData.type === 'tab') {
      const { tab } = activeData;
      return (
        <div className="flex items-center py-1 px-2 bg-white rounded shadow-lg border border-gray-200 max-w-md">
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
        <div className="bg-white rounded-lg shadow-lg border border-gray-200 p-3 max-w-md">
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
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          {useDoubleColumnLayout ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2 transition-all">
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
                <div className="space-y-2 transition-all">
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
              <div className="space-y-2 transition-all">
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
          <DragOverlay adjustScale={true} zIndex={999}>
            {renderDragOverlay()}
          </DragOverlay>
        </DndKitProvider>
      )}
    </div>
  );
};
