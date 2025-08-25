/**
 * 通用按钮组件
 * 支持多种变体、大小和状态，符合设计系统规范
 */
import React, { forwardRef } from 'react';
import { cn } from '@/shared/utils/cn';
import { designTokens } from '@/shared/design/tokens';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline' | 'success' | 'warning';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  loadingText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingText,
  leftIcon,
  rightIcon,
  fullWidth = false,
  rounded = 'md',
  disabled,
  children,
  ...props
}, ref) => {
  const baseStyles = [
    'inline-flex items-center justify-center gap-2 font-medium transition-all duration-300 ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:scale-98 hover:shadow-md',
  ];

  const variants = {
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

  const sizes = {
    sm: 'h-8 px-3 text-sm min-w-[64px]',
    md: 'h-10 px-4 text-sm min-w-[80px]',
    lg: 'h-12 px-6 text-base min-w-[96px]',
  };

  const roundedStyles = {
    sm: 'rounded-sm',
    md: 'rounded-md',
    lg: 'rounded-lg',
    full: 'rounded-full',
  };

  const isDisabled = disabled || loading;

  const renderLoadingSpinner = () => (
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
  );

  const renderContent = () => {
    if (loading) {
      return (
        <>
          {renderLoadingSpinner()}
          {loadingText || children}
        </>
      );
    }

    return (
      <>
        {leftIcon && <span className="flex-shrink-0">{leftIcon}</span>}
        <span className="truncate">{children}</span>
        {rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
      </>
    );
  };

  return (
    <button
      ref={ref}
      className={cn(
        baseStyles,
        variants[variant],
        sizes[size],
        roundedStyles[rounded],
        fullWidth && 'w-full',
        loading && 'cursor-wait',
        className
      )}
      disabled={isDisabled}
      {...props}
    >
      {renderContent()}
    </button>
  );
});

Button.displayName = 'Button';

export { Button };