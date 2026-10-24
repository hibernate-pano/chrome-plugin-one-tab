import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { TabGroup as TabGroupType } from '@/types/tab';
import { TabGroup } from '@/components/tabs/TabGroup';
import { useNearViewport } from '@/hooks/useNearViewport';
import {
  cardHeightFor,
  getCardHeaderHeight,
  getRowStride,
  subscribeCardHeaderHeight,
  subscribeRowStride,
} from '@/components/tabs/cardMetrics';

interface DraggableTabGroupProps {
  group: TabGroupType;
  /**
   * 折叠态（**由列表层持有**，2026-10-24 审计 PERF-03）。
   *
   * 为什么不在卡片内部持有：卡片远离视口时会被**卸载**（只留等高占位）⇒
   * 折叠状态留在卡片里就会随卸载一起没了 ⇒ 用户滚远再滚回来，
   * 刚才收起的会话又弹开了。
   */
  collapsed: boolean;
  /** 折叠/展开的切换回调（同样在列表层）。 */
  onToggleCollapsed: () => void;
}

export const DraggableTabGroup: React.FC<DraggableTabGroupProps> = ({
  group,
  collapsed,
  onToggleCollapsed,
}) => {
  const [ref, isNearViewport] = useNearViewport<HTMLDivElement>();
  const [focused, setFocused] = useState(false);

  // 卡头高度与行距是整份列表共享的两个值（量出来的，见 cardMetrics）。
  //
  // ⚠️ SSR（本仓的测试用 renderToStaticMarkup）必须给 getServerSnapshot，
  // 否则 React 报「Missing getServerSnapshot」并回退到客户端渲染。
  const headerHeight = useSyncExternalStore(
    subscribeCardHeaderHeight,
    getCardHeaderHeight,
    getCardHeaderHeight
  );
  const rowStride = useSyncExternalStore(subscribeRowStride, getRowStride, getRowStride);

  // 会话组级拖拽保持禁用（产品决策：组固定位置，只允许组内标签重排）。
  // 标签级拖拽见 DraggableTab（2026-10-10 已转正为真实可用）。

  // ── 2026-10-24 审计 PERF-03：远离视口的卡**整张**只留一个等高占位 ──────
  //
  // 修复前 1000 个会话 ⇒ 1000 张卡全部挂载（每张卡头约 45 个 DOM 节点）
  // ⇒ 4.5 万个 DOM 节点 + 一条 1.46～1.63 秒的长任务占住主线程。
  //
  // 现在：只有接近视口的卡才真的挂载，其余只留一个**等高**的占位
  // （高度与真卡逐像素一致 ⇒ 文档总高不变 ⇒ 滚动条不漂）。
  //
  // ⚠️ 卡头高度与行距都必须**量**，不能写死（卡头随断点变化、行距随主题与
  // 缩放变化）⇒ 见 cardMetrics。量出来的值与真卡用的是**同一个**
  // ⇒ 占位与真卡逐像素一致（否则滚动条会漂）。
  const showCard = isNearViewport || focused;

  // 焦点还在卡里 ⇒ 绝不卸载（否则用户正在重命名的草稿会随卸载消失）。
  const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    // 焦点只是在这张卡内部移动（按钮 → 按钮）⇒ 仍然算「焦点在卡里」。
    if (next && e.currentTarget.contains(next)) return;
    setFocused(false);
  }, []);

  const cardHeight = cardHeightFor(group.tabs.length, headerHeight, rowStride, collapsed);

  return (
    <div
      ref={node => {
        ref.current = node;
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={handleBlur}
      /* `min-w-0`（= min-width: 0）：这张卡现在**直接**是 CSS grid 的子项
       * （双栏布局改成行主序，见 TabList.tsx 的 R-11 注释）⇒ grid item 的
       * 默认 `min-width: auto` 会按内容撑开，长标题/长网址会把卡片顶出格子。
       * 旧的「两列各一个 div」布局里这个 `min-width: 0` 长在列容器上，
       * 改行主序后必须跟着搬到这里 —— 否则双栏会横向溢出。
       *
       * ⚠️ 2026-10-24 审计 PERF-03：`content-visibility: auto` 与
       * `contain-intrinsic-size` **被摘掉了**。它们是「卡片全量挂载」时代
       * 的省力装置（让浏览器跳过离屏卡的布局），但现在离屏卡**根本不挂载**，
       * 而 `contain-intrinsic-size: 320px` 会在浏览器跳过布局时**改写**那张卡
       * 占住的高度 ⇒ 文档总高与真实内容对不上 ⇒ 滚动条漂移。
       * （`content-visibility` 还会把卡内浮层裁掉，见 TabGroup.tsx 的
       * 「更多」菜单注释 —— 那个坑是靠 portal 绕开的，别再把它请回来。） */
      className="transition-material min-w-0"
    >
      {showCard ? (
        <TabGroup
          group={group}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
        />
      ) : (
        <div
          className="tab-group-card"
          style={{ height: cardHeight }}
          aria-hidden="true"
          data-card-skeleton="true"
        />
      )}
    </div>
  );
};
