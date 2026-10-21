import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { resolveTooltipAvoid, TOOLTIP_SIDE_GAP } from './tooltipPlacement';

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
}

/**
 * 工具提示组件
 * 提供悬停时显示提示信息
 */
export const Tooltip: React.FC<TooltipProps> = ({
  children,
  content,
  position = 'top',
  delay = 300,
  className = ''
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 避让位移（px，正 = 向下）。0 = 贴着按钮原位弹出。
  const [avoidOffset, setAvoidOffset] = useState(0);

  const showTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    const id = setTimeout(() => {
      setIsVisible(true);
    }, delay);
    setTimeoutId(id);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      setTimeoutId(null);
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);

  /**
   * ── 2026-10-20 几何修复：提示条不得压住要避让的元素 ──────────────────
   *
   * 顶栏是 sticky 的，永远贴着视口上沿 ⇒ 「向上弹」会把提示语整体推出
   * 视口（实测 400px 下 y = -74、1280px 下 y = -92），提示语等于消失。
   * 所以真正的修法是：提示条仍然向下弹，但**整体下移**到不压住
   * 搜索框为止（落到搜索框下方，覆盖的是会话列表的一小条）。
   *
   * 被避让的元素由 `data-tooltip-avoid` 声明 —— 顶栏的搜索框标上这个
   * 属性，所有顶栏提示条（保存、主题切换…）自动避开它，不必逐个传参。
   *
   * 用 useLayoutEffect：位移必须在**绘制前**算完，否则会闪一帧
   * 「压住搜索框」的旧位置。
   */
  useLayoutEffect(() => {
    if (!isVisible) {
      setAvoidOffset(0);
      return;
    }
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const avoid = Array.from(document.querySelectorAll<HTMLElement>('[data-tooltip-avoid]')).map(node => {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
    const result = resolveTooltipAvoid({
      side: position,
      tooltip: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      avoid,
      viewportHeight: window.innerHeight,
    });
    setAvoidOffset(result.offset);
  }, [isVisible, position, content]);

  /**
   * 提示条的定位。
   *
   * ── 2026-10-19 审计 V-7：居中锚点在窄屏会溢出 ────────────────────────
   * 顶栏最后一颗按钮（保存/菜单）靠近视口右缘，「以按钮为中心」的
   * 提示条有一半在视口外。修法是让提示条**靠右对齐**（right-0），
   * 这样它始终向左展开、完整落在视口内。
   *
   * 代价：箭头位置也要跟着改（否则箭头会指偏）。箭头用同一个 right 基准。
   *
   * 判据不是「按钮在哪」而是「提示条往哪边展开」：top/bottom 都在
   * 触发元素的**下方/上方**展开（与宽窄无关），左右则固定。
   */
  const getPositionClasses = () => {
    switch (position) {
      case 'top':
        return 'bottom-full right-0';
      case 'bottom':
        return 'top-full right-0';
      case 'left':
        return 'right-full top-1/2 transform -translate-y-1/2 mr-3';
      case 'right':
        return 'left-full top-1/2 transform -translate-y-1/2 ml-3';
      default:
        return 'bottom-full right-0';
    }
  };

  /**
   * 与触发元素的间距（px）。原先写死成 Tailwind 的 `mt-3` / `mb-3`（12px），
   * 现在改成内联样式 —— 因为避让位移要和这个间距**相加**，
   * 两者必须由同一个数字推导，否则改一个就会漂。
   */
  const getOffsetStyle = (): React.CSSProperties => {
    if (position === 'top') {
      // 向上弹：底边贴着触发元素顶边；下移 = 减小下边距。
      return { marginBottom: TOOLTIP_SIDE_GAP - avoidOffset };
    }
    if (position === 'bottom') {
      return { marginTop: TOOLTIP_SIDE_GAP + avoidOffset };
    }
    return {};
  };

  const getArrowClasses = () => {
    switch (position) {
      case 'top':
        return 'top-full right-4 border-t-gray-800';
      case 'bottom':
        return 'bottom-full right-4 border-b-gray-800';
      case 'left':
        return 'left-full top-1/2 transform -translate-y-1/2 border-l-gray-800';
      case 'right':
        return 'right-full top-1/2 transform -translate-y-1/2 border-r-gray-800';
      default:
        return 'top-full right-4 border-t-gray-800';
    }
  };

  return (
    <div
      className={`relative inline-block ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {isVisible && (
        <div
          ref={tooltipRef}
          // ── 2026-10-19 审计 V-7：tooltip 不得撑破视口 ──────────────────
          // 修复前是 `max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words` + `left-1/2 -translate-x-1/2`：
          // 顶栏「保存」按钮的提示语有 20 个字，在 400px 宽的窗口里
          // tooltip 宽 313px、以按钮为锚点居中 ⇒ 右半截（right=466）
          // 跑到视口外，并把 document.scrollWidth 从 400 撑到 466。
          //
          // 修法：① 允许换行；② 宽度上限跟着视口走；③ 超出时改为靠边对齐
          // （right-0 而不是居中），保证它始终完整落在视口内。
          className={`absolute z-50 max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words px-3 py-2 text-sm text-white bg-gray-900 dark:bg-gray-800 rounded-lg shadow-xl backdrop-blur-sm border border-gray-700 dark:border-gray-600 pointer-events-none ${getPositionClasses()} animate-fadeIn`}
          style={getOffsetStyle()}
          role="tooltip"
        >
          {content}
          {/* 被下移避让时，箭头已经不再指向触发元素 —— 留着会指向
              搜索框，比没有箭头更误导，索性不画。 */}
          {avoidOffset === 0 && (
            <div
              className={`absolute w-0 h-0 border-4 border-transparent ${getArrowClasses()}`}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default Tooltip;
