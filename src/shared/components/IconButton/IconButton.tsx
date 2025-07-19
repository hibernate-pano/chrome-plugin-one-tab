/**
 * 图标按钮组件
 * 专门用于只包含图标的按钮
 */

import React, { forwardRef } from 'react';
import { cn } from '@/shared/utils/cn';
import { getIconButtonStyles, ButtonVariant, ButtonSize, ButtonRounded } from '@/shared/utils/buttonStyles';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  rounded?: ButtonRounded;
  loading?: boolean;
  icon: React.ReactNode;
  'aria-label': string; // 必需的无障碍标签
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(({
  className,
  variant = 'ghost',
  size = 'md',
  rounded = 'md',
  loading = false,
  icon,
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
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };

  return (
    <button
      ref={ref}
      className={getIconButtonStyles({
        variant,
        size,
        rounded,
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
});

IconButton.displayName = 'IconButton';

export { IconButton };
export default IconButton;
