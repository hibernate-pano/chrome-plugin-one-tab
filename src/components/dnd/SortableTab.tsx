import React, { useRef, useEffect } from 'react';
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
  handleDeleteTab,
}) => {
  // 使用ref跟踪组件是否已卸载
  const isMounted = useRef(true);

  useEffect(() => {
    // 组件挂载时设置为true
    isMounted.current = true;

    // 组件卸载时设置为false
    return () => {
      isMounted.current = false;
    };
  }, []);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: `${groupId}-tab-${tab.id}`,
    data: {
      type: 'tab',
      tab,
      groupId,
      index,
    },
  });

  // 提供清晰的拖拽反馈
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 999 : 'auto',
    transition: isDragging ? undefined : 'transform 0.15s ease, opacity 0.15s ease',
  };

  // 安全的处理函数，确保组件未卸载时才调用原始函数
  const safeHandleOpenTab = (tab: Tab) => {
    if (isMounted.current) {
      handleOpenTab(tab);
    }
  };

  const safeHandleDeleteTab = (tabId: string) => {
    if (isMounted.current) {
      handleDeleteTab(tabId);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center py-1 px-2 hover:bg-gray-100 rounded select-none cursor-move tab-item
        ${isDragging ? 'bg-blue-50 border border-blue-300 dragging shadow-md' : ''}
      `}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        {tab.favicon ? (
          <img src={tab.favicon} alt="" className="w-4 h-4 flex-shrink-0" />
        ) : (
          <div className="w-4 h-4 bg-gray-200 flex-shrink-0 flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3 w-3 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
        )}
        <a
          href="#"
          className="truncate text-blue-600 hover:text-blue-800 hover:underline text-sm"
          onClick={e => {
            e.preventDefault();
            safeHandleOpenTab(tab);
          }}
          title={tab.title}
        >
          {tab.title}
        </a>
      </div>
      <button
        onClick={() => safeHandleDeleteTab(tab.id)}
        className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 ml-1 opacity-0 group-hover:opacity-100"
        title="删除标签页"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3 w-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
};
