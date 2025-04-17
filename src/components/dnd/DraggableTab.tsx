import React, { useRef, useEffect, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';
import { debounce } from 'lodash';

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
  const [isHovering, setIsHovering] = useState(false);

  // 创建一个防抖动的移动函数，避免频繁更新
  const debouncedMoveTab = useRef(
    debounce((sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
    }, 50) // 50ms 的防抖时间
  ).current;

  // 清理防抖函数
  useEffect(() => {
    return () => {
      debouncedMoveTab.cancel();
    };
  }, [debouncedMoveTab]);

  // 拖拽源
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    end: () => {
      // 拖拽结束时重置悬停状态
      setIsHovering(false);
    }
  });

  // 放置目标
  const [{ isOver }, drop] = useDrop({
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
      const hoverHeight = hoverBoundingRect.bottom - hoverBoundingRect.top;
      const hoverMiddleY = hoverHeight / 2;

      // 添加一个阈值区域，避免在中间区域频繁触发
      const thresholdSize = Math.min(hoverHeight * 0.3, 10); // 阈值区域为高度的30%，最多10像素

      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;

      const hoverClientY = clientOffset.y - hoverBoundingRect.top;

      // 判断拖拽方向和鼠标位置
      // 向上拖动时（即从下到上），鼠标应该在目标元素的上半部分
      if (sourceIndex > targetIndex && hoverClientY > hoverMiddleY + thresholdSize) {
        // 如果鼠标还在下半部分，不触发移动
        return;
      }

      // 向下拖动时（即从上到下），鼠标应该在目标元素的下半部分
      if (sourceIndex < targetIndex && hoverClientY < hoverMiddleY - thresholdSize) {
        // 如果鼠标还在上半部分，不触发移动
        return;
      }

      // 设置悬停状态
      setIsHovering(true);

      // 使用防抖函数执行移动
      debouncedMoveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);

      // 更新拖拽项的索引和组ID
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  });

  // 将拖拽源和放置目标应用到同一个元素
  drag(drop(ref));

  return (
    <div
      ref={ref}
      className={`flex items-center py-1 px-2 hover:bg-gray-100 rounded draggable-item
        ${isDragging ? 'dragging' : 'opacity-100'}
        ${isOver && isHovering ? 'drag-over' : ''}
      `}
      style={{
        cursor: 'move',
        transform: isOver && isHovering ? 'scale(1.02) translateX(3px)' : 'none',
        boxShadow: isOver && isHovering ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
        transition: 'transform 0.2s ease, background-color 0.2s ease, border 0.2s ease, box-shadow 0.2s ease',
        position: 'relative',
        zIndex: isOver && isHovering ? 10 : 'auto'
      }}
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        ) : (
          <div className="w-4 h-4 bg-gray-200 flex-shrink-0 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        )}
        <a
          href="#"
          className="truncate text-blue-600 hover:text-blue-800 hover:underline text-sm"
          onClick={(e) => {
            e.preventDefault();
            handleOpenTab(tab);
          }}
          title={tab.title}
        >
          {tab.title}
        </a>
      </div>
      <button
        onClick={() => handleDeleteTab(tab.id)}
        className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 transition-colors ml-1 opacity-0 group-hover:opacity-100"
        title="删除标签页"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
