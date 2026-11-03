/**
 * 搜索结果卡片里的**命中标签行**懒渲染（2026-11-03）。
 *
 * ── 为什么搜索结果也要这一层 ──────────────────────────────────────────────
 *
 * 搜索这条路已有一道「条数上限」（`buildResultWindow`，见 searchWindowing.ts），
 * 但它按**标签条数**截断、按**整个会话组**保留：
 *
 *   · 200 条上限只约束「保留多少个会话组之前停」，不约束**单个组**的行数 ——
 *     一个会话里命中 800 条，那 800 行会一次全部进 DOM（数据相关，不是常数）；
 *   · 卡头数最多 200（每组至少命中 1 条才保留）⇒ 这一侧有界，不用再管。
 *
 * 所以这里只做一件事：**把「本组命中行」也接到和主列表同一个窗口化机制上**
 * （`useNearViewport` + `resolveRowWindow` + 运行时量出来的行距）。
 * 远端的组只留一个精确等高的占位 ⇒ 同时存在的标签行数由**视口**决定，
 * 而不是由「某个会话存了多少条」决定。
 *
 * ── 为什么不是「分片渲染」───────────────────────────────────────────────
 *
 * `searchWindowing.ts` 里曾有一组从未接线的分片函数
 * （`computeVisibleChunks` / `chunkResults` / `SEARCH_CHUNK_SIZE`）。
 * 2026-11-03 用 `scripts/prod-stress.mjs` 重新实测（400 会话 × 20 标签）：
 * 搜索态 DOM ≤ 3.9k 节点、滚动最大帧间隔 ≤ 15ms —— 条数上限已经把问题挡住了。
 * 再引入一套「按片判定」的窗口化理论，等于在生产里多一条**没有真实调用历史**
 * 的路径，且与已有机制互相冲突。⇒ 分片代码被删除，只保留这一套复用机制。
 *
 * ── 占位高度为什么必须是「行数 × 量出来的行距」──────────────────────────
 *
 * 与 `lazyTabRows.resolveRowWindow` / `cardMetrics.rowStrideFrom` 同一份理由：
 * 占位与真行必须逐像素一致，否则「原本在视口外」的组滚进视口时高度突变，
 * 滚动条会跳。搜索结果卡的行容差尤其不能再加一层间距 ——
 * 所以这里**不**给行之间加 `space-y-*`（主列表也没有）：行距只有一处来源。
 *
 * ⚠️ 失败方向只能是「退化成全量渲染」（没有 IntersectionObserver 时），
 * 不能是「不渲染」—— 见 useNearViewport 的降级约定。
 */
import React, { useSyncExternalStore } from 'react';
import { useNearViewport } from '@/hooks/useNearViewport';
import { resolveRowWindow } from '@/components/tabs/lazyTabRows';
import { getRowStride, subscribeRowStride } from '@/components/tabs/cardMetrics';

interface SearchMatchRowsProps {
  /** 本会话组内的命中行数。 */
  count: number;
  /** 外层容器的类名（卡内分隔线、上边距由调用方决定）。 */
  className?: string;
  /**
   * 构造命中行。
   *
   * 传**函数**而不是 children：远端组连 React 元素都不该构造 ——
   * 一个会话命中上千条时，构造一千棵元素树本身也是白花的提交开销。
   */
  renderMatches: () => React.ReactNode;
}

export const SearchMatchRows: React.FC<SearchMatchRowsProps> = ({
  count,
  className,
  renderMatches,
}) => {
  const [ref, isNearViewport] = useNearViewport<HTMLDivElement>();
  // SSR（本仓测试用 renderToStaticMarkup）必须给 getServerSnapshot。
  const rowStride = useSyncExternalStore(subscribeRowStride, getRowStride, getRowStride);
  const { renderRows, placeholderHeight } = resolveRowWindow(count, isNearViewport, rowStride);

  return (
    <div ref={ref} className={className} data-search-match-rows="true">
      {renderRows ? (
        renderMatches()
      ) : (
        /* 与主列表同一个占位约定（TabGroup 的行占位）：显式高度、非列表项角色。 */
        <div
          role="presentation"
          data-lazy-placeholder="true"
          style={{ height: placeholderHeight }}
        />
      )}
    </div>
  );
};

export default SearchMatchRows;
