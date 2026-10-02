import React, { useRef, useCallback, useMemo } from 'react';
import { useDrag, useDrop } from 'react-dnd';
import { Tab } from '@/types/tab';
import { ItemTypes, TabDragItem } from './DndTypes';
import { nextReorderIndex } from './keyboardReorder';
import { SafeFavicon } from '@/components/common/SafeFavicon';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  /** 同组标签总数：键盘重排的边界与「第几项」播报都要用 */
  itemCount: number;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

// 钉住图标
const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

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
  itemCount,
  moveTab,
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  const throttledMoveTab = useMemo(() => {
    // 手写节流（原 lodash.throttle，100ms leading+trailing）：
    // 拖拽 hover 高频触发，限制 moveTab 调用频率，trailing 用最新参数
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: [string, number, string, number] | null = null;
    return (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
      lastArgs = [sourceGroupId, sourceIndex, targetGroupId, targetIndex];
      const now = Date.now();
      const remaining = 100 - (now - lastCall);
      if (remaining <= 0) {
        lastCall = now;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        moveTab(sourceGroupId, sourceIndex, targetGroupId, targetIndex);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        lastCall = Date.now();
        if (lastArgs) moveTab(...lastArgs);
      }, remaining);
    };
  }, [moveTab]);

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

  // 键盘重排：拖拽只有 HTML5Backend（鼠标）一条路，纯键盘用户此前完全无法改顺序。
  // 挂在本就 Tab 可达的标题链接上——不再新增 tab stop（一行仍是 链接+删除 两个落点）。
  // 只认标题链接为触发源：焦点落在删除按钮上时按方向键不该顺手把整行挪走。
  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenTab(tab);
      return;
    }
    const nextIndex = nextReorderIndex(e.key, index, itemCount);
    if (nextIndex === null) return;
    e.preventDefault();
    // 同组内移动：source/target 同 groupId，Redux reducer 与 SW applyMoveTab 都支持
    moveTab(groupId, index, groupId, nextIndex);
    // 重排会把这一项在 DOM 里挪位置；浏览器对「被移动的已聚焦元素」处理不一致
    // （可能被判为移出文档而丢焦点）。丢焦点的话用户只能重新 Tab 回来，
    // 连续调整顺序就断了。确认真的丢了才补一次聚焦，避免无谓的滚动跳动。
    requestAnimationFrame(() => {
      const link = linkRef.current;
      if (link && document.activeElement !== link) link.focus();
    });
  }, [handleOpenTab, index, itemCount, moveTab, groupId, tab]);

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
      className={`tab-item group/tab micro-interaction-card ${isDragging ? 'dragging' : ''} ${isOver && canDrop ? 'drag-over' : ''}`}
      style={{ cursor: 'grab' }}
      // 父容器 TabGroup.tsx 同步提供 role="list"——此前全仓没有 role="list"，
      // 孤立的 listitem 是无效语义（读屏不播报"列表项 N/M"）。
      role="listitem"
    >
      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt={`${tab.title} 网站图标`} className="tab-item-favicon" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          ref={linkRef}
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors flex items-center gap-1"
          onClick={handleTabClick}
          title={tabTitle}
          aria-label={`打开标签页: ${tabTitle}${tab.pinned ? ' (固定)' : ''}，第 ${index + 1} / ${itemCount} 项，用上下方向键调整顺序`}
          aria-keyshortcuts="ArrowUp ArrowDown Home End"
          tabIndex={0}
          onKeyDown={handleTitleKeyDown}
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
          className="btn-icon theme-btn-hover p-1 tab-item-delete-btn micro-interaction-button"
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
    prevProps.index === nextProps.index &&
    prevProps.itemCount === nextProps.itemCount;

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
