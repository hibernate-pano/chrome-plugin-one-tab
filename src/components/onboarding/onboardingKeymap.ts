/**
 * 引导弹层的键盘决策（纯函数，可单测）。
 *
 * 背景：OnboardingGuide 此前在 window 上挂 keydown，Enter/ArrowRight 一律走"下一步"，
 * 且既不看 event.target 也不 preventDefault。在「下一步」按钮上按 Enter 时，
 * 按钮自身的 onClick 走一步 + window 处理器再走一步 = 一步跳过两步；
 * 在「跳过」上按 Enter 则是"跳过 + 前进"同时发生。aria-modal="true" 是假的：
 * 打开不移焦、不困 Tab、关闭不还焦。
 *
 * 这里的规则：事件来自可交互控件时**不接管**（让它走控件自己的行为），
 * 只有落在弹层自身/遮罩上的按键才驱动步骤机。
 */

export type OnboardingAction = 'next' | 'prev' | 'complete' | 'skip';

/** 弹层内可聚焦元素的查询选择器（Tab 循环时枚举焦点用）。 */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface OnboardingKeyContext {
  isFirstStep: boolean;
  isLastStep: boolean;
}

export interface OnboardingKeyEventLike {
  key: string;
  target: unknown;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], [contenteditable="true"]';

const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'BUTTON',
  'A',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'DETAILS',
  'LABEL',
  'OPTION',
]);

/** 事件是否来自可交互控件（按钮/链接/输入框/可编辑区）。 */
export function isFromInteractiveElement(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  if (element.isContentEditable) return true;
  if (typeof element.closest === 'function') {
    return element.closest(INTERACTIVE_SELECTOR) != null;
  }
  // 无 closest（测试替身/非 DOM 目标）时退回 tagName 判断
  return INTERACTIVE_TAGS.has((element.tagName || '').toUpperCase());
}

/**
 * 这些键被目标控件**消费**（会触发它的 click），因此事件来自控件时不能接管，
 * 否则一次按键会被算两遍（双触发根因）。
 *
 * Escape / ArrowLeft / ArrowRight 不在此列：弹层里没有任何控件给它们默认行为，
 * 屏蔽它们等于「焦点在按钮上时 Escape 关不掉弹层」「焦点在圆点上时方向键失灵」。
 */
const CONTROL_ACTIVATION_KEYS: ReadonlySet<string> = new Set(['Enter', ' ']);

/**
 * 该按键对引导流程意味着什么。返回 null = 不接管这个事件。
 *
 * 判定顺序（任一命中即返回 null）：
 * 1. 已被别人 preventDefault（避免与上层弹层/快捷键抢事件）
 * 2. 带 Ctrl/Meta/Alt（浏览器快捷键组合，如 Cmd+R 不该被吞）
 * 3. 是控件的激活键（Enter/Space）且事件来自控件本身
 */
export function resolveOnboardingAction(
  event: OnboardingKeyEventLike,
  context: OnboardingKeyContext
): OnboardingAction | null {
  if (event.defaultPrevented) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (CONTROL_ACTIVATION_KEYS.has(event.key) && isFromInteractiveElement(event.target)) return null;

  switch (event.key) {
    case 'ArrowRight':
    case 'Enter':
      return context.isLastStep ? 'complete' : 'next';
    case 'ArrowLeft':
      // 首步没有"上一步"，不消费按键
      return context.isFirstStep ? null : 'prev';
    case 'Escape':
      return 'skip';
    default:
      return null;
  }
}

/**
 * 弹层内 Tab 循环：焦点该被强制送到首/尾可聚焦元素吗？
 *
 * aria-modal="true" 的前提是焦点出不去。此前的引导弹层从不拦 Tab，
 * 焦点可以直接走到遮罩后面的主界面（读屏用户以为弹层没了）。
 * 只有走到两端时才需要接管，中间位置一律放行给浏览器原生 Tab。
 *
 * @param activeIndex    焦点所在可聚焦元素下标；-1 = 焦点不在弹层内
 * @param focusableCount 弹层内可聚焦元素数量
 * @returns 'first' | 'last' | null（null = 不接管）
 */
export function resolveTabCycleTarget(
  activeIndex: number,
  focusableCount: number,
  shiftKey: boolean
): 'first' | 'last' | null {
  if (focusableCount === 0) return null;
  // 焦点不在弹层内（如刚从背景抢过来）：正向 Tab 送进第一个，反向送进最后一个
  if (activeIndex < 0) return shiftKey ? 'last' : 'first';
  if (!shiftKey && activeIndex === focusableCount - 1) return 'first';
  if (shiftKey && activeIndex === 0) return 'last';
  return null;
}

