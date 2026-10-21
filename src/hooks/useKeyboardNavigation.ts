import { useEffect, useRef } from 'react';
import { consumeFocusReturn } from '@/utils/focusReturn';

/**
 * 对话框内可聚焦元素的查询选择器。
 * 刻意排除 tabindex="-1"：那是给程序化聚焦用的锚点（对话框容器本身），
 * 不该出现在 Tab 序列里。
 */
export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Tab 键在焦点陷阱里的落点决策（纯函数，不碰 DOM）。
 *
 * 根因：旧实现只在「当前焦点恰好等于首/尾元素」时 preventDefault，
 * 焦点一旦落在容器之外（打开瞬间停在触发按钮上、或掉回 body），
 * Tab 就会穿透到被遮挡的背景页面 —— 对话框挡不住键盘。
 */
export type TabTargetDecision =
  | { kind: 'none' }
  | { kind: 'native' }
  | { kind: 'focus'; index: number };

export function resolveTabTarget(
  focusableCount: number,
  activeIndex: number,
  shiftKey: boolean
): TabTargetDecision {
  if (focusableCount <= 0) {
    return { kind: 'none' };
  }

  const lastIndex = focusableCount - 1;

  if (activeIndex < 0 || activeIndex >= focusableCount) {
    // 焦点根本不在对话框里：必须主动把它拉进来，否则会逃逸到背景页。
    return { kind: 'focus', index: shiftKey ? lastIndex : 0 };
  }

  if (shiftKey && activeIndex === 0) {
    return { kind: 'focus', index: lastIndex };
  }

  if (!shiftKey && activeIndex === lastIndex) {
    return { kind: 'focus', index: 0 };
  }

  return { kind: 'native' };
}

/**
 * 还焦落点的决策（纯函数，不碰 DOM 之外的东西）。
 *
 * ── 为什么要降级 ─────────────────────────────────────────────────────────
 * 旧实现的判据是 `restoreTo === document.body || !restoreTo.isConnected` ⇒ **不还焦**。
 * 理由本身没错（把焦点还给一个已经消失的元素 = 焦点掉到 body，用户更迷路），
 * 但它漏了真实发生的那一类：
 *
 * 确认框由 ToastContext **全局渲染**，打开时 `document.activeElement` 是触发它的
 * 菜单项按钮；而菜单项会在 `onClose()` 里被卸载 ⇒ 关闭确认框时那个按钮
 * `isConnected === false` ⇒ 拒绝还焦 ⇒ **焦点掉到 body**。
 *
 * 更糟的是**同一个弹层两条路径行为不一致**：
 *   · Esc 关闭 → 菜单还开着（Esc 路径不关菜单）⇒ 按钮还在 ⇒ 还焦成功；
 *   · 点「取消」→ 菜单已关 ⇒ 按钮已卸载 ⇒ 拒绝还焦 ⇒ 焦点掉到 body。
 * 同一个弹层、同一件事，取决于用户用哪个键 —— 这本身就是缺陷。
 *
 * 所以：**还焦失败时必须降级到一个仍然存在、且用户能看见的落点**，
 * 而不是把焦点丢给 body。降级顺序：
 *   1. 原触发元素（还在文档里）→ 还给它（标准行为）；
 *   2. 触发元素所在的**弹层触发点**（还在）→ 给它；
 *   3. 列表容器 `main`（带 `tabIndex={-1}`，是页面主内容区）→ 给它。
 *
 * 任何一步都不能返回 body：body 不是「落点」，它等于「键盘用户丢失了位置」。
 */
export interface FocusRestoreContext {
  /** 关闭弹层时想要还焦的元素（打开弹层时的 activeElement）。 */
  restoreTo: HTMLElement | null;
  /** 弹层的触发点（可选）。 */
  fallback?: HTMLElement | null;
  /** 页面主内容容器（带 tabIndex={-1}）。 */
  container?: HTMLElement | null;
}

/**
 * 一个元素能不能作为还焦落点。
 *
 * 三条判据：
 *   · 非空；
 *   · `isConnected` —— 还在文档里（已被卸载的元素聚焦了也等于没聚焦）；
 *   · 不是 `<body>` —— body 不是「落点」，它是「用户丢失了位置」。
 *
 * 判「是不是 body」用**标签名**而不是 `document.body`：
 * 本函数要能在**没有 DOM 的环境**下被单测（node:test 没有 jsdom），
 * 引用 `document` 会直接抛错。
 */
const isUsableRestoreTarget = (
  element: HTMLElement | null | undefined
): element is HTMLElement => {
  if (!element) return false;
  if (!element.isConnected) return false;
  return element.tagName?.toLowerCase() !== 'body';
};

/**
 * 还焦落点决策（纯函数，便于测试）。
 *
 * 按**顺序**在候选链里挑第一个可用的：
 *   1. 原触发元素（还在文档里）—— 标准行为；
 *   2. 降级落点（弹层触发点 / 登记的稳定落点）；
 *   3. 页面主容器 `main`（带 tabIndex={-1}）。
 *
 * @returns 要聚焦的元素；**null 表示无处可去**（调用方此时不应调用 focus，
 *   也不能把焦点塞给 body —— 保持现状总比丢到 body 好）。
 */
