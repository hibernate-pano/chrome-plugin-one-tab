/**
 * 按钮交互行为Hook
 * 提供统一的按钮交互逻辑和状态管理
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface ButtonInteractionOptions {
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onDoubleClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onLongPress?: () => void;
  longPressDelay?: number;
  disabled?: boolean;
  loading?: boolean;
  preventDoubleClick?: boolean;
  doubleClickDelay?: number;
}

export interface ButtonInteractionState {
  isPressed: boolean;
  isHovered: boolean;
  isFocused: boolean;
  isLoading: boolean;
  clickCount: number;
}

export interface ButtonInteractionHandlers {
  onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseUp: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onFocus: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

export function useButtonInteraction(options: ButtonInteractionOptions = {}) {
  const {
    onClick,
    onDoubleClick,
    onLongPress,
    longPressDelay = 500,
    disabled = false,
    loading = false,
    preventDoubleClick = false,
    doubleClickDelay = 300,
  } = options;

  const [state, setState] = useState<ButtonInteractionState>({
    isPressed: false,
    isHovered: false,
    isFocused: false,
    isLoading: loading,
    clickCount: 0,
  });

  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const doubleClickTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastClickTimeRef = useRef<number>(0);
  const isLongPressTriggeredRef = useRef<boolean>(false);

  // 更新加载状态
  useEffect(() => {
    setState(prev => ({ ...prev, isLoading: loading }));
  }, [loading]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
      if (doubleClickTimerRef.current) {
        clearTimeout(doubleClickTimerRef.current);
      }
    };
  }, []);

  const startLongPress = useCallback(() => {
    if (onLongPress && !disabled && !loading) {
      longPressTimerRef.current = setTimeout(() => {
        isLongPressTriggeredRef.current = true;
        onLongPress();
      }, longPressDelay);
    }
  }, [onLongPress, disabled, loading, longPressDelay]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    isLongPressTriggeredRef.current = false;
  }, []);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;

    setState(prev => ({ ...prev, isPressed: true }));
    startLongPress();
  }, [disabled, loading, startLongPress]);

  const handleMouseUp = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setState(prev => ({ ...prev, isPressed: false }));
    cancelLongPress();
  }, [cancelLongPress]);

  const handleMouseEnter = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;
    setState(prev => ({ ...prev, isHovered: true }));
  }, [disabled, loading]);

  const handleMouseLeave = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setState(prev => ({ ...prev, isHovered: false, isPressed: false }));
    cancelLongPress();
  }, [cancelLongPress]);

  const handleFocus = useCallback((event: React.FocusEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;
    setState(prev => ({ ...prev, isFocused: true }));
  }, [disabled, loading]);

  const handleBlur = useCallback((event: React.FocusEvent<HTMLButtonElement>) => {
    setState(prev => ({ ...prev, isFocused: false, isPressed: false }));
    cancelLongPress();
  }, [cancelLongPress]);

  const handleClick = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading || isLongPressTriggeredRef.current) {
      isLongPressTriggeredRef.current = false;
      return;
    }

    const now = Date.now();
    const timeSinceLastClick = now - lastClickTimeRef.current;

    // 防止双击
    if (preventDoubleClick && timeSinceLastClick < doubleClickDelay) {
      return;
    }

    lastClickTimeRef.current = now;

    setState(prev => ({ ...prev, clickCount: prev.clickCount + 1 }));

    if (onClick) {
      try {
        setState(prev => ({ ...prev, isLoading: true }));
        await onClick(event);
      } catch (error) {
        console.error('Button click handler error:', error);
      } finally {
        setState(prev => ({ ...prev, isLoading: false }));
      }
    }
  }, [disabled, loading, onClick, preventDoubleClick, doubleClickDelay]);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || loading || !onDoubleClick) return;
    onDoubleClick(event);
  }, [disabled, loading, onDoubleClick]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setState(prev => ({ ...prev, isPressed: true }));
      startLongPress();
    }
  }, [disabled, loading, startLongPress]);

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || loading) return;

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      setState(prev => ({ ...prev, isPressed: false }));
      cancelLongPress();
      
      if (!isLongPressTriggeredRef.current) {
        // 模拟点击事件
        const syntheticEvent = {
          ...event,
          type: 'click',
          currentTarget: event.currentTarget,
          target: event.target,
        } as unknown as React.MouseEvent<HTMLButtonElement>;
        
        handleClick(syntheticEvent);
      }
    }
  }, [disabled, loading, cancelLongPress, handleClick]);

  const handlers: ButtonInteractionHandlers = {
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onKeyUp: handleKeyUp,
  };

  // 只有在提供了双击处理器时才添加双击事件
  if (onDoubleClick) {
    handlers.onDoubleClick = handleDoubleClick;
  }

  return {
    state,
    handlers,
    // 工具方法
    reset: useCallback(() => {
      setState({
        isPressed: false,
        isHovered: false,
        isFocused: false,
        isLoading: loading,
        clickCount: 0,
      });
      cancelLongPress();
    }, [loading, cancelLongPress]),
  };
}

export default useButtonInteraction;
