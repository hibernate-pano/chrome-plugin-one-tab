/**
 * 会话内的标签行（原生 HTML5 拖拽 + 键盘重排）。
 *
 * ── 2026-10-05 瘦身：react-dnd → 原生 Drag and Drop ──
 * 原实现用 react-dnd + HTML5Backend，只为「拖动一行换个位置」这一件事，
 * 代价是 1.1 MB 依赖（react-dnd 784 KB + html5-backend 360 KB 源码），
 * 而且懒加载被 vite 的 manualChunks 规则击穿（`id.includes('node_modules/react')`
 * 同时匹配 `node_modules/react-dnd`），react-dnd 实际被打进 react-vendor 并被
 * index.html 的 modulepreload 预加载——每次开 popup 都要同步下载这 ~30 KB gzip。
 *
 * 原生方案用同一个浏览器 API（HTML5 drag events），零依赖、零 chunk 增长。
 * 行为保持一致：拖到目标行上、下方 1/5 与上方 1/5 不触发（避免抖动）、
 * 100ms 节流、拖回原位播放回弹动画、键盘上下/Home/End 重排不变。
 */
import React, { useRef, useCallback, useMemo, useState } from 'react';
import { Tab } from '@/types/tab';
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
  /** 锁定组恢复时不消费（不删本地项），因此不显示「已打开」态与移除按钮 */
  isLockedGroup?: boolean;
}

/** 内部拖拽载荷的 dataTransfer 类型（MIME）。私有前缀：不会与外部拖入冲突。 */
const TAB_MIME = 'application/x-tapstack-tab';

/** 拖到目标行上、下方超过这个比例不换位——否则行会抖动（与原实现同阈值）。 */
const EDGE_THRESHOLD = 0.2;

/** 节流间隔：hover 高频触发，限制落盘频率（与原实现一致）。 */
const MOVE_THROTTLE_MS = 100;

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

/** 在 dataTransfer 里读写拖拽载荷（结构化克隆在此传输，跨文档也可用）。 */
interface TabPayload {
  tabId: string;
  groupId: string;
  index: number;
}

function readPayload(e: React.DragEvent): TabPayload | null {
  const raw = e.dataTransfer.getData(TAB_MIME);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as TabPayload;
    return typeof p?.tabId === 'string' && typeof p?.groupId === 'string' && typeof p?.index === 'number'
      ? p
      : null;
  } catch {
    return null;
  }
}

export const DraggableTab: React.FC<DraggableTabProps> = React.memo(({
  tab,
  groupId,
  index,
  itemCount,
  moveTab,
  handleOpenTab,
  handleDeleteTab,
  isLockedGroup
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  // 拖拽过程中把「当前所在下标」记在 ref 上：hover 事件里读它，
  // 避免用闭包里的旧 index 反复换位（原实现靠可变 item 对象达到同效果）。
  const dragIndexRef = useRef(index);
  dragIndexRef.current = index;
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

  const throttledMoveTab = useMemo(() => {
    // 手写节流（原实现同款，100ms leading+trailing）：
    // 拖拽 hover 高频触发，限制 moveTab 调用频率，trailing 用最新参数
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: [string, number, string, number] | null = null;
    return (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
      lastArgs = [sourceGroupId, sourceIndex, targetGroupId, targetIndex];
      const now = Date.now();
      const remaining = MOVE_THROTTLE_MS - (now - lastCall);
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

  const playReturnAnimation = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.add('tab-drag-return');
    setTimeout(() => el.classList.remove('tab-drag-return'), 300);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(TAB_MIME, JSON.stringify({ tabId: tab.id, groupId, index } satisfies TabPayload));
    // Firefox 需要至少设置一样数据才会真正开始拖拽。
    e.dataTransfer.setData('text/plain', tab.url);
    setIsDragging(true);
  }, [groupId, index, tab.id, tab.url]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    setIsOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const payload = readPayload(e);
    if (!payload || !ref.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const sourceGroupId = payload.groupId;
    const sourceIndex = dragIndexRef.current;
    if (sourceGroupId === groupId && sourceIndex === index) return;

    const rect = ref.current.getBoundingClientRect();
    const hoverMiddleY = (rect.bottom - rect.top) / 2;
    const hoverPercentage = (e.clientY - rect.top - hoverMiddleY) / hoverMiddleY;

    // 同组内：往下拖时，目标行上半区才换位；往上拖时反之。防止边界抖动。
    if (sourceGroupId === groupId && sourceIndex < index && hoverPercentage < -EDGE_THRESHOLD) return;
    if (sourceGroupId === groupId && sourceIndex > index && hoverPercentage > EDGE_THRESHOLD) return;

    throttledMoveTab(sourceGroupId, sourceIndex, groupId, index);
  }, [groupId, index, throttledMoveTab]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (readPayload(e)) {
      e.preventDefault();
      setIsOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // relatedTarget 为 null 时是拖出窗口（此时不该清高亮）；否则确实离开了本行。
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsOver(false);
    // 位置已经在 hover 阶段换过了；这里只负责收尾（没换过 = 拖回原位，回弹一下）。
    if (dragIndexRef.current === index) playReturnAnimation();
  }, [index, playReturnAnimation]);

  const tabTitle = useMemo(() => tab.title, [tab.title]);

  // 2026-10-07 P1-2：锁定组恢复不消费（不删本地项），所以不显示「已打开」态 ——
  // 否则会给用户一个「我明明没消费，凭什么说已打开」的假信号。
  const showOpenedState = !isLockedGroup && tab.openedAt !== undefined;

  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleOpenTab(tab);
  }, [handleOpenTab, tab]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleDeleteTab(tab.id);
  }, [handleDeleteTab, tab.id]);

  // 键盘重排：拖拽只有鼠标一条路，纯键盘用户此前完全无法改顺序。
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
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`tab-item group/tab micro-interaction-card ${isDragging ? 'dragging' : ''} ${isOver ? 'drag-over' : ''} ${tab.unopenable ? 'tab-item-unopenable' : ''} ${showOpenedState ? 'tab-item-opened' : ''}`}
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
          aria-label={
            tab.unopenable
              ? `${tabTitle}（此标签在当前设备无法打开，仍保留在会话中），第 ${index + 1} / ${itemCount} 项，用上下方向键调整顺序`
              : `${showOpenedState ? '已打开，可再次打开' : '打开标签页'}: ${tabTitle}${tab.pinned ? ' (固定)' : ''}，第 ${index + 1} / ${itemCount} 项，用上下方向键调整顺序`
          }
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
        {/* 2026-10-07 P1-2：已打开的行显式呈现「已打开」+ 一个明确的「移除」。
            原来点开即从会话删除，且与删除按钮撞形 —— 用户以为在导航，实际在
            不可撤销地销毁一条记录。现在消费是显式的第二步动作。 */}
        {showOpenedState && (
          <span
            className="tab-item-opened-badge"
            title="已在本机打开过这条记录，它仍保留在会话里"
          >
            已打开
          </span>
        )}
        <button
          onClick={handleDelete}
          className="btn-icon theme-btn-hover p-1 tab-item-delete-btn micro-interaction-button"
          title={showOpenedState ? '从会话中移除这条记录（不影响已打开的标签页）' : '从会话中移除这条记录'}
          aria-label={`从会话中移除: ${tabTitle}`}
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
