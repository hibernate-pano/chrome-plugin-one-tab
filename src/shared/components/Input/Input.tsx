/**
 * 输入框组件
 * 支持多种类型、状态和装饰
 */
import React, { forwardRef } from 'react';
import { cn } from '@/shared/utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  variant?: 'default' | 'filled' | 'flushed';
  inputSize?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  className,
  type = 'text',
  label,
  description,
  error,
  leftIcon,
  rightIcon,
  leftAddon,
  rightAddon,
  variant = 'default',
  inputSize = 'md',
  fullWidth = true,
  disabled,
  ...props
}, ref) => {
  const baseInputStyles = [
    'flex w-full border transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-500 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
    'dark:placeholder:text-gray-400',
  ];

  const variants = {
    default: [
      'rounded-md border-gray-300 bg-white focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20',
      'dark:border-gray-600 dark:bg-gray-800 dark:focus-visible:border-blue-400',
    ],
    filled: [
      'rounded-md border-transparent bg-gray-100 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20',
      'dark:bg-gray-700 dark:focus-visible:border-blue-400',
    ],
    flushed: [
      'rounded-none border-x-0 border-t-0 border-b-2 border-gray-300 bg-transparent px-0 focus-visible:border-blue-500 focus-visible:ring-0',
      'dark:border-gray-600 dark:focus-visible:border-blue-400',
    ],
  };

  const sizes = {
    sm: 'h-8 px-3 text-sm',
    md: 'h-10 px-3 text-sm',
    lg: 'h-12 px-4 text-base',
  };

  const inputClasses = cn(
    baseInputStyles,
    variants[variant],
    sizes[inputSize],
    error && 'border-red-500 focus-visible:border-red-500 focus-visible:ring-red-500/20',
    leftIcon && 'pl-10',
    rightIcon && 'pr-10',
    leftAddon && 'rounded-l-none',
    rightAddon && 'rounded-r-none',
    className
  );

  const wrapperClasses = cn(
    'relative',
    fullWidth ? 'w-full' : 'w-auto'
  );

  return (
    <div className={wrapperClasses}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {label}
        </label>
      )}
      
      <div className="relative flex">
        {leftAddon && (
          <div className="inline-flex items-center rounded-l-md border border-r-0 border-gray-300 bg-gray-50 px-3 text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400">
            {leftAddon}
          </div>
        )}
        
        <div className="relative flex-1">
          {leftIcon && (
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
              {leftIcon}
            </div>
          )}
          
          <input
            ref={ref}
            type={type}
            className={inputClasses}
            disabled={disabled}
            {...props}
          />
          
          {rightIcon && (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400">
              {rightIcon}
            </div>
          )}
        </div>
        
        {rightAddon && (
          <div className="inline-flex items-center rounded-r-md border border-l-0 border-gray-300 bg-gray-50 px-3 text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400">
            {rightAddon}
          </div>
        )}
      </div>
      
      {description && !error && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
});

Input.displayName = 'Input';

export { Input };