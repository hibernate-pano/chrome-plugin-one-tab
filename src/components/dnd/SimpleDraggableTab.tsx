import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tab } from '@/types/tab';

interface SimpleDraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

export const SimpleDraggableTab: React.FC<SimpleDraggableTabProps> = ({
  tab,
  groupId,
  index,
  handleOpenTab,
  handleDeleteTab
}) => {
  // 使用dnd-kit的useSortable钩子
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${groupId}-tab-${tab.id}`,
    data: {
      type: 'tab',
      tab,
      groupId,
      index
    }
  });

  // 设置样式，提供清晰的拖拽反馈
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 'auto',
    position: 'relative' as const,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center py-1 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded ${isDragging ? 'opacity-50 border-dashed border-primary-400' : 'opacity-100'
        }`}
      {...attributes}
      {...listeners}
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
        className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors ml-1 opacity-0 group-hover:opacity-100"
        title="删除标签页"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
