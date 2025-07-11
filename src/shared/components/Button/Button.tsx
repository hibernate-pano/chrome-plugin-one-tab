/**
 * 通用按钮组件
 * 支持多种变体、大小和状态
 */
import React, { forwardRef } from 'react';
import { cn } from '@/shared/utils/cn';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth = false,
  disabled,
  children,
  ...props
}, ref) => {
  const baseStyles = [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  ];

  const variants = {
    primary: [
      'bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-500',
    ],
    secondary: [
      'bg-gray-100 text-gray-900 hover:bg-gray-200 focus-visible:ring-gray-500',
      'dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700',
    ],
    ghost: [
      'text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-500',
      'dark:text-gray-300 dark:hover:bg-gray-800',
    ],
    destructive: [
      'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500',
    ],
    outline: [
      'border border-gray-300 bg-transparent text-gray-700 hover:bg-gray-50 focus-visible:ring-gray-500',
      'dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800',
    ],
  };

  const sizes = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-10 px-4 text-sm',
    lg: 'h-12 px-6 text-base',
  };

  const classes = cn(
    baseStyles,
    variants[variant],
    sizes[size],
    fullWidth && 'w-full',
    className
  );

  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      className={classes}
      disabled={isDisabled}
      {...props}
    >
      {loading && (
        <svg
          className="h-4 w-4 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      )}
      {!loading && leftIcon && leftIcon}
      {children}
      {!loading && rightIcon && rightIcon}
    </button>
  );
});

Button.displayName = 'Button';

export { Button };