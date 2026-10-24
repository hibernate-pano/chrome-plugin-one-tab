/**
 * tooltip 的**避让判定口径**（单源，纯函数）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 *
 * 2026-10-20 真机实测：顶栏「保存并关闭」的 tooltip 从按钮**向下**弹出，
 * 而在 ≤1024px 的两行顶栏里，搜索框恰好就在操作区的**下一行**：
 *
 *   400px  视口 → tooltip [207.6, 56, 134.4, 118] 搜索框 [12, 54, 368, 34]
 *              → 重叠 4301px² = 搜索框面积的 **34.4%**
 *    700px 视口 → tooltip [506.7, 58, 121.3, 138] 搜索框 [90, 56, 512, 34]
 *              → 重叠 3051px² = **17.5%**
 *   1280px 视口 → 单行顶栏，tooltip 在搜索框右侧 → 重叠 **0**
 *
 * 也就是说：**单行顶栏没有这个问题，两行顶栏才有**。而两行顶栏正是
 * 「窄窗口 / 半屏分屏 / 平板竖屏」这些真实场景。
 *
 * ── 为什么不是「改成向上弹」 ────────────────────────────────────────────
 *
 * 因为顶栏是 `position: sticky; top: 0` —— 它**永远贴着视口上沿**。
 * 向上弹的 tooltip 会整体跑到视口外：实测 400px 下 tooltip 的 y 会变成
 * **-74**（118px 高 ⇒ 74px 在视口外、只剩 44px 可见），1280px 下是 **-92**。
 * 「不遮挡搜索框」是达到了，代价是提示语本身看不见了 —— 那不叫修好。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * tooltip 仍然贴着按钮，但**遇到要避让的元素就整体下移**，移到不压住为止：
 * 顶栏的 tooltip 会落到搜索框**下方**（覆盖会话列表的一小条），
 * 而不是压在搜索框上。搜索框是输入控件，被盖住 = 用户正在输入的东西消失；
 * 列表内容被临时盖住只是「少看一条」，性质完全不同。
 *
 * 判定逻辑必须纯函数化：几何计算不依赖 DOM，才能被 node:test 直接测。
 */

/** 提示条与被避让元素之间保留的空隙（px）。 */
export const TOOLTIP_AVOID_GAP = 8;

/**
 * 提示条与**触发元素**之间的间距（px）。
 *
 * 原先写死成 Tailwind 的 `mt-3` / `mb-3`（= 0.75rem = 12px）；
 * 改成常量是为了让「间距」和「避让位移」由同一个数字推导 —— 避让位移
 * 要和这个间距**相加**，两者各写各的迟早会漂。
 */
export const TOOLTIP_SIDE_GAP = 12;

export interface TooltipBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipAvoidInput {
  /** 提示条当前（未修正）的位置 */
  tooltip: TooltipBox;
  /** 需要避让的元素（如搜索框） */
  avoid: TooltipBox[];
  /** 提示条当前贴哪一侧 */
  side: TooltipSide;
  /** 视口高度 */
  viewportHeight: number;
  /** 与避让元素之间的空隙，默认 {@link TOOLTIP_AVOID_GAP} */
  gap?: number;
}

export interface TooltipAvoidResult {
  /** 竖直位移（px，正 = 向下）。side 为 left/right 时恒为 0。 */
  offset: number;
  /** 位移之后是否已经**完全**避开（没压住任何一平方像素）。 */
  cleared: boolean;
}

/**
 * 提示条与视口左右边缘之间保留的空隙（px）。
 */
export const TOOLTIP_VIEWPORT_MARGIN = 8;

export interface TooltipClampInput {
  /** 提示条当前（未修正）的位置 */
  tooltip: TooltipBox;
  /** 视口宽度 */
  viewportWidth: number;
  /** 与视口边缘的空隙，默认 {@link TOOLTIP_VIEWPORT_MARGIN} */
  margin?: number;
}

export interface TooltipClampResult {
  /** 水平位移（px，正 = 向右）。0 = 不用动。 */
  shift: number;
  /** 位移之后能不能完整落在视口里（宽度本身太大时为 false）。 */
  fits: boolean;
}

