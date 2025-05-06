import React, { useEffect, useState, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups, moveGroupAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { SearchResultList } from '@/components/search/SearchResultList';
import { SimpleDraggableTabGroup } from '@/components/dnd/SimpleDraggableTabGroup';
import { FixedSizeList as List } from 'react-window';
import '@/styles/drag-drop.css';
import { Tab, TabGroup } from '@/types/tab';
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

interface VirtualTabListProps {
  searchQuery: string;
}

export const VirtualTabList: React.FC<VirtualTabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector((state) => state.tabs.groups);
  const useDoubleColumnLayout = useAppSelector((state) => state.settings.useDoubleColumnLayout);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  // 定义拖拽项数据类型
  type DragItemData = {
    type: 'tab' | 'group';
    tab?: Tab;
    group?: TabGroup;
    groupId?: string;
    index?: number;
  };

  const [activeData, setActiveData] = useState<DragItemData | null>(null);
  const [listHeight, setListHeight] = useState(window.innerHeight - 120); // 减去头部和其他UI元素的高度
  const containerRef = useRef<HTMLDivElement>(null);

  // 在组件挂载和窗口大小变化时更新列表高度
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const containerRect = containerRef.current.getBoundingClientRect();
        setListHeight(window.innerHeight - containerRect.top - 20); // 减去底部边距
      } else {
        setListHeight(window.innerHeight - 120);
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

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

  // 单栏布局的行渲染器
  const SingleColumnRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const group = filteredGroups[index];
    return (
      <div style={style}>
        <SimpleDraggableTabGroup
          key={group.id}
          group={group}
          index={index}
        />
      </div>
    );
  };

  // 双栏布局的左栏行渲染器
  const LeftColumnRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const groupIndex = index * 2;
    if (groupIndex >= filteredGroups.length) return null;
    const group = filteredGroups[groupIndex];
    return (
      <div style={style}>
        <SimpleDraggableTabGroup
          key={group.id}
          group={group}
          index={filteredGroups.findIndex(g => g.id === group.id)}
        />
      </div>
    );
  };

  // 双栏布局的右栏行渲染器
  const RightColumnRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const groupIndex = index * 2 + 1;
    if (groupIndex >= filteredGroups.length) return null;
    const group = filteredGroups[groupIndex];
    return (
      <div style={style}>
        <SimpleDraggableTabGroup
          key={group.id}
          group={group}
          index={filteredGroups.findIndex(g => g.id === group.id)}
        />
      </div>
    );
  };

  // 估算每个标签组的高度
  // 这是一个简化的估算，实际上每个标签组的高度会根据内容而变化
  const estimateGroupHeight = (group: TabGroup) => {
    // 标签组头部高度 + 每个标签的高度 * 标签数量
    return 60 + (group.tabs.length * 40);
  };

  // 计算双栏布局的行数
  const getDoubleColumnRowCount = () => {
    return Math.ceil(filteredGroups.length / 2);
  };

  return (
    <div className="space-y-2" ref={containerRef}>
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
          <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
            {useDoubleColumnLayout ? (
              // 双栏布局
              <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-3">
                {/* 左栏 - 虚拟列表 */}
                <div className="space-y-2">
                  <List
                    height={listHeight}
                    width="100%"
                    itemCount={getDoubleColumnRowCount()}
                    itemSize={150} // 使用固定高度，或者实现可变高度列表
                  >
                    {LeftColumnRow}
                  </List>
                </div>

                {/* 右栏 - 虚拟列表 */}
                <div className="space-y-2">
                  <List
                    height={listHeight}
                    width="100%"
                    itemCount={getDoubleColumnRowCount()}
                    itemSize={150} // 使用固定高度，或者实现可变高度列表
                  >
                    {RightColumnRow}
                  </List>
                </div>
              </div>
            ) : (
              // 单栏布局 - 虚拟列表
              <List
                height={listHeight}
                width="100%"
                itemCount={filteredGroups.length}
                itemSize={150} // 使用固定高度，或者实现可变高度列表
              >
                {SingleColumnRow}
              </List>
            )}
          </SortableContext>

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

export default VirtualTabList;
