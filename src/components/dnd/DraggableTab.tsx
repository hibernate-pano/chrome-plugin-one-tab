import React, { useRef, useCallback, useMemo } from 'react';
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
}

// 删除图标
const CloseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);

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
          element.classList.add('tab-drag-return');
          setTimeout(() => {
            element.classList.remove('tab-drag-return');
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
    handleOpenTab(tab);
  }, [handleOpenTab, tab]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleDeleteTab(tab.id);
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
      className={`tab-item group/tab ${isDragging ? 'dragging' : ''} ${isOver && canDrop ? 'drag-over' : ''}`}
      style={{ cursor: 'grab' }}
    >
      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt="" className="tab-item-favicon" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          href="#"
          className="tab-item-title hover:text-accent-600 dark:hover:text-accent-400 transition-colors"
          onClick={handleTabClick}
          title={tabTitle}
        >
          {tabTitle}
        </a>
        <span className="tab-item-url hidden sm:block">
          {displayUrl}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="tab-item-actions">
        <button
          onClick={handleDelete}
          className="btn-icon p-1 hover:text-danger-500"
          title="删除标签页"
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
    prevProps.tab.lastAccessed === nextProps.tab.lastAccessed;

  if (!tabContentEqual) return false;

  const callbacksEqual =
    prevProps.moveTab === nextProps.moveTab &&
    prevProps.handleOpenTab === nextProps.handleOpenTab &&
    prevProps.handleDeleteTab === nextProps.handleDeleteTab;

  return callbacksEqual;
});
