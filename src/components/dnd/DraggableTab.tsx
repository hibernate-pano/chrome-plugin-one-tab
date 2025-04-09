import React, { useRef } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

export const DraggableTab: React.FC<DraggableTabProps> = ({ 
  tab, 
  groupId, 
  index, 
  moveTab, 
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // 拖拽源
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // 放置目标
  const [, drop] = useDrop({
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

      // 执行移动
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
      
      // 更新拖拽项的索引和组ID
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  return (
    <div 
      ref={ref} 
      className={`flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded ${
        isDragging ? 'opacity-50' : 'opacity-100'
      }`}
      style={{ cursor: 'move' }}
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0" onClick={() => handleOpenTab(tab)}>
        {tab.favicon && (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        )}
        <div className="truncate">
          <span className="font-medium">{tab.title}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 block truncate">{tab.url}</span>
        </div>
      </div>
      <button
        onClick={() => handleDeleteTab(tab.id)}
        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
