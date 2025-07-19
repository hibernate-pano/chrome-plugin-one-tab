/**
 * 悬停状态管理Hook
 * 提供统一的悬停状态检测和管理
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface HoverOptions {
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  delay?: number;
  disabled?: boolean;
}

export interface HoverState {
  isHovered: boolean;
  isHovering: boolean; // 延迟后的悬停状态
}

export interface HoverHandlers {
  onMouseEnter: (event: React.MouseEvent) => void;
  onMouseLeave: (event: React.MouseEvent) => void;
  onFocus: (event: React.FocusEvent) => void;
  onBlur: (event: React.FocusEvent) => void;
}

/**
 * 基础悬停Hook
 */
export function useHover(options: HoverOptions = {}) {
  const { onHoverStart, onHoverEnd, delay = 0, disabled = false } = options;
  
  const [state, setState] = useState<HoverState>({
    isHovered: false,
    isHovering: false,
  });

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback((event: React.MouseEvent) => {
    if (disabled) return;

    setState(prev => ({ ...prev, isHovered: true }));

    if (delay > 0) {
      timeoutRef.current = setTimeout(() => {
        setState(prev => ({ ...prev, isHovering: true }));
        onHoverStart?.();
      }, delay);
    } else {
      setState(prev => ({ ...prev, isHovering: true }));
      onHoverStart?.();
    }
  }, [disabled, delay, onHoverStart]);

  const handleMouseLeave = useCallback((event: React.MouseEvent) => {
    if (disabled) return;

    clearTimeout();
    setState({ isHovered: false, isHovering: false });
    onHoverEnd?.();
  }, [disabled, clearTimeout, onHoverEnd]);

  const handleFocus = useCallback((event: React.FocusEvent) => {
    if (disabled) return;
    handleMouseEnter(event as any);
  }, [disabled, handleMouseEnter]);

  const handleBlur = useCallback((event: React.FocusEvent) => {
    if (disabled) return;
    handleMouseLeave(event as any);
  }, [disabled, handleMouseLeave]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handlers: HoverHandlers = {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
  };

  return {
    ...state,
    handlers,
    // 工具方法
    reset: useCallback(() => {
      clearTimeout();
      setState({ isHovered: false, isHovering: false });
    }, [clearTimeout]),
  };
}

/**
 * 带有位置跟踪的悬停Hook
 */
export function useHoverWithPosition(options: HoverOptions = {}) {
  const hover = useHover(options);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    setPosition({ x: event.clientX, y: event.clientY });
  }, []);

  return {
    ...hover,
    position,
    handlers: {
      ...hover.handlers,
      onMouseMove: handleMouseMove,
    },
  };
}

/**
 * 悬停区域Hook
 * 用于检测鼠标是否在特定区域内
 */
export function useHoverArea(options: HoverOptions & { threshold?: number } = {}) {
  const { threshold = 10, ...hoverOptions } = options;
  const hover = useHover(hoverOptions);
  const elementRef = useRef<HTMLElement | null>(null);

  const isInArea = useCallback((event: React.MouseEvent) => {
    if (!elementRef.current) return false;

    const rect = elementRef.current.getBoundingClientRect();
    const { clientX, clientY } = event;

    return (
      clientX >= rect.left - threshold &&
      clientX <= rect.right + threshold &&
      clientY >= rect.top - threshold &&
      clientY <= rect.bottom + threshold
    );
  }, [threshold]);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!isInArea(event) && hover.isHovered) {
      hover.handlers.onMouseLeave(event);
    }
  }, [isInArea, hover]);

  return {
    ...hover,
    elementRef,
    isInArea,
    handlers: {
      ...hover.handlers,
      onMouseMove: handleMouseMove,
    },
  };
}

/**
 * 组合多个元素的悬停状态
 */
export function useGroupHover(count: number, options: HoverOptions = {}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hovers = Array.from({ length: count }, (_, index) =>
    useHover({
      ...options,
      onHoverStart: () => {
        setHoveredIndex(index);
        options.onHoverStart?.();
      },
      onHoverEnd: () => {
        setHoveredIndex(null);
        options.onHoverEnd?.();
      },
    })
  );

  return {
    hoveredIndex,
    hovers,
    isAnyHovered: hoveredIndex !== null,
    getHandlers: (index: number) => hovers[index]?.handlers || {},
    getState: (index: number) => ({
      isHovered: hovers[index]?.isHovered || false,
      isHovering: hovers[index]?.isHovering || false,
    }),
  };
}

/**
 * 悬停延迟Hook
 * 用于实现悬停延迟效果，如工具提示
 */
export function useHoverDelay(
  showDelay: number = 500,
  hideDelay: number = 100,
  options: Omit<HoverOptions, 'delay'> = {}
) {
  const [isVisible, setIsVisible] = useState(false);
  const showTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimeouts = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimeouts();
    showTimeoutRef.current = setTimeout(() => {
      setIsVisible(true);
      options.onHoverStart?.();
    }, showDelay);
  }, [showDelay, options.onHoverStart, clearTimeouts]);

  const hide = useCallback(() => {
    clearTimeouts();
    hideTimeoutRef.current = setTimeout(() => {
      setIsVisible(false);
      options.onHoverEnd?.();
    }, hideDelay);
  }, [hideDelay, options.onHoverEnd, clearTimeouts]);

  const hover = useHover({
    ...options,
    onHoverStart: show,
    onHoverEnd: hide,
  });

  useEffect(() => {
    return () => {
      clearTimeouts();
    };
  }, [clearTimeouts]);

  return {
    ...hover,
    isVisible,
    show: () => {
      clearTimeouts();
      setIsVisible(true);
      options.onHoverStart?.();
    },
    hide: () => {
      clearTimeouts();
      setIsVisible(false);
      options.onHoverEnd?.();
    },
  };
}

export default useHover;
