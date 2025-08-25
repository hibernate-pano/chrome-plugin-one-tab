/**
 * 拖拽视觉反馈工具类
 * 提供统一的拖拽视觉效果和动画
 */

import { cn } from './cn';

export type DragState = 'idle' | 'dragging' | 'over' | 'dropping';
export type DragType = 'tab' | 'group' | 'file' | 'generic';

export interface DragVisualOptions {
  type?: DragType;
  state?: DragState;
  intensity?: 'subtle' | 'normal' | 'strong';
  showGhost?: boolean;
  showDropZone?: boolean;
  className?: string;
}

/**
 * 基础拖拽样式
 */
export const baseDragStyles = {
  transition: 'all 200ms cubic-bezier(0.2, 0, 0, 1)',
  willChange: 'transform, opacity, box-shadow',
};

/**
 * 拖拽状态样式
 */
export const dragStateStyles = {
  idle: {
    transform: 'none',
    opacity: 1,
    zIndex: 'auto',
    boxShadow: 'none',
  },
  dragging: {
    transform: 'rotate(2deg) scale(1.02)',
    opacity: 0.8,
    zIndex: 1000,
    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
    cursor: 'grabbing',
  },
  over: {
    transform: 'scale(1.02)',
    opacity: 0.9,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: 'rgb(59, 130, 246)',
  },
  dropping: {
    transform: 'scale(0.98)',
    opacity: 1,
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderColor: 'rgb(34, 197, 94)',
  },
};

/**
 * 拖拽类型特定样式
 */
export const dragTypeStyles = {
  tab: {
    borderRadius: '6px',
    border: '2px solid transparent',
  },
  group: {
    borderRadius: '8px',
    border: '2px solid transparent',
  },
  file: {
    borderRadius: '4px',
    border: '1px solid transparent',
  },
  generic: {
    borderRadius: '4px',
    border: '1px solid transparent',
  },
};

/**
 * 拖拽强度样式
 */
export const dragIntensityStyles = {
  subtle: {
    dragging: {
      transform: 'rotate(1deg) scale(1.01)',
      opacity: 0.9,
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
    },
    over: {
      transform: 'scale(1.01)',
      backgroundColor: 'rgba(59, 130, 246, 0.05)',
    },
  },
  normal: {
    dragging: {
      transform: 'rotate(2deg) scale(1.02)',
      opacity: 0.8,
      boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
    },
    over: {
      transform: 'scale(1.02)',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
    },
  },
  strong: {
    dragging: {
      transform: 'rotate(3deg) scale(1.05)',
      opacity: 0.7,
      boxShadow: '0 15px 35px rgba(0, 0, 0, 0.3)',
    },
    over: {
      transform: 'scale(1.05)',
      backgroundColor: 'rgba(59, 130, 246, 0.15)',
    },
  },
};

/**
 * 生成拖拽样式
 */
export function getDragStyles(options: DragVisualOptions = {}): React.CSSProperties {
  const {
    type = 'generic',
    state = 'idle',
    intensity = 'normal',
  } = options;

  const baseStyles = { ...baseDragStyles };
  const typeStyles = { ...dragTypeStyles[type] };
  const stateStyles = { ...dragStateStyles[state] };
  
  // 应用强度调整
  if (state === 'dragging' || state === 'over') {
    const intensityAdjustments = dragIntensityStyles[intensity][state];
    Object.assign(stateStyles, intensityAdjustments);
  }

  return {
    ...baseStyles,
    ...typeStyles,
    ...stateStyles,
  };
}

/**
 * 拖拽CSS类名
 */
export const dragClassNames = {
  // 基础拖拽类
  draggable: 'cursor-grab active:cursor-grabbing',
  dragging: 'pointer-events-none select-none',
  
  // 拖拽状态类
  'drag-idle': '',
  'drag-active': 'z-50 shadow-2xl',
  'drag-over': 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-600',
  'drag-dropping': 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-600',
  
  // 拖拽类型类
  'drag-tab': 'rounded-md border-2 border-transparent',
  'drag-group': 'rounded-lg border-2 border-transparent',
  
  // 拖拽强度类
  'drag-subtle': 'transition-all duration-150',
  'drag-normal': 'transition-all duration-200',
  'drag-strong': 'transition-all duration-300',
  
  // 拖拽禁用类
  'drag-disabled': 'cursor-not-allowed opacity-50',
  
  // 拖拽预览类
  'drag-preview': 'pointer-events-none transform rotate-2 scale-105 opacity-80',
  
  // 拖拽占位符类
  'drag-placeholder': 'border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50',
};

