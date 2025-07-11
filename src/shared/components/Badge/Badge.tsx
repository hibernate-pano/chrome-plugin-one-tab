/**
 * 徽章组件
 * 显示状态、数量或标签的小型指示器
 */
import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  rounded?: boolean;
  dot?: boolean;
}

const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'default',
  size = 'md',
  rounded = false,
  dot = false,
  children,
  ...props
}) => {
  const baseStyles = [
    'inline-flex items-center font-medium',
    dot ? 'justify-center' : 'px-2.5 py-0.5',
  ];

  const variants = {
    default: [
      'bg-gray-100 text-gray-800',
      'dark:bg-gray-800 dark:text-gray-200',
    ],
    primary: [
      'bg-blue-100 text-blue-800',
      'dark:bg-blue-900/50 dark:text-blue-400',
    ],
    secondary: [
      'bg-purple-100 text-purple-800',
      'dark:bg-purple-900/50 dark:text-purple-400',
    ],
    success: [
      'bg-green-100 text-green-800',
      'dark:bg-green-900/50 dark:text-green-400',
    ],
    warning: [
      'bg-yellow-100 text-yellow-800',
      'dark:bg-yellow-900/50 dark:text-yellow-400',
    ],
    error: [
      'bg-red-100 text-red-800',
      'dark:bg-red-900/50 dark:text-red-400',
    ],
    outline: [
      'border border-gray-300 bg-transparent text-gray-700',
      'dark:border-gray-600 dark:text-gray-300',
    ],
  };

  const sizes = {
    sm: dot ? 'h-2 w-2' : 'text-xs',
    md: dot ? 'h-2.5 w-2.5' : 'text-xs',
    lg: dot ? 'h-3 w-3' : 'text-sm',
  };

  const roundedStyles = rounded || dot ? 'rounded-full' : 'rounded';

  const classes = cn(
    baseStyles,
    variants[variant],
    sizes[size],
    roundedStyles,
    className
  );

  if (dot) {
    return <span className={classes} {...props} />;
  }

  return (
    <span className={classes} {...props}>
      {children}
    </span>
  );
};

export { Badge };