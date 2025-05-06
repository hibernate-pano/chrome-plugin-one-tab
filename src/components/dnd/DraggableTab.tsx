import React, { useRef, useCallback } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';
import { throttle } from 'lodash';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

// 使用React.memo包装组件，避免不必要的重渲染
export const DraggableTab: React.FC<DraggableTabProps> = React.memo(({
  tab,
  groupId,
  index,
  moveTab,
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // 使用throttle包装moveTab函数，减少拖拽过程中的频繁更新
  const throttledMoveTab = useCallback(
    throttle((sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
    }, 50), // 50ms的节流时间
    [moveTab]
  );

  // 拖拽源
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // 放置目标
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.TAB,
    hover: (item: TabDragItem, monitor) => {
      if (!ref.current) {
        return;
      }

      const sourceGroupId = item.groupId;
      const sourceIndex = item.index;
      const targetGroupId = groupId;
      const targetIndex = index;

      // 如果拖拽的是自己，不做任何操作
      if (sourceGroupId === targetGroupId && sourceIndex === targetIndex) {
        return;
      }

      // 确定鼠标位置
      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset!.y - hoverBoundingRect.top;

      // 向上拖动时，只有当鼠标超过目标的一半高度时才移动
      if (sourceGroupId === targetGroupId && sourceIndex < targetIndex && hoverClientY < hoverMiddleY) {
        return;
      }

      // 向下拖动时，只有当鼠标超过目标的一半高度时才移动
      if (sourceGroupId === targetGroupId && sourceIndex > targetIndex && hoverClientY > hoverMiddleY) {
        return;
      }

      // 使用节流版本的移动函数，减少频繁更新
      throttledMoveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);

      // 更新拖拽项的索引和组ID
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  // 使用useMemo记忆化标签页标题，避免不必要的重新渲染
  const tabTitle = React.useMemo(() => tab.title, [tab.title]);

  // 使用useCallback记忆化点击处理函数
  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleOpenTab(tab);
  }, [handleOpenTab, tab]);

  const handleDelete = useCallback(() => {
    handleDeleteTab(tab.id);
  }, [handleDeleteTab, tab.id]);

  // 根据拖拽状态应用不同的样式类
  const dragClass = isDragging ? 'opacity-50 scale-105 border-dashed border-primary-400' : '';
  const dropClass = isOver && canDrop ? 'bg-primary-50 dark:bg-primary-900/20' : '';

  return (
    <div
      ref={ref}
      className={`flex items-center py-1 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200 rounded ${dragClass} ${dropClass}`}
      style={{ cursor: 'move' }}
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        ) : (
          <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 flex-shrink-0 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-gray-500 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        )}
        <a
          href="#"
          className="truncate text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline text-sm"
          onClick={handleTabClick}
          title={tabTitle}
        >
          {tabTitle}
        </a>
      </div>
      <button
        onClick={handleDelete}
        className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors ml-1 opacity-0 group-hover:opacity-100"
        title="删除标签页"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}, (prevProps, nextProps) => {
  // 优化重渲染逻辑，只有在以下情况下才重新渲染：
  // 1. 标签ID变化
  // 2. 标签标题变化
  // 3. 标签URL变化
  // 4. 标签图标变化
  // 5. 标签组ID变化
  // 6. 标签索引变化
  return (
    prevProps.tab.id === nextProps.tab.id &&
    prevProps.tab.title === nextProps.tab.title &&
    prevProps.tab.url === nextProps.tab.url &&
    prevProps.tab.favicon === nextProps.tab.favicon &&
    prevProps.groupId === nextProps.groupId &&
    prevProps.index === nextProps.index
  );
});
