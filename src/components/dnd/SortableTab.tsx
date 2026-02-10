import React, { useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Tab } from '@/types/tab';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import '@/styles/drag-drop.css';

// 钉住图标
const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

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
    opacity: isDragging ? 0.7 : 1,
    zIndex: isDragging ? 999 : 'auto',
    transition: isDragging ? undefined : 'transform 0.15s ease, opacity 0.15s ease',
    boxShadow: isDragging ? '0 4px 12px rgba(59, 130, 246, 0.3)' : undefined,
    border: isDragging ? '1px solid #3b82f6' : undefined,
    backgroundColor: isDragging ? '#f0f7ff' : undefined,
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

  // 自定义删除按钮样式 - 简化实现
  const deleteButtonStyle = {
    position: 'absolute' as const,
    right: '4px',
    top: '4px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    color: '#999',
    fontSize: '12px',
    lineHeight: '1',
    textAlign: 'center' as const,
    opacity: isDragging ? 1 : 0,
    transition: 'opacity 0.2s ease',
    zIndex: 2,
    border: 'none',
    padding: 0,
    cursor: 'pointer',
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
      {/* 删除按钮 */}
      <button
        style={deleteButtonStyle}
        onClick={(e) => {
          e.stopPropagation(); // 防止触发标签点击事件
          safeHandleDeleteTab(tab.id);
        }}
        title="删除标签页"
        type="button"
      >
        ×
      </button>
      <div className="flex items-center space-x-2 flex-1 min-w-0">
        <SafeFavicon src={tab.favicon} alt="" />
        <a
          href="#"
          className="truncate text-blue-600 hover:text-blue-800 hover:underline text-sm flex items-center"
          onClick={e => {
            e.preventDefault();
            safeHandleOpenTab(tab);
          }}
          title={tab.title}
        >
          {tab.title}
          {tab.pinned && <PinIcon />}
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

export default React.memo(SortableTab, (prevProps, nextProps) => {
  return (
    prevProps.tab.id === nextProps.tab.id &&
    prevProps.tab.title === nextProps.tab.title &&
    prevProps.tab.url === nextProps.tab.url &&
    prevProps.tab.favicon === nextProps.tab.favicon &&
    prevProps.tab.pinned === nextProps.tab.pinned &&
    prevProps.groupId === nextProps.groupId &&
    prevProps.index === nextProps.index &&
    prevProps.handleOpenTab === nextProps.handleOpenTab &&
    prevProps.handleDeleteTab === nextProps.handleDeleteTab
  );
});
