import React, { useState, useRef, useEffect, useLayoutEffect, useId } from 'react';
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
  // ── 2026-10-23 审计 V-15：提示条必须被读屏引用到 ──────────────────────
  // 原先提示条有 role="tooltip" 却**没有 id**，也没有任何元素用
  // aria-describedby 指向它 ⇒ 多数读屏根本不会播报这段说明。
  // 而这段说明不是装饰：锁定按钮的提示是「会话未锁定 · 点此锁定（锁定后
  // 不会被「清理重复标签」清理，也不能重命名或逐条删除）」——
  // 这是第 42 轮 U-11 定案「tooltip 必须同时说明当前状态和点了会发生什么」
  // 的那一半，键盘/读屏用户却拿不到。
  //
  // useId() 生成的 id 在组件生命周期内稳定 ⇒ 可以直接挂到包装层上。
  const tooltipId = useId();

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
        return 'top-full right-4';
      case 'bottom':
        return 'bottom-full right-4';
      case 'left':
        return 'left-full top-1/2 transform -translate-y-1/2';
      case 'right':
        return 'right-full top-1/2 transform -translate-y-1/2';
      default:
        return 'top-full right-4';
    }
  };

  /**
   * 箭头的颜色必须与提示条**同底**（V-10）。
   *
   * 原先箭头写死 `border-t-gray-800`（#1f2937），提示条写死 `bg-gray-900`
   * （#111827）—— 两种冷灰。改成主题底色后，箭头若还留冷灰，就变成
   * 「暖纸底上的一个深灰三角」，比没有箭头更扎眼。
   * 用内联样式读同一个令牌 ⇒ 条与箭头不可能漂移。
   */
  const getArrowStyle = (): React.CSSProperties => {
    const color = 'var(--color-bg-elevated)';
    switch (position) {
      case 'bottom':
        return { borderBottomColor: color };
      case 'left':
        return { borderLeftColor: color };
      case 'right':
        return { borderRightColor: color };
      default:
        return { borderTopColor: color };
    }
  };

  /**
   * 把 `aria-describedby` 挂到**触发元素**上（V-15）。
   *
   * 为什么不是挂在包装层 `<div>` 上：包装层通常不可聚焦，读屏根本不会
   * 读它的描述 ⇒ 挂了等于没挂。必须挂到真正能获得焦点的那个元素
   * （`<button>` 或 `role="button"` 的 `<h3>`）上。
   *
   * ⚠️ 子元素**可能已经**有 `aria-describedby`（TabGroup 的会话标题就
   * 指向一条 sr-only 说明）⇒ 这里**合并**而不是覆盖（空格分隔两个 id），
   * 否则那条已有说明会被吃掉。
   */
  const trigger = React.isValidElement(children)
    ? React.cloneElement(
        children as React.ReactElement<{ 'aria-describedby'?: string }>,
        {
          'aria-describedby':
            [
              (children as React.ReactElement<{ 'aria-describedby'?: string }>).props[
                'aria-describedby'
              ],
              isVisible ? tooltipId : undefined,
            ]
              .filter(Boolean)
              .join(' ') || undefined,
        },
      )
    : children;

  return (
    <div
      className={`relative inline-block ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {trigger}
      {isVisible && (
        <div
          ref={tooltipRef}
          id={tooltipId}
          // ── 2026-10-19 审计 V-7：tooltip 不得撑破视口 ──────────────────
          // 修复前是 `max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words` + `left-1/2 -translate-x-1/2`：
          // 顶栏「保存」按钮的提示语有 20 个字，在 400px 宽的窗口里
          // tooltip 宽 313px、以按钮为锚点居中 ⇒ 右半截（right=466）
          // 跑到视口外，并把 document.scrollWidth 从 400 撑到 466。
          //
          // 修法：① 允许换行；② 宽度上限跟着视口走；③ 超出时改为靠边对齐
          // （right-0 而不是居中），保证它始终完整落在视口内。
          //
          // ── 2026-10-23 审计 V-10：配色交给 `.tooltip` 规则（主题令牌）──
          // 原先是 `text-white bg-gray-900 dark:bg-gray-800 border-gray-700
          // dark:border-gray-600` ⇒ 12 组主题 × 明暗实测**没有一组**跟主题走
          // （claude 暖纸主题里弹出一张冷灰卡片）。
          // 现在只留布局类，配色由 global.css 的 `.tooltip` 规则给。
          className={`tooltip absolute z-50 max-w-[min(20rem,calc(100vw-1.5rem))] whitespace-normal break-words px-3 py-2 text-sm rounded-lg backdrop-blur-sm border pointer-events-none ${getPositionClasses()} animate-fadeIn`}
          style={getOffsetStyle()}
          role="tooltip"
        >
          {content}
          {/* 被下移避让时，箭头已经不再指向触发元素 —— 留着会指向
              搜索框，比没有箭头更误导，索性不画。 */}
          {avoidOffset === 0 && (
            <div
              className={`absolute w-0 h-0 border-4 border-transparent ${getArrowClasses()}`}
              style={getArrowStyle()}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default Tooltip;
