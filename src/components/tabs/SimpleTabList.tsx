import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';
import { moveGroup, moveTab } from '@/features/tabs/store/dragOperationsSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
import { SimpleDraggableTabGroup } from '@/components/dnd/SimpleDraggableTabGroup';
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
  closestCenter,
  UniqueIdentifier
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';


interface SimpleTabListProps {
  searchQuery: string;
}

export const SimpleTabList: React.FC<SimpleTabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector((state) => state.tabGroups.groups);
  const useDoubleColumnLayout = useAppSelector((state) => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [activeData, setActiveData] = useState<any | null>(null);

  useEffect(() => {
    dispatch(loadGroups());
  }, [dispatch]);

  // 过滤标签组
  const filteredGroups = searchQuery ? [] : groups;

  // 创建标签组ID列表
  const groupIds = filteredGroups.map(group => `group-${group.id}`);

  // 配置拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 只需要很小的移动距离就可以触发拖拽，提高灵敏度
      activationConstraint: {
        distance: 3,
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

        // 执行标签页移动
        dispatch(moveTabAndSync({
          sourceGroupId,
          sourceIndex,
          targetGroupId,
          targetIndex,
          updateSourceInDrag: true
        }));
      }
      // 处理标签组拖拽
      else if (activeData?.type === 'group' && overData?.type === 'group') {
        const activeIndex = filteredGroups.findIndex(g => `group-${g.id}` === active.id);
        const overIndex = filteredGroups.findIndex(g => `group-${g.id}` === over.id);

        if (activeIndex !== -1 && overIndex !== -1) {
          // 执行标签组移动
          dispatch(moveGroupAndSync({ dragIndex: activeIndex, hoverIndex: overIndex }));
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
        <div className="tab-drag-overlay">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="w-4 h-4 mr-2 flex-shrink-0" />
          ) : (
            <div className="w-4 h-4 bg-gray-200 mr-2 flex-shrink-0" />
          )}
          <span className="truncate">{tab.title}</span>
        </div>
      );
    }
    // 渲染标签组覆盖层
    else if (activeData.type === 'group') {
      const group = activeData.group;
      return (
        <div className="group-drag-overlay">
          <div className="font-medium">{group.name}</div>
          <div className="text-xs text-gray-500">{group.tabs.length} 个标签页</div>
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {useDoubleColumnLayout ? (
            // 双栏布局
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 偶数索引的标签组 */}
                <div className="space-y-2">
                  {filteredGroups
                    .filter((_, index) => index % 2 === 0)
                    .map((group) => (
                      <SimpleDraggableTabGroup
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
                      <SimpleDraggableTabGroup
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
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {filteredGroups.map((group, index) => (
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
          <DragOverlay dropAnimation={{
            duration: 150,
            easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
          }}>
            {renderDragOverlay()}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
};
