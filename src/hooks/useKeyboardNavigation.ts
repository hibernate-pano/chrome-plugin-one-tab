import { useEffect, useCallback, useRef } from 'react';

interface KeyboardNavigationOptions {
  onEnter?: () => void;
  onEscape?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onArrowLeft?: () => void;
  onArrowRight?: () => void;
  onTab?: () => void;
  onShiftTab?: () => void;
  enabled?: boolean;
}

/**
 * 键盘导航Hook
 * 提供统一的键盘事件处理
 * @param options 键盘事件处理选项
 * @param deps 依赖数组
 */
export function useKeyboardNavigation(
  options: KeyboardNavigationOptions,
  deps: React.DependencyList = []
) {
  const {
    onEnter,
    onEscape,
    onArrowUp,
    onArrowDown,
    onArrowLeft,
    onArrowRight,
    onTab,
    onShiftTab,
    enabled = true
  } = options;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      switch (event.key) {
        case 'Enter':
          if (onEnter) {
            event.preventDefault();
            onEnter();
          }
          break;
        case 'Escape':
          if (onEscape) {
            event.preventDefault();
            onEscape();
          }
          break;
        case 'ArrowUp':
          if (onArrowUp) {
            event.preventDefault();
            onArrowUp();
          }
          break;
        case 'ArrowDown':
          if (onArrowDown) {
            event.preventDefault();
            onArrowDown();
          }
          break;
        case 'ArrowLeft':
          if (onArrowLeft) {
            event.preventDefault();
            onArrowLeft();
          }
          break;
        case 'ArrowRight':
          if (onArrowRight) {
            event.preventDefault();
            onArrowRight();
          }
          break;
        case 'Tab':
          if (event.shiftKey && onShiftTab) {
            event.preventDefault();
            onShiftTab();
          } else if (!event.shiftKey && onTab) {
            event.preventDefault();
            onTab();
          }
          break;
      }
    },
    [
      enabled,
      onEnter,
      onEscape,
      onArrowUp,
      onArrowDown,
      onArrowLeft,
      onArrowRight,
      onTab,
      onShiftTab,
      ...deps
    ]
  );

  useEffect(() => {
    if (enabled) {
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [handleKeyDown, enabled]);
}

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
  options: { returnFocus?: boolean } = {}
) {
  const { returnFocus = false } = options;
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const wasEnabledRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    if (!wasEnabledRef.current) {
      wasEnabledRef.current = true;
      restoreTargetRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
    }

    container.focus();

    return () => {
      const restoreTo = restoreTargetRef.current;
      wasEnabledRef.current = false;
      restoreTargetRef.current = null;

      if (!returnFocus || !restoreTo) return;
      // 触发器已经不在文档里（或本来就是 body）就别还焦，
      // 否则会把焦点丢到一个用户看不见的地方，比不还更糟。
      if (restoreTo === document.body || !restoreTo.isConnected) return;
      restoreTo.focus();
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
 * Escape 必须在 window 捕获阶段拦截：Header 的 useKeyboardShortcuts 注册了无修饰键的
 * CLEAR_SEARCH: Escape（document 冒泡监听器，且比弹窗先注册 → 必然先触发），
 * 冒泡阶段的 stopPropagation 已经来不及，只能在事件到达 document 之前吞掉。
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

/**
 * 跳过链接Hook
 * 为屏幕阅读器用户提供跳过导航的功能
 */
export function useSkipLink() {
  const skipLinkRef = useRef<HTMLAnchorElement>(null);

  const showSkipLink = useCallback(() => {
    if (skipLinkRef.current) {
      skipLinkRef.current.style.transform = 'translateY(0)';
      skipLinkRef.current.focus();
    }
  }, []);

  const hideSkipLink = useCallback(() => {
    if (skipLinkRef.current) {
      skipLinkRef.current.style.transform = 'translateY(-100%)';
    }
  }, []);

  return {
    skipLinkRef,
    showSkipLink,
    hideSkipLink
  };
}
