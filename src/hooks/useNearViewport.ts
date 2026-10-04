/**
 * 「是否接近视口」观测钩子（列表懒渲染用）。
 *
 * 【为什么需要它】会话列表在数据量大时会一次性渲染全部标签行：400 会话 × 20 标签
 * = 8000 行 ≈ 10 万个 DOM 元素。实测（真机基准，见交付说明）点击「清理重复标签」
 * 时，删除 100 个会话会让 popup 主线程连续阻塞约 1 秒——V8 profile 显示开销集中在
 * React 提交阶段的 removeChild（454ms）+ 浏览器逐节点拆除（节点级删除 8 万个纯 DOM
 * 只要 25ms，说明贵在「React 逐个 removeChild 调用几千次」，不在删除本身）。
 * 结论：必须让**同一时刻存在于 DOM 里的标签行数**与视口相关，而不是与数据总量相关。
 *
 * 【为什么是「接近视口」而不是「曾经进入过视口」】若一旦可见就永久渲染，用户滚到底
 * 之后所有行又都回到 DOM 里，问题原样复现——而清理按钮恰恰是滚到哪都可能点的。
 * 所以这里返回的是**当前**是否接近视口（离开即撤销），配合精确的占位高度保证
 * 文档总高不变、滚动不跳。
 *
 * 【为什么不用 root: null 了事】root 为 null 时按「文档视口」判定，只在页面本身
 * 滚动时正确。若列表实际由某个内层容器滚动，null 会把**所有**卡片都判成可见，
 * 懒渲染静默失效（退化成现在的全量渲染），且不会有任何报错——是那种「改完看起来
 * 没效果」的隐性失败。所以这里向上探测真正的滚动容器（overflow 且确实可滚），
 * 探不到才退回文档视口。
 *
 * 【观测器共享】全部卡片共用一个 IntersectionObserver（root 相同），避免几百个
 * 观测器实例。回调按元素查表分发。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

type VisibilityCallback = (visible: boolean) => void;

/** 观测中元素 → 回调。用 Map 而非 WeakMap：需要在共享回调里 enumerate 到它。 */
const callbacks = new Map<Element, VisibilityCallback>();
let observer: IntersectionObserver | null = null;
let observedRoot: Element | null = null;

/**
 * 提前量（px）：与 IntersectionObserver 的 rootMargin 保持一致。
 * 600px ≈ 15 行 × 44px，滚动时内容已经就位，不会出现「滚到了还是空白」。
 */
const NEAR_MARGIN_PX = 600;

/**
 * 向上找到真正的滚动容器。返回 null 表示「文档视口」（页面自身滚动）。
 *
 * 判据是 `overflow-y` 允许滚动**且**当前确实可滚（scrollHeight > clientHeight）：
 * 只看 overflow 会把大量 `overflow-y: auto` 但其实不滚动的容器误判成滚动根，
 * 那样卡片会被判成永远不可见、列表整块空掉——比不优化严重得多。
 */
export function findScrollRoot(start: Element | null): Element | null {
  if (typeof window === 'undefined') return null;
  let cur: Element | null = start?.parentElement ?? null;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const style = window.getComputedStyle(cur);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrollable && cur.scrollHeight > cur.clientHeight + 1) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function ensureObserver(root: Element | null): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (observer && observedRoot === root) return observer;
  // root 变了（极少见：容器被换掉）→ 重建，旧实例必须先断开并清表，
  // 否则旧回调会继续按新表分发到已失效的元素上。
  if (observer) {
    observer.disconnect();
    callbacks.clear();
  }
  observedRoot = root;
  observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        callbacks.get(entry.target)?.(entry.isIntersecting);
      }
    },
    {
      root,
      // 提前一屏左右开始渲染：滚动时内容已经就位，不会出现「滚到了还是空白」。
      rootMargin: `${NEAR_MARGIN_PX}px 0px`,
    }
  );
  return observer;
}

/**
 * 同步（提交阶段、绘制之前）判断元素是否接近视口。
 *
 * 【为什么必须有这一步，而不能只靠 IntersectionObserver】
 * IO 的回调最早也要等到下一个任务，于是「初次挂载」到「回调到达」之间必然存在
 * 至少一帧：那一帧会被判成「不接近视口」→ 渲染占位。若这张卡本就在首屏，
 * 代价不是「慢一点」，而是**首屏先闪一下空白占位、下一帧才长出标签行**——
 * 对一个本来就不大的列表（所有卡都在首屏）来说，这属于纯粹的体验倒退。
 * 这里用 useLayoutEffect 在浏览器绘制前同步量一次，首帧就是正确的：
 * 首屏的卡直接渲染真实行，根本没有占位那一帧。
 *
 * 单次测量是 O(1)（getBoundingClientRect），几百张卡也只有几百次布局读数，
 * 而且发生在同一次布局里（无读写交错），不会造成布局抖动。
 */
function measureNear(el: Element, root: Element | null): boolean {
  const rect = el.getBoundingClientRect();
  const top = root ? root.getBoundingClientRect().top : 0;
  const height = root ? root.clientHeight : window.innerHeight || 0;
  return rect.bottom >= top - NEAR_MARGIN_PX && rect.top <= top + height + NEAR_MARGIN_PX;
}

/**
 * @param margin 预留参数（当前用固定 rootMargin；留作将来按布局调整）
 * @returns [ref, isNearViewport]：把 ref 挂到容器元素上
 */
export function useNearViewport<T extends Element>(
  enabled = true
): [MutableRefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // 初始为 false：首帧不渲染重内容，等下面的 useLayoutEffect 在**绘制之前**纠正。
  // 若环境不支持 IntersectionObserver，必须**默认渲染**，否则列表会永久空白——
  // 降级方向只能是「退化成全量渲染」，绝不能是「不渲染」。
  const [isNear, setIsNear] = useState(() => typeof IntersectionObserver === 'undefined');

  // 绘制前同步量一次（见 measureNear 的说明：避免首屏闪一帧占位）。
  // 用 useLayoutEffect 而不是 useEffect，正是为了赶在浏览器绘制之前。
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIsNear(true);
      return;
    }
    setIsNear(measureNear(el, findScrollRoot(el)));
    // 只在启用状态变化时重算：尺寸/滚动引起的后续变化交给 IO 回调，
    // 这里若依赖布局，会在每次渲染后再量一次，反而把布局读放大。
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const obs = ensureObserver(findScrollRoot(el));
    if (!obs) {
      setIsNear(true);
      return;
    }
    callbacks.set(el, setIsNear);
    obs.observe(el);
    return () => {
      callbacks.delete(el);
      obs.unobserve(el);
    };
  }, [enabled]);

  return [ref, isNear];
}
