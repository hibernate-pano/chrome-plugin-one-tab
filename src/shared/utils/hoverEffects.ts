/**
 * 统一的悬停效果工具类
 * 提供一致的鼠标悬停视觉反馈
 */

import { cn } from './cn';

export type HoverEffect = 'lift' | 'scale' | 'glow' | 'darken' | 'lighten' | 'shadow' | 'border' | 'none';
export type HoverIntensity = 'subtle' | 'normal' | 'strong';

export interface HoverOptions {
  effect?: HoverEffect;
  intensity?: HoverIntensity;
  duration?: 'fast' | 'normal' | 'slow';
  className?: string;
}

/**
 * 基础悬停过渡样式
 */
export const baseHoverTransition = 'transition-all ease-out';

/**
 * 过渡持续时间
 */
export const hoverDurations = {
  fast: 'duration-150',
  normal: 'duration-300',
  slow: 'duration-500',
};

/**
 * 悬停效果样式映射
 */
export const hoverEffects = {
  lift: {
    subtle: 'hover:transform hover:-translate-y-0.5 hover:shadow-sm',
    normal: 'hover:transform hover:-translate-y-1 hover:shadow-md',
    strong: 'hover:transform hover:-translate-y-2 hover:shadow-lg',
  },
  scale: {
    subtle: 'hover:scale-[1.02]',
    normal: 'hover:scale-105',
    strong: 'hover:scale-110',
  },
  glow: {
    subtle: 'hover:shadow-sm hover:shadow-blue-500/20',
    normal: 'hover:shadow-md hover:shadow-blue-500/30',
    strong: 'hover:shadow-lg hover:shadow-blue-500/40',
  },
  darken: {
    subtle: 'hover:brightness-95',
    normal: 'hover:brightness-90',
    strong: 'hover:brightness-75',
  },
  lighten: {
    subtle: 'hover:brightness-105',
    normal: 'hover:brightness-110',
    strong: 'hover:brightness-125',
  },
  shadow: {
    subtle: 'hover:shadow-sm',
    normal: 'hover:shadow-md',
    strong: 'hover:shadow-lg',
  },
  border: {
    subtle: 'hover:border-gray-300 dark:hover:border-gray-600',
    normal: 'hover:border-gray-400 dark:hover:border-gray-500',
    strong: 'hover:border-gray-500 dark:hover:border-gray-400',
  },
  none: {
    subtle: '',
    normal: '',
    strong: '',
  },
};

/**
 * 生成悬停效果样式
 */
export function getHoverStyles(options: HoverOptions = {}): string {
  const {
    effect = 'lift',
    intensity = 'normal',
    duration = 'normal',
    className,
  } = options;

  return cn(
    baseHoverTransition,
    hoverDurations[duration],
    hoverEffects[effect][intensity],
    className
  );
}

/**
 * 预设的悬停效果组合
 */
export const hoverPresets = {
  // 卡片悬停效果
  card: getHoverStyles({ effect: 'lift', intensity: 'normal' }),
  cardSubtle: getHoverStyles({ effect: 'lift', intensity: 'subtle' }),
  cardStrong: getHoverStyles({ effect: 'lift', intensity: 'strong' }),

  // 按钮悬停效果
  button: getHoverStyles({ effect: 'darken', intensity: 'normal' }),
  buttonScale: getHoverStyles({ effect: 'scale', intensity: 'subtle' }),
  buttonGlow: getHoverStyles({ effect: 'glow', intensity: 'normal' }),

  // 图标悬停效果
  icon: getHoverStyles({ effect: 'scale', intensity: 'subtle', duration: 'fast' }),
  iconGlow: getHoverStyles({ effect: 'glow', intensity: 'subtle', duration: 'fast' }),

  // 链接悬停效果
  link: getHoverStyles({ effect: 'none' }),
  linkUnderline: 'hover:underline transition-all duration-150',

  // 输入框悬停效果
  input: getHoverStyles({ effect: 'border', intensity: 'normal' }),
  inputGlow: getHoverStyles({ effect: 'glow', intensity: 'subtle' }),

  // 列表项悬停效果
  listItem: getHoverStyles({ effect: 'lighten', intensity: 'subtle' }),
  listItemCard: getHoverStyles({ effect: 'lift', intensity: 'subtle' }),

  // 图片悬停效果
  image: getHoverStyles({ effect: 'scale', intensity: 'subtle', duration: 'slow' }),
  imageOverlay: 'hover:brightness-75 transition-all duration-300',

  // 标签悬停效果
  tag: getHoverStyles({ effect: 'darken', intensity: 'subtle', duration: 'fast' }),
  tagScale: getHoverStyles({ effect: 'scale', intensity: 'subtle', duration: 'fast' }),
};

/**
 * 组件特定的悬停效果
 */
export const componentHoverStyles = {
  // 标签组卡片
  tabGroup: cn(
    baseHoverTransition,
    hoverDurations.normal,
    'hover:transform hover:-translate-y-1 hover:shadow-md',
    'hover:border-blue-200 dark:hover:border-blue-700'
  ),

  // 标签项
  tabItem: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:bg-gray-50 dark:hover:bg-gray-800'
  ),

  // 导航项
  navItem: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:bg-gray-100 dark:hover:bg-gray-800',
    'hover:text-blue-600 dark:hover:text-blue-400'
  ),

  // 下拉菜单项
  dropdownItem: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:bg-gray-100 dark:hover:bg-gray-700'
  ),

  // 模态框
  modal: cn(
    baseHoverTransition,
    hoverDurations.normal,
    'hover:shadow-xl'
  ),

  // 工具提示
  tooltip: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:opacity-100'
  ),

  // 搜索结果项
  searchResult: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:bg-blue-50 dark:hover:bg-blue-900/20',
    'hover:border-blue-200 dark:hover:border-blue-700'
  ),

  // 设置项
  settingItem: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:bg-gray-50 dark:hover:bg-gray-800'
  ),

  // 状态指示器
  statusIndicator: cn(
    baseHoverTransition,
    hoverDurations.fast,
    'hover:scale-110'
  ),
};

/**
 * 交互状态样式
 */
export const interactionStates = {
  // 激活状态
  active: 'active:scale-95 active:brightness-90',
  
  // 聚焦状态
  focus: 'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
  
  // 禁用状态
  disabled: 'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none',
  
  // 加载状态
  loading: 'cursor-wait opacity-75',
  
  // 选中状态
  selected: 'bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600',
};

/**
 * 响应式悬停效果
 * 在移动设备上禁用悬停效果
 */
export const responsiveHover = (hoverClass: string): string => {
  return `md:${hoverClass}`;
};

/**
 * 条件悬停效果
 */
export function conditionalHover(condition: boolean, hoverClass: string): string {
  return condition ? hoverClass : '';
}

/**
 * 组合多个悬停效果
 */
export function combineHoverEffects(...effects: string[]): string {
  return cn(...effects);
}

/**
 * 获取组件的完整交互样式
 */
export function getInteractionStyles(options: {
  hover?: string;
  active?: boolean;
  focus?: boolean;
  disabled?: boolean;
  loading?: boolean;
  selected?: boolean;
}): string {
  const { hover, active, focus, disabled, loading, selected } = options;

  return cn(
    hover,
    active && interactionStates.active,
    focus && interactionStates.focus,
    disabled && interactionStates.disabled,
    loading && interactionStates.loading,
    selected && interactionStates.selected
  );
}

export default {
  getHoverStyles,
  hoverPresets,
  componentHoverStyles,
  interactionStates,
  responsiveHover,
  conditionalHover,
  combineHoverEffects,
  getInteractionStyles,
};
