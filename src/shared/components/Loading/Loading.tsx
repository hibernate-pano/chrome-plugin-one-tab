/**
 * 加载状态组件
 * 提供多种加载动画和骨架屏
 */
import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface LoadingProps {
  variant?: 'spinner' | 'dots' | 'pulse' | 'skeleton';
  size?: 'sm' | 'md' | 'lg';
  color?: 'primary' | 'secondary' | 'current';
  text?: string;
  className?: string;
}

const Loading: React.FC<LoadingProps> = ({
  variant = 'spinner',
  size = 'md',
  color = 'primary',
  text,
  className,
}) => {
  const sizes = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  const colors = {
    primary: 'text-blue-600',
    secondary: 'text-gray-600',
    current: 'text-current',
  };

  const baseClasses = cn(sizes[size], colors[color], className);

  const renderSpinner = () => (
    <svg
      className={cn(baseClasses, 'animate-spin')}
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

  const renderDots = () => {
    const dotSize = {
      sm: 'h-1 w-1',
      md: 'h-1.5 w-1.5',
      lg: 'h-2 w-2',
    };

    return (
      <div className={cn('flex space-x-1', className)}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn(
              dotSize[size],
              colors[color],
              'animate-pulse rounded-full bg-current'
            )}
            style={{
              animationDelay: `${i * 0.2}s`,
              animationDuration: '1s',
            }}
          />
        ))}
      </div>
    );
  };

  const renderPulse = () => (
    <div
      className={cn(
        baseClasses,
        'animate-pulse rounded-full bg-current opacity-75'
      )}
    />
  );

  const renderSkeleton = () => (
    <div className={cn('animate-pulse space-y-2', className)}>
      <div className="h-4 bg-gray-300 rounded dark:bg-gray-600" />
      <div className="h-4 bg-gray-300 rounded w-5/6 dark:bg-gray-600" />
      <div className="h-4 bg-gray-300 rounded w-4/6 dark:bg-gray-600" />
    </div>
  );

  const renderVariant = () => {
    switch (variant) {
      case 'dots':
        return renderDots();
      case 'pulse':
        return renderPulse();
      case 'skeleton':
        return renderSkeleton();
      default:
        return renderSpinner();
    }
  };

  if (text) {
    return (
      <div className={cn('flex items-center space-x-2', className)}>
        {renderVariant()}
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {text}
        </span>
      </div>
    );
  }

  return renderVariant();
};

export { Loading };