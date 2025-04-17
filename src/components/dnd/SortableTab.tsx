import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tab } from '@/types/tab';
import '@/styles/drag-drop.css';

interface SortableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

export const SortableTab: React.FC<SortableTabProps> = ({
  tab,
  groupId,
  index,
  handleOpenTab,
  handleDeleteTab
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
    over,
  } = useSortable({
    id: `${groupId}-tab-${tab.id}`,
    data: {
      type: 'tab',
      tab,
      groupId,
      index,
      originalGroupId: groupId,
      originalIndex: index
    }
  });

  // 提供清晰的拖拽反馈
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.6 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 999 : 'auto',
    transition: isDragging ? undefined : 'transform 0.15s ease, opacity 0.15s ease',
  };

  // 检测是否有其他元素悬停在上面
  const isOver = over && over.id !== `${groupId}-tab-${tab.id}`;

  // 获取悬停元素的数据和位置
  const overData = over?.data.current;
  const overIndex = overData?.index;

  // 获取鼠标在元素上的相对位置
  const clientOffset = transform?.y || 0;

  // 使用更精确的方式判断鼠标位置
  // 如果变换值为负，说明鼠标在元素上半部
  const isMouseInUpperHalf = clientOffset < 0;

  // 结合鼠标位置和索引关系决定视觉反馈
  // 当鼠标在上半部或者目标索引小于当前索引时，显示上方插入指示器
  const isOverAbove = isOver && (isMouseInUpperHalf || (overIndex !== undefined && overIndex < index));

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center py-1 px-2 hover:bg-gray-100 rounded select-none cursor-move tab-item
        ${isDragging ? 'bg-gray-50 border border-gray-300 dragging shadow-md' : ''}
        ${isOver ? 'drop-target' : ''}
      `}
      {...attributes}
      {...listeners}
    >
      {/* 添加插入指示器 - 使用更明显的视觉效果 */}
      {isOver && (
        <div
          className={`insert-indicator ${isOverAbove ? 'insert-indicator-top' : 'insert-indicator-bottom'}`}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: '2px',
            backgroundColor: '#3b82f6', // 蓝色
            zIndex: 1000,
            ...(isOverAbove ? { top: 0 } : { bottom: 0 }),
          }}
        />
      )}
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
        className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 ml-1 opacity-0 group-hover:opacity-100"
        title="删除标签页"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
