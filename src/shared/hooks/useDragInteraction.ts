/**
 * 拖拽交互Hook
 * 提供统一的拖拽状态管理和视觉反馈
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { getDragStyles, getDragClassName, DragVisualOptions, DragState, dragAnimations } from '@/shared/utils/dragVisualFeedback';

export interface DragInteractionOptions extends DragVisualOptions {
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: (event: React.DragEvent) => void;
  onDragEnter?: (event: React.DragEvent) => void;
  onDragLeave?: (event: React.DragEvent) => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  disabled?: boolean;
  draggable?: boolean;
  droppable?: boolean;
  data?: any;
}

export interface DragInteractionState {
  isDragging: boolean;
  isOver: boolean;
  isDropping: boolean;
  dragState: DragState;
  canDrop: boolean;
}

export interface DragInteractionHandlers {
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: (event: React.DragEvent) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onMouseDown: (event: React.MouseEvent) => void;
  onMouseUp: (event: React.MouseEvent) => void;
}

export function useDragInteraction(options: DragInteractionOptions = {}) {
  const {
    onDragStart,
    onDragEnd,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    disabled = false,
    draggable = true,
    droppable = false,
    data,
    type = 'generic',
    intensity = 'normal',
    showGhost = true,
    showDropZone = false,
    className,
  } = options;

  const [state, setState] = useState<DragInteractionState>({
    isDragging: false,
    isOver: false,
    isDropping: false,
    dragState: 'idle',
    canDrop: true,
  });

  const elementRef = useRef<HTMLElement | null>(null);
  const dragCounterRef = useRef(0);
  const animationRef = useRef<Animation | null>(null);

  // 清理动画
  const clearAnimation = useCallback(() => {
    if (animationRef.current) {
      animationRef.current.cancel();
      animationRef.current = null;
    }
  }, []);

  // 播放动画
  const playAnimation = useCallback((animationConfig: any) => {
    if (!elementRef.current) return;

    clearAnimation();
    
    animationRef.current = elementRef.current.animate(
      animationConfig.keyframes,
      {
        duration: animationConfig.duration,
        easing: animationConfig.easing,
        fill: 'forwards',
      }
    );
  }, [clearAnimation]);

  // 处理拖拽开始
  const handleDragStart = useCallback((event: React.DragEvent) => {
    if (disabled || !draggable) {
      event.preventDefault();
      return;
    }

    setState(prev => ({
      ...prev,
      isDragging: true,
      dragState: 'dragging',
    }));

    // 设置拖拽数据
    if (data) {
      event.dataTransfer.setData('application/json', JSON.stringify(data));
    }

    // 设置拖拽效果
    event.dataTransfer.effectAllowed = 'move';

    // 播放拖拽开始动画
    playAnimation(dragAnimations.dragStart);

    onDragStart?.(event);
  }, [disabled, draggable, data, onDragStart, playAnimation]);

  // 处理拖拽结束
  const handleDragEnd = useCallback((event: React.DragEvent) => {
    setState(prev => ({
      ...prev,
      isDragging: false,
      isDropping: false,
      dragState: 'idle',
    }));

    // 播放拖拽结束动画
    playAnimation(dragAnimations.dragEnd);

    onDragEnd?.(event);
  }, [onDragEnd, playAnimation]);

  // 处理拖拽进入
  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (disabled || !droppable) return;

    event.preventDefault();
    dragCounterRef.current++;

    if (dragCounterRef.current === 1) {
      setState(prev => ({
        ...prev,
        isOver: true,
        dragState: 'over',
      }));
    }

    onDragEnter?.(event);
  }, [disabled, droppable, onDragEnter]);

  // 处理拖拽离开
  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (disabled || !droppable) return;

    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setState(prev => ({
        ...prev,
        isOver: false,
        dragState: prev.isDragging ? 'dragging' : 'idle',
      }));
    }

    onDragLeave?.(event);
  }, [disabled, droppable, onDragLeave]);

  // 处理拖拽悬停
  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (disabled || !droppable) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    onDragOver?.(event);
  }, [disabled, droppable, onDragOver]);

  // 处理放置
  const handleDrop = useCallback((event: React.DragEvent) => {
    if (disabled || !droppable) return;

    event.preventDefault();
    dragCounterRef.current = 0;

    setState(prev => ({
      ...prev,
      isOver: false,
      isDropping: true,
      dragState: 'dropping',
    }));

    // 播放放置动画
    playAnimation(dragAnimations.drop);

    // 延迟重置状态
    setTimeout(() => {
      setState(prev => ({
        ...prev,
        isDropping: false,
        dragState: 'idle',
      }));
    }, dragAnimations.drop.duration);

    onDrop?.(event);
  }, [disabled, droppable, onDrop, playAnimation]);

  // 处理鼠标按下（用于视觉反馈）
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (disabled || !draggable) return;

    // 添加轻微的按下效果
    if (elementRef.current) {
      elementRef.current.style.transform = 'scale(0.98)';
    }
  }, [disabled, draggable]);

  // 处理鼠标释放
  const handleMouseUp = useCallback((event: React.MouseEvent) => {
    if (disabled || !draggable) return;

    // 恢复正常状态
    if (elementRef.current) {
      elementRef.current.style.transform = '';
    }
  }, [disabled, draggable]);

  // 清理效果
  useEffect(() => {
    return () => {
      clearAnimation();
    };
  }, [clearAnimation]);

  // 生成样式和类名
  const dragStyles = getDragStyles({
    type,
    state: state.dragState,
    intensity,
    showGhost,
    showDropZone,
  });

  const dragClassName = getDragClassName({
    type,
    state: state.dragState,
    intensity,
    showGhost,
    showDropZone,
    className,
  });

  const handlers: DragInteractionHandlers = {
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
  };

  return {
    // 状态
    ...state,
    
    // 样式
    dragStyles,
    dragClassName,
    
    // 处理器
    handlers,
    
    // Ref
    elementRef,
    
    // 工具方法
    reset: useCallback(() => {
      setState({
        isDragging: false,
        isOver: false,
        isDropping: false,
        dragState: 'idle',
        canDrop: true,
      });
      dragCounterRef.current = 0;
      clearAnimation();
    }, [clearAnimation]),
    
    // 手动设置状态
    setDragState: useCallback((newState: DragState) => {
      setState(prev => ({ ...prev, dragState: newState }));
    }, []),
    
    // 设置是否可放置
    setCanDrop: useCallback((canDrop: boolean) => {
      setState(prev => ({ ...prev, canDrop }));
    }, []),
  };
}

/**
 * 简化的拖拽Hook，只用于拖拽元素
 */
export function useDraggable(options: Omit<DragInteractionOptions, 'droppable'> = {}) {
  return useDragInteraction({ ...options, droppable: false });
}

/**
 * 简化的放置Hook，只用于放置区域
 */
export function useDroppable(options: Omit<DragInteractionOptions, 'draggable'> = {}) {
  return useDragInteraction({ ...options, draggable: false, droppable: true });
}

export default useDragInteraction;