/**
 * 生成拖拽类名
 */
export function getDragClassName(options: DragVisualOptions = {}): string {
  const {
    type = 'generic',
    state = 'idle',
    intensity = 'normal',
    showGhost = false,
    showDropZone = false,
    className,
  } = options;

  const classes = [
    dragClassNames.draggable,
    dragClassNames[`drag-${intensity}`],
  ];

  if (type !== 'generic') {
    classes.push(dragClassNames[`drag-${type}`]);
  }

  switch (state) {
    case 'dragging':
      classes.push(dragClassNames.dragging, dragClassNames['drag-active']);
      break;
    case 'over':
      classes.push(dragClassNames['drag-over']);
      break;
    case 'dropping':
      classes.push(dragClassNames['drag-dropping']);
      break;
  }

  if (showGhost) {
    classes.push(dragClassNames['drag-preview']);
  }

  if (showDropZone) {
    classes.push(dragClassNames['drag-placeholder']);
  }

  return cn(...classes, className);
}

/**
 * 拖拽动画配置
 */
export const dragAnimations = {
  // 拖拽开始动画
  dragStart: {
    duration: 200,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    keyframes: [
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
      { transform: 'scale(1.02) rotate(2deg)', opacity: 0.8 },
    ],
  },
  
  // 拖拽结束动画
  dragEnd: {
    duration: 300,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    keyframes: [
      { transform: 'scale(1.02) rotate(2deg)', opacity: 0.8 },
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
    ],
  },
  
  // 放置动画
  drop: {
    duration: 400,
    easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    keyframes: [
      { transform: 'scale(1.02)', opacity: 0.8 },
      { transform: 'scale(1.1)', opacity: 0.9 },
      { transform: 'scale(1)', opacity: 1 },
    ],
  },
  
  // 取消动画
  cancel: {
    duration: 250,
    easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    keyframes: [
      { transform: 'scale(1.02) rotate(2deg)', opacity: 0.8 },
      { transform: 'scale(0.98) rotate(-1deg)', opacity: 0.9 },
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
    ],
  },
};

/**
 * 拖拽区域样式
 */
export const dropZoneStyles = {
  active: cn(
    'border-2 border-dashed border-blue-400 dark:border-blue-500',
    'bg-blue-50 dark:bg-blue-900/20',
    'transition-all duration-200'
  ),
  
  valid: cn(
    'border-2 border-dashed border-green-400 dark:border-green-500',
    'bg-green-50 dark:bg-green-900/20'
  ),
  
  invalid: cn(
    'border-2 border-dashed border-red-400 dark:border-red-500',
    'bg-red-50 dark:bg-red-900/20'
  ),
  
  idle: cn(
    'border-2 border-transparent',
    'transition-all duration-200'
  ),
};

/**
 * 拖拽指示器组件样式
 */
export const dragIndicatorStyles = {
  // 拖拽手柄
  handle: cn(
    'cursor-grab active:cursor-grabbing',
    'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300',
    'transition-colors duration-150'
  ),
  
  // 拖拽图标
  icon: cn(
    'w-4 h-4 flex-shrink-0'
  ),
  
  // 拖拽提示
  hint: cn(
    'text-xs text-gray-500 dark:text-gray-400',
    'opacity-0 group-hover:opacity-100',
    'transition-opacity duration-200'
  ),
};

/**
 * 预设的拖拽配置
 */
export const dragPresets = {
  // 标签页拖拽
  tab: {
    type: 'tab' as DragType,
    intensity: 'normal' as const,
    showGhost: true,
  },
  
  // 标签组拖拽
  group: {
    type: 'group' as DragType,
    intensity: 'normal' as const,
    showGhost: true,
  },
  
  // 文件拖拽
  file: {
    type: 'file' as DragType,
    intensity: 'subtle' as const,
    showGhost: false,
  },
  
  // 列表项拖拽
  listItem: {
    type: 'generic' as DragType,
    intensity: 'subtle' as const,
    showGhost: false,
  },
};

export default {
  getDragStyles,
  getDragClassName,
  dragAnimations,
  dropZoneStyles,
  dragIndicatorStyles,
  dragPresets,
};
