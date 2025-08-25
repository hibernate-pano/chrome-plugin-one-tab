/**
 * 浮动操作按钮组件 (FAB)
 * 用于主要操作的浮动按钮
 */

import React, { forwardRef } from 'react';
import { cn } from '@/shared/utils/cn';
import { getFabStyles, ButtonVariant, ButtonSize } from '@/shared/utils/buttonStyles';

export interface FloatingActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon: React.ReactNode;
  label?: string;
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'static';
  'aria-label': string;
}

const FloatingActionButton = forwardRef<HTMLButtonElement, FloatingActionButtonProps>(({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  label,
  position = 'static',
  disabled,
  'aria-label': ariaLabel,
  ...props
}, ref) => {
  const isDisabled = disabled || loading;

  const renderLoadingSpinner = () => (
    <svg
      className="animate-spin"
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

  const iconSizes = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  const positionStyles = {
    'bottom-right': 'fixed bottom-6 right-6 z-50',
    'bottom-left': 'fixed bottom-6 left-6 z-50',
    'top-right': 'fixed top-6 right-6 z-50',
    'top-left': 'fixed top-6 left-6 z-50',
    'static': '',
  };

  const fabContent = (
    <button
      ref={ref}
      className={getFabStyles({
        variant,
        size,
        loading,
        disabled: isDisabled,
        className,
      })}
      disabled={isDisabled}
      aria-label={ariaLabel}
      {...props}
    >
      <span className={cn(iconSizes[size], 'flex-shrink-0')}>
        {loading ? renderLoadingSpinner() : icon}
      </span>
    </button>
  );

  // 如果有标签，包装在一个容器中
  if (label) {
    return (
      <div className={cn('flex items-center gap-3', positionStyles[position])}>
        {position.includes('right') && (
          <span className="bg-gray-900 text-white px-3 py-1 rounded-lg text-sm font-medium shadow-lg">
            {label}
          </span>
        )}
        {fabContent}
        {position.includes('left') && (
          <span className="bg-gray-900 text-white px-3 py-1 rounded-lg text-sm font-medium shadow-lg">
            {label}
          </span>
        )}
      </div>
    );
  }

  // 如果是静态位置，直接返回按钮
  if (position === 'static') {
    return fabContent;
  }

  // 固定位置的按钮
  return (
    <div className={positionStyles[position]}>
      {fabContent}
    </div>
  );
});

FloatingActionButton.displayName = 'FloatingActionButton';

export { FloatingActionButton };
export default FloatingActionButton;
