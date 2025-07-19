/**
 * 空状态组件
 * 提供吸引人的空状态界面，包含动画和交互元素
 */

import React, { useState, useEffect } from 'react';
import { cn } from '@/shared/utils/cn';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
  icon?: React.ReactNode;
}

export interface EmptyStateProps {
  title: string;
  description: string;
  illustration?: 'tabs' | 'search' | 'sync' | 'error' | 'custom';
  customIllustration?: React.ReactNode;
  actions?: EmptyStateAction[];
  animated?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  illustration = 'tabs',
  customIllustration,
  actions = [],
  animated = true,
  size = 'md',
  className,
}) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (animated) {
      const timer = setTimeout(() => setIsVisible(true), 100);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(true);
    }
  }, [animated]);

  const sizeClasses = {
    sm: 'py-8 space-y-3',
    md: 'py-12 space-y-4',
    lg: 'py-16 space-y-6',
  };

  const iconSizes = {
    sm: 'h-12 w-12',
    md: 'h-16 w-16',
    lg: 'h-20 w-20',
  };

  const renderIllustration = () => {
    if (customIllustration) {
      return customIllustration;
    }

    const iconClass = cn(
      iconSizes[size],
      'text-gray-400 dark:text-gray-500',
      animated && 'transition-all duration-700 ease-out',
      isVisible ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
    );

    switch (illustration) {
      case 'tabs':
        return (
          <div className="relative">
            <svg
              className={iconClass}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
              />
            </svg>
            {animated && (
              <div className="absolute -top-1 -right-1">
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
              </div>
            )}
          </div>
        );

      case 'search':
        return (
          <svg
            className={iconClass}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        );

      case 'sync':
        return (
          <svg
            className={cn(iconClass, animated && isVisible && 'animate-spin')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        );

      case 'error':
        return (
          <svg
            className={iconClass}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        );

      default:
        return (
          <div className={cn(
            'rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center',
            iconSizes[size],
            animated && 'transition-all duration-700 ease-out',
            isVisible ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
          )}>
            <svg
              className="h-8 w-8 text-gray-400 dark:text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
              />
            </svg>
          </div>
        );
    }
  };

  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center',
      sizeClasses[size],
      className
    )}>
      {/* 插图 */}
      <div className="mb-4">
        {renderIllustration()}
      </div>

      {/* 标题 */}
      <h3 className={cn(
        'font-semibold text-gray-900 dark:text-gray-100',
        size === 'sm' ? 'text-base' : size === 'md' ? 'text-lg' : 'text-xl',
        animated && 'transition-all duration-700 ease-out delay-200',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
      )}>
        {title}
      </h3>

      {/* 描述 */}
      <p className={cn(
        'text-gray-500 dark:text-gray-400 max-w-md',
        size === 'sm' ? 'text-sm' : 'text-base',
        animated && 'transition-all duration-700 ease-out delay-300',
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
      )}>
        {description}
      </p>

      {/* 操作按钮 */}
      {actions.length > 0 && (
        <div className={cn(
          'flex flex-col sm:flex-row gap-3 mt-6',
          animated && 'transition-all duration-700 ease-out delay-500',
          isVisible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
        )}>
          {actions.map((action, index) => (
            <button
              key={index}
              onClick={action.onClick}
              className={cn(
                'inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2',
                action.variant === 'secondary'
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-500 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  : 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
              )}
            >
              {action.icon && (
                <span className="mr-2 flex-shrink-0">
                  {action.icon}
                </span>
              )}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export { EmptyState };
export default EmptyState;
