/**
 * 按钮样式工具类
 * 提供统一的按钮样式生成函数
 */

import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline' | 'success' | 'warning';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonRounded = 'sm' | 'md' | 'lg' | 'full';

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  rounded?: ButtonRounded;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * 基础按钮样式
 */
export const baseButtonStyles = [
  'inline-flex items-center justify-center gap-2 font-medium',
  'transition-all duration-300 ease-out',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  'disabled:pointer-events-none disabled:opacity-50',
  'active:scale-98',
];

/**
 * 按钮变体样式
 */
export const buttonVariants: Record<ButtonVariant, string[]> = {
  primary: [
    'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 focus-visible:ring-blue-500',
    'shadow-sm hover:shadow-md',
  ],
  secondary: [
    'bg-gray-100 text-gray-900 hover:bg-gray-200 active:bg-gray-300 focus-visible:ring-gray-500',
    'dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700 dark:active:bg-gray-600',
    'shadow-sm hover:shadow-md',
  ],
  ghost: [
    'text-gray-700 hover:bg-gray-100 active:bg-gray-200 focus-visible:ring-gray-500',
    'dark:text-gray-300 dark:hover:bg-gray-800 dark:active:bg-gray-700',
  ],
  destructive: [
    'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 focus-visible:ring-red-500',
    'shadow-sm hover:shadow-md',
  ],
  outline: [
    'border border-gray-300 bg-transparent text-gray-700 hover:bg-gray-50 active:bg-gray-100 focus-visible:ring-gray-500',
    'dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800 dark:active:bg-gray-700',
    'shadow-sm hover:shadow-md',
  ],
  success: [
    'bg-green-600 text-white hover:bg-green-700 active:bg-green-800 focus-visible:ring-green-500',
    'shadow-sm hover:shadow-md',
  ],
  warning: [
    'bg-yellow-500 text-white hover:bg-yellow-600 active:bg-yellow-700 focus-visible:ring-yellow-500',
    'shadow-sm hover:shadow-md',
  ],
};

/**
 * 按钮尺寸样式
 */
export const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm min-w-[64px]',
  md: 'h-10 px-4 text-sm min-w-[80px]',
  lg: 'h-12 px-6 text-base min-w-[96px]',
};

/**
 * 按钮圆角样式
 */
export const buttonRounded: Record<ButtonRounded, string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/**
 * 生成按钮样式类名
 */
export function getButtonStyles(options: ButtonStyleOptions = {}): string {
  const {
    variant = 'primary',
    size = 'md',
    rounded = 'md',
    fullWidth = false,
    loading = false,
    disabled = false,
    className,
  } = options;

  return cn(
    baseButtonStyles,
    buttonVariants[variant],
    buttonSizes[size],
    buttonRounded[rounded],
    fullWidth && 'w-full',
    loading && 'cursor-wait',
    disabled && 'cursor-not-allowed',
    className
  );
}

/**
 * 图标按钮样式
 */
export const iconButtonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 w-8 p-1',
  md: 'h-10 w-10 p-2',
  lg: 'h-12 w-12 p-3',
};

/**
 * 生成图标按钮样式
 */
export function getIconButtonStyles(options: ButtonStyleOptions = {}): string {
  const {
    variant = 'ghost',
    size = 'md',
    rounded = 'md',
    loading = false,
    disabled = false,
    className,
  } = options;

  return cn(
    baseButtonStyles,
    buttonVariants[variant],
    iconButtonSizes[size],
    buttonRounded[rounded],
    loading && 'cursor-wait',
    disabled && 'cursor-not-allowed',
    className
  );
}

/**
 * 浮动操作按钮 (FAB) 样式
 */
export const fabSizes = {
  sm: 'h-10 w-10',
  md: 'h-14 w-14',
  lg: 'h-16 w-16',
};

export function getFabStyles(options: Omit<ButtonStyleOptions, 'fullWidth'> = {}): string {
  const {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled = false,
    className,
  } = options;

  return cn(
    'inline-flex items-center justify-center rounded-full font-medium',
    'transition-all duration-300 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:scale-95 hover:scale-105',
    'shadow-lg hover:shadow-xl',
    buttonVariants[variant],
    fabSizes[size],
    loading && 'cursor-wait',
    disabled && 'cursor-not-allowed',
    className
  );
}

/**
 * 按钮组样式
 */
export const buttonGroupStyles = {
  horizontal: 'inline-flex rounded-md shadow-sm',
  vertical: 'inline-flex flex-col rounded-md shadow-sm',
};

export const buttonGroupItemStyles = {
  first: 'rounded-l-md rounded-r-none',
  middle: 'rounded-none border-l-0',
  last: 'rounded-r-md rounded-l-none border-l-0',
  only: 'rounded-md',
};

/**
 * 生成按钮组项目样式
 */
export function getButtonGroupItemStyles(
  position: 'first' | 'middle' | 'last' | 'only',
  options: ButtonStyleOptions = {}
): string {
  const baseStyles = getButtonStyles({ ...options, rounded: 'md' });
  
  // 移除默认圆角，应用按钮组圆角
  const stylesWithoutRounded = baseStyles.replace(/rounded-\w+/g, '');
  
  return cn(
    stylesWithoutRounded,
    buttonGroupItemStyles[position]
  );
}

/**
 * 按钮状态样式
 */
export const buttonStateStyles = {
  loading: 'cursor-wait',
  disabled: 'cursor-not-allowed opacity-50',
  active: 'scale-98',
  focus: 'ring-2 ring-offset-2',
};

/**
 * 按钮动画样式
 */
export const buttonAnimations = {
  bounce: 'animate-bounce',
  pulse: 'animate-pulse',
  spin: 'animate-spin',
  ping: 'animate-ping',
};

/**
 * 预设按钮样式组合
 */
export const buttonPresets = {
  // 主要操作按钮
  primaryAction: getButtonStyles({ variant: 'primary', size: 'md' }),
  
  // 次要操作按钮
  secondaryAction: getButtonStyles({ variant: 'secondary', size: 'md' }),
  
  // 危险操作按钮
  dangerAction: getButtonStyles({ variant: 'destructive', size: 'md' }),
  
  // 成功操作按钮
  successAction: getButtonStyles({ variant: 'success', size: 'md' }),
  
  // 取消按钮
  cancel: getButtonStyles({ variant: 'ghost', size: 'md' }),
  
  // 确认按钮
  confirm: getButtonStyles({ variant: 'primary', size: 'lg' }),
  
  // 小型图标按钮
  iconSmall: getIconButtonStyles({ size: 'sm' }),
  
  // 中型图标按钮
  iconMedium: getIconButtonStyles({ size: 'md' }),
  
  // 大型图标按钮
  iconLarge: getIconButtonStyles({ size: 'lg' }),
  
  // 浮动操作按钮
  fab: getFabStyles({ variant: 'primary', size: 'md' }),
  
  // 小型浮动操作按钮
  fabSmall: getFabStyles({ variant: 'primary', size: 'sm' }),
};

export default {
  getButtonStyles,
  getIconButtonStyles,
  getFabStyles,
  getButtonGroupItemStyles,
  buttonPresets,
  buttonVariants,
  buttonSizes,
  buttonRounded,
};
