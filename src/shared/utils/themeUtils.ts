/**
 * 主题适配工具函数
 * 基于空标签页面的设计规范，提供一致的主题适配
 */

import { cn } from './cn';

/**
 * 获取主题适配的类名
 */
export const getThemeClasses = (baseClasses: string, themeVariants?: {
  light?: string;
  dark?: string;
}) => {
  if (!themeVariants) return baseClasses;
  
  return cn(
    baseClasses,
    themeVariants.light,
    themeVariants.dark && `dark:${themeVariants.dark.replace('dark:', '')}`
  );
};

/**
 * 状态颜色主题适配
 */
export const getStatusColors = (status: 'success' | 'warning' | 'error' | 'info') => {
  const colorMap = {
    success: {
      bg: 'bg-green-50 dark:bg-green-900/20',
      border: 'border-green-200 dark:border-green-800',
      text: 'text-green-800 dark:text-green-200',
      icon: 'text-green-600 dark:text-green-400',
    },
    warning: {
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      border: 'border-amber-200 dark:border-amber-800',
      text: 'text-amber-800 dark:text-amber-200',
      icon: 'text-amber-600 dark:text-amber-400',
    },
    error: {
      bg: 'bg-red-50 dark:bg-red-900/20',
      border: 'border-red-200 dark:border-red-800',
      text: 'text-red-800 dark:text-red-200',
      icon: 'text-red-600 dark:text-red-400',
    },
    info: {
      bg: 'bg-blue-50 dark:bg-blue-900/20',
      border: 'border-blue-200 dark:border-blue-800',
      text: 'text-blue-800 dark:text-blue-200',
      icon: 'text-blue-600 dark:text-blue-400',
    },
  };

  return colorMap[status];
};

/**
 * 按钮颜色主题适配
 */
export const getButtonColors = (variant: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost') => {
  const colorMap = {
    primary: {
      base: 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800',
      focus: 'focus:ring-blue-500',
      shadow: 'shadow-md hover:shadow-lg',
    },
    secondary: {
      base: 'bg-gray-200 text-gray-800 hover:bg-gray-300 active:bg-gray-400 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:active:bg-gray-500',
      focus: 'focus:ring-gray-500',
      shadow: 'shadow-sm hover:shadow-md',
    },
    success: {
      base: 'bg-green-500 text-white hover:bg-green-600 active:bg-green-700',
      focus: 'focus:ring-green-500',
      shadow: 'shadow-md hover:shadow-lg',
    },
    danger: {
      base: 'bg-red-500 text-white hover:bg-red-600 active:bg-red-700',
      focus: 'focus:ring-red-500',
      shadow: 'shadow-md hover:shadow-lg',
    },
    ghost: {
      base: 'bg-transparent text-gray-700 hover:bg-gray-100 active:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800 dark:active:bg-gray-700',
      focus: 'focus:ring-gray-500',
      shadow: '',
    },
  };

  return colorMap[variant];
};

/**
 * 卡片主题适配
 */
export const getCardClasses = (variant: 'default' | 'elevated' | 'outlined' | 'filled') => {
  const variantMap = {
    default: 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm',
    elevated: 'bg-white dark:bg-gray-800 shadow-md hover:shadow-lg border-0',
    outlined: 'bg-transparent border-2 border-gray-200 dark:border-gray-700',
    filled: 'bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700',
  };

  return cn(
    'rounded-lg transition-all duration-200',
    variantMap[variant]
  );
};

/**
 * 文本颜色主题适配
 */
export const getTextColors = (level: 'primary' | 'secondary' | 'tertiary' | 'inverse') => {
  const colorMap = {
    primary: 'text-gray-900 dark:text-gray-100',
    secondary: 'text-gray-700 dark:text-gray-300',
    tertiary: 'text-gray-500 dark:text-gray-400',
    inverse: 'text-gray-100 dark:text-gray-900',
  };

  return colorMap[level];
};

/**
 * 边框颜色主题适配
 */
export const getBorderColors = (level: 'primary' | 'secondary' | 'tertiary') => {
  const colorMap = {
    primary: 'border-gray-200 dark:border-gray-700',
    secondary: 'border-gray-300 dark:border-gray-600',
    tertiary: 'border-gray-400 dark:border-gray-500',
  };

  return colorMap[level];
};

/**
 * 背景颜色主题适配
 */
export const getBackgroundColors = (level: 'primary' | 'secondary' | 'tertiary') => {
  const colorMap = {
    primary: 'bg-white dark:bg-gray-900',
    secondary: 'bg-gray-50 dark:bg-gray-800',
    tertiary: 'bg-gray-100 dark:bg-gray-700',
  };

  return colorMap[level];
};

/**
 * 响应式断点工具
 */
export const getResponsiveClasses = (config: {
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
}) => {
  return cn(
    config.sm,
    config.md && `md:${config.md}`,
    config.lg && `lg:${config.lg}`,
    config.xl && `xl:${config.xl}`
  );
};

/**
 * 检查是否为深色模式
 */
export const isDarkMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
};

/**
 * 获取当前主题模式
 */
export const getCurrentTheme = (): 'light' | 'dark' => {
  return isDarkMode() ? 'dark' : 'light';
};

/**
 * 主题切换动画类
 */
export const getThemeTransitionClasses = () => {
  return 'transition-colors duration-200 ease-in-out';
};
