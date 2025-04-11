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
      className={`flex items-center py-3 px-4 bg-white hover:bg-gray-100 rounded-lg transition-material shadow-sm border border-gray-200 ${isDragging ? 'opacity-50 border-dashed border-primary-400' : 'opacity-100'}`}
      style={{ cursor: 'move' }}
    >
      <div className="flex items-center space-x-3 flex-1 min-w-0">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" className="w-5 h-5 flex-shrink-0 rounded-sm" />
        ) : (
          <div className="w-5 h-5 bg-gray-200 rounded-sm flex-shrink-0 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        )}
        <a
          href="#"
          className="truncate text-primary-700 hover:text-primary-900 font-medium hover:underline"
          onClick={(e) => {
            e.preventDefault();
            handleOpenTab(tab);
          }}
          title={tab.title}
        >
          {tab.title}
        </a>
      </div>
      <div className="flex items-center space-x-1">
        <span className="text-xs text-gray-400 truncate max-w-[150px] hidden sm:inline">{tab.url}</span>
        <button
          onClick={() => handleDeleteTab(tab.id)}
          className="text-gray-400 hover:text-error p-1.5 rounded-full hover:bg-gray-200 transition-material ml-1 opacity-0 group-hover:opacity-100"
          title="删除标签页"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};