/**
 * 把提示条**夹回视口内**（水平方向）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 提示条锚在触发元素的**右缘**（`right-0`）⇒ 它往**左**展开。
 * 宽度一旦改成「按内容自然宽度」（`w-max`，否则会被触发元素的 36px 宽度
 * 挤成「一个汉字一行」），靠左边的触发元素就会把提示条顶出视口左缘 ——
 * 那段提示语用户根本看不到，比挤成竖排更糟。
 *
 * ⇒ 规则很简单：**先保证完整可见**，宁可位置不再精确对准按钮。
 * 放不下（提示条本身就比视口还宽）⇒ 不乱挪，如实报告 `fits: false`。
 */
export function resolveTooltipClamp(input: TooltipClampInput): TooltipClampResult {
  const margin = input.margin ?? TOOLTIP_VIEWPORT_MARGIN;
  const { left, right } = input.tooltip;
  const width = right - left;
  const viewport = input.viewportWidth;

  // 宽度本身放不下 ⇒ 挪哪儿都露不全，别乱动（如实说放不下）。
  if (width + margin * 2 > viewport) {
    return { shift: 0, fits: false };
  }
  if (left < margin) {
    return { shift: margin - left, fits: true };
  }
  if (right > viewport - margin) {
    return { shift: viewport - margin - right, fits: true };
  }
  return { shift: 0, fits: true };
}

/** 两个矩形是否相交（面积 > 0）。 */
export function boxesOverlap(a: TooltipBox, b: TooltipBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function shiftBox(box: TooltipBox, offset: number): TooltipBox {
  return {
    top: box.top + offset,
    bottom: box.bottom + offset,
    left: box.left,
    right: box.right,
  };
}

/**
 * 算出提示条要下移多少才不压住任何被避让的元素。
 *
 * 规则：
 *  · 没压住任何东西 → 位移 0（绝大多数情况，包括 1280px 单行顶栏）。
 *  · 压住了 → 往下挪到那个元素的**下沿之外**（再加 gap），
 *    有多个被压住的就取最大的那个。
 *  · 往下挪完会掉出视口 → 退而求其次：至少把提示条留在视口内
 *    （此时 `cleared` 为 false，调用方据此知道「避让不完全」）。
 *
 * 多轮迭代（而不是一轮）：下移之后可能压到另一个原本不相交的元素，
 * 迭代到稳定为止，最多 3 轮（再多也不会更优，只是白跑）。
 */
export function resolveTooltipAvoid(input: TooltipAvoidInput): TooltipAvoidResult {
  const { tooltip, avoid, side, viewportHeight } = input;
  const gap = input.gap ?? TOOLTIP_AVOID_GAP;

  // 左右方向弹出时，提示条是水平方向展开的，竖直避让不适用。
  if (side === 'left' || side === 'right') {
    return { offset: 0, cleared: !avoid.some(r => boxesOverlap(tooltip, r)) };
  }

  let offset = 0;
  for (let round = 0; round < 3; round++) {
    const current = shiftBox(tooltip, offset);
    let needed = 0;
    for (const r of avoid) {
      if (!boxesOverlap(current, r)) continue;
      // 下移到该元素下沿之外即可避开
      const d = r.bottom + gap - current.top;
      if (d > needed) needed = d;
    }
    if (needed <= 0) break;
    offset += needed;
  }

  // 夹到视口内：提示条不能为了避让而掉出屏幕（那等于把提示语弄没了）
  const room = Math.max(0, viewportHeight - tooltip.bottom);
  const finalOffset = Math.min(offset, room);
  const finalBox = shiftBox(tooltip, finalOffset);
  // 「避没避开」要按**最终位置**重新判定，不能拿位移量比大小 ——
  // 夹到视口边界时，位移量虽然小于理论值，位置却可能刚好不压了。
  const cleared = !avoid.some(r => boxesOverlap(finalBox, r));
  return { offset: finalOffset, cleared };
}
