import React, { useState, useRef, useEffect } from 'react';

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
        return 'bottom-full right-0 mb-3';
      case 'bottom':
        return 'top-full right-0 mt-3';
      case 'left':
        return 'right-full top-1/2 transform -translate-y-1/2 mr-3';
      case 'right':
        return 'left-full top-1/2 transform -translate-y-1/2 ml-3';
      default:
        return 'bottom-full right-0 mb-3';
    }
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
          // 顶栏「保存」按钮的提示语有 20 个字，在 400px 的 popup 里
          // tooltip 宽 313px、以按钮为锚点居中 ⇒ 右半截（right=466）
          // 跑到视口外，并把 document.scrollWidth 从 400 撑到 466。
          //
          // 修法：① 允许换行；② 宽度上限跟着视口走；③ 超出时改为靠边对齐
          // （right-0 而不是居中），保证它始终完整落在视口内。
          className={`absolute z-50 max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words px-3 py-2 text-sm text-white bg-gray-900 dark:bg-gray-800 rounded-lg shadow-xl backdrop-blur-sm border border-gray-700 dark:border-gray-600 pointer-events-none ${getPositionClasses()} animate-fadeIn`}
          role="tooltip"
        >
          {content}
          <div
            className={`absolute w-0 h-0 border-4 border-transparent ${getArrowClasses()}`}
          />
        </div>
      )}
    </div>
  );
};

export default Tooltip;