export function resolveFocusRestoreTarget({
  restoreTo,
  fallback,
  container,
}: FocusRestoreContext): HTMLElement | null {
  if (isUsableRestoreTarget(restoreTo)) return restoreTo;
  if (isUsableRestoreTarget(fallback)) return fallback;
  if (isUsableRestoreTarget(container)) return container;
  return null;
}

/**
 * 焦点管理Hook
 * 打开时把焦点移进容器、Tab/Shift+Tab 循环限制在容器内、关闭时把焦点还给触发元素。
 *
 * 约定：调用方必须在容器根节点上放 `tabIndex={-1}`，本 Hook 直接聚焦该容器
 * （读屏会连同 aria-labelledby 指向的标题一起播报对话框上下文）。
 *
 * @param containerRef 容器引用（元素需带 tabIndex={-1}）
 * @param enabled 是否启用（false 时执行还焦）
 * @param options.returnFocus 关闭后是否把焦点还给打开它的元素
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement>,
  enabled: boolean = true,
  options: {
    returnFocus?: boolean;
    /**
     * 还焦失败时的**降级落点**（可选）。
     * 典型场景：确认框由 ToastContext 全局渲染，打开时 activeElement 是
     * 菜单项按钮，而菜单项随后被卸载 ⇒ 原触发点已不在文档里。
     * 此时还焦到「弹层的触发点」或页面 `main`，而不是让焦点掉到 body。
     */
    restoreFallback?: () => HTMLElement | null;
  } = {}
) {
  const { returnFocus = false, restoreFallback } = options;
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const wasEnabledRef = useRef(false);
  const restoreFallbackRef = useRef(restoreFallback);

  useEffect(() => {
    restoreFallbackRef.current = restoreFallback;
  });

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    if (!wasEnabledRef.current) {
      wasEnabledRef.current = true;
      // 打开时的 activeElement 只作**第一候选**：它可能就是马上要被卸载的
      // 菜单项按钮。稳定落点由调用方显式登记（见 @/utils/focusReturn），
      // 或走 restoreFallback / main 降级链。
      restoreTargetRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
    }

    container.focus();

    return () => {
      const restoreTo = restoreTargetRef.current;
      wasEnabledRef.current = false;
      restoreTargetRef.current = null;

      if (!returnFocus) return;

      // 降级链见 resolveFocusRestoreTarget 的说明：
      //   1. **登记的稳定落点**（优先）—— 菜单的触发按钮 / 卡片的 summary。
      //      优先于「原触发元素」是**为了让 Esc 与「取消」两条路径一致**：
      //      若原触发元素优先，Esc 会还到「菜单项按钮」、点「取消」会还到
      //      「触发按钮」—— 同一个弹层两个落点，仍是不一致。
      //   2. 原触发元素（还在文档里）—— 标准行为。
      //   3. 页面 main（带 tabIndex={-1}）。
      // **绝不让焦点掉到 body**。
      const main = document.querySelector<HTMLElement>('main[tabindex="-1"]');
      const registered = consumeFocusReturn();
      const target = resolveFocusRestoreTarget({
        restoreTo: registered.target ?? restoreTo,
        fallback: restoreFallbackRef.current?.() ?? restoreTo ?? main,
        container: main,
      });
      if (!target) return;
      target.focus();
    };
  }, [containerRef, enabled, returnFocus]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;

      const focusableElements = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      );
      const active = document.activeElement as HTMLElement | null;
      const activeIndex = active ? focusableElements.indexOf(active) : -1;
      const decision = resolveTabTarget(
        focusableElements.length,
        activeIndex,
        event.shiftKey
      );

      if (decision.kind === 'focus') {
        event.preventDefault();
        focusableElements[decision.index].focus();
      }
    };

    // 挂在 document 而非容器上：焦点一旦逃到容器外，容器上的监听器就再也收不到
    // keydown，只有 document 级的监听才能把焦点重新拉回对话框。
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, enabled]);
}

/**
 * 对话框的键盘与焦点契约：打开移焦 → Tab 循环 → Escape 关闭 → 关闭还焦。
 * 只管键盘/焦点，role="dialog" / aria-modal / aria-labelledby 由调用方写在 JSX 上。
 *
 * Escape 必须在 window 捕获阶段拦截：对话框可能被挂在别处的菜单/弹层里，
 * 那些容器上的冒泡监听器比它先注册（document 上更早），冒泡阶段的
 * stopPropagation 已经来不及，只能在事件到达 document 之前吞掉。
 *
 * @param containerRef 对话框根节点引用（元素需带 tabIndex={-1}）
 * @param open 对话框是否打开
 * @param onEscape 按下 Escape 时调用（通常是关闭动作）；不传则不接管 Escape
 */
export function useDialogA11y(
  containerRef: React.RefObject<HTMLElement>,
  open: boolean,
  onEscape?: () => void
) {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useFocusTrap(containerRef, open, { returnFocus: true });

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !onEscapeRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onEscapeRef.current();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);
}
