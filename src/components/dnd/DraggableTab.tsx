import React, { useRef, useCallback, useMemo, useState } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';
import { throttle } from 'lodash';
import { SafeFavicon } from '@/components/common/SafeFavicon';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
  isCollapsed?: boolean;
  isLocked?: boolean;
}

// 钉住图标
const PinIcon = () => (
  <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

// 删除图标
const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

/**
 * 可拖拽的标签页组件
 * 使用React.memo优化渲染性能
 */
export const DraggableTab: React.FC<DraggableTabProps> = React.memo(({
  tab,
  groupId,
  index,
  moveTab,
  handleOpenTab,
  handleDeleteTab,
  isCollapsed = false,
  isLocked = false
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isShaking, setIsShaking] = useState(false);

  const throttledMoveTab = useMemo(
    () => throttle((sourceGroupId, sourceIndex, targetGroupId, targetIndex) => {
      moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
    }, 100),
    [moveTab]
  );

  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index } as TabDragItem,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
    end: (_, monitor) => {
      if (!monitor.didDrop()) {
        const element = ref.current;
        if (element) {
          element.classList.add('animate-tab-drag-return');
          setTimeout(() => {
            element.classList.remove('animate-tab-drag-return');
          }, 300);
        }
      }
    }
  });

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.TAB,
    hover: (item: TabDragItem, monitor) => {
      if (!ref.current) return;

      const sourceGroupId = item.groupId;
      const sourceIndex = item.index;
      const targetGroupId = groupId;
      const targetIndex = index;

      if (sourceGroupId === targetGroupId && sourceIndex === targetIndex) return;

      const hoverBoundingRect = ref.current.getBoundingClientRect();
      const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
      const clientOffset = monitor.getClientOffset();
      const hoverClientY = clientOffset!.y - hoverBoundingRect.top;
      const hoverPercentage = (hoverClientY - hoverMiddleY) / hoverMiddleY;
      const threshold = 0.2;

      if (sourceGroupId === targetGroupId && sourceIndex < targetIndex && hoverPercentage < -threshold) return;
      if (sourceGroupId === targetGroupId && sourceIndex > targetIndex && hoverPercentage > threshold) return;

      throttledMoveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
      item.index = targetIndex;
      item.groupId = targetGroupId;
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  drag(drop(ref));

  const tabTitle = useMemo(() => tab.title, [tab.title]);

  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isLocked) {
      setIsShaking(true);
      setTimeout(() => setIsShaking(false), 500);
      return;
    }
    handleOpenTab(tab);
  }, [handleOpenTab, tab, isLocked]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // 触发删除动画
    setIsDeleting(true);
    setTimeout(() => {
      handleDeleteTab(tab.id);
    }, 200);
  }, [handleDeleteTab, tab.id]);

  // 提取域名显示
  const displayUrl = useMemo(() => {
    try {
      const url = new URL(tab.url);
      return url.hostname.replace('www.', '');
    } catch {
      return tab.url;
    }
  }, [tab.url]);

  return (
    <div
      ref={ref}
      className={`tab-item group/tab micro-interaction-card cursor-grab relative
        ${isDragging ? 'cursor-grabbing shadow-xl scale-105 opacity-90 z-50' : ''}
        ${isOver && canDrop ? 'drop-target scale-[1.05] bg-primary-100/70 dark:bg-primary-800/40 ring-2 ring-primary border-2 border-dashed border-primary' : ''}
        ${isDeleting ? 'animate-slide-out-right opacity-0 scale-95' : ''}
        ${isShaking ? 'animate-shake' : ''}
        ${!isDeleting && !isDragging && !isShaking ? 'hover:scale-[1.02] hover:bg-primary/5 active:scale-[0.98] transition-all duration-200 ease-out' : ''}
        ${isCollapsed ? 'animate-fade-in-up' : ''}`}
      style={isCollapsed ? { animationDelay: `${index * 100}ms` } : undefined}
      role="listitem"
    >
      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt={`${tab.title} 网站图标`} className="tab-item-favicon transition-transform duration-100 hover:scale-125 hover:shadow-sm" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          onClick={handleTabClick}
          title={tabTitle}
          aria-label={`打开标签页: ${tabTitle}${tab.pinned ? ' (固定)' : ''}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleTabClick(e as any);
            }
          }}
        >
          {tabTitle}
          {tab.pinned && <PinIcon />}
        </a>
        <span 
          className="tab-item-url hidden sm:block"
          aria-label={`网址: ${tab.url}`}
        >
          {displayUrl}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="tab-item-actions">
        <button
          onClick={handleDelete}
          className="btn-icon p-1 tab-item-delete-btn micro-interaction-button hover:scale-90 hover:bg-red-100 dark:hover:bg-red-900/50 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          title="删除标签页"
          aria-label={`删除标签页: ${tabTitle}`}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  const basicPropsEqual =
    prevProps.tab.id === nextProps.tab.id &&
    prevProps.groupId === nextProps.groupId &&
    prevProps.index === nextProps.index;

  if (!basicPropsEqual) return false;

  const tabContentEqual =
    prevProps.tab.title === nextProps.tab.title &&
    prevProps.tab.url === nextProps.tab.url &&
    prevProps.tab.favicon === nextProps.tab.favicon &&
    prevProps.tab.lastAccessed === nextProps.tab.lastAccessed &&
    prevProps.tab.pinned === nextProps.tab.pinned;

  if (!tabContentEqual) return false;

  const callbacksEqual =
    prevProps.moveTab === nextProps.moveTab &&
    prevProps.handleOpenTab === nextProps.handleOpenTab &&
    prevProps.handleDeleteTab === nextProps.handleDeleteTab;

  return callbacksEqual;
});
