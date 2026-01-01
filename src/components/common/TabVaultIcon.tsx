import React from 'react';

interface TabVaultIconProps {
  size?: number;
  className?: string;
  variant?: 'default' | 'gradient' | 'outline';
}

/**
 * TabVault Pro 品牌图标组件
 * 现代简约风格
 */
export const TabVaultIcon: React.FC<TabVaultIconProps> = ({
  size = 24,
  className = '',
  variant = 'default'
}) => {
  const getVariantClasses = () => {
    switch (variant) {
      case 'gradient':
        return 'text-accent-600 dark:text-accent-400';
      case 'outline':
        return 'text-neutral-600 dark:text-neutral-300';
      default:
        return 'text-accent-600 dark:text-accent-400';
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`${className} ${getVariantClasses()}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 圆角矩形容器 */}
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
      />

      {/* 简洁的标签页指示器 */}
      <rect x="7" y="7" width="10" height="2" rx="1" fill="currentColor" />
      <rect x="7" y="11" width="7" height="2" rx="1" fill="currentColor" opacity="0.6" />
      <rect x="7" y="15" width="5" height="2" rx="1" fill="currentColor" opacity="0.3" />
    </svg>
  );
};

/**
 * TabVault Pro 文字Logo组件
 * 精致简约风格
 */
export const TabVaultLogo: React.FC<{
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  showIcon?: boolean;
}> = ({
  size = 'md',
  className = '',
  showIcon = true
}) => {
  const getSizeClasses = () => {
    switch (size) {
      case 'sm':
        return 'text-base';
      case 'lg':
        return 'text-xl';
      default:
        return 'text-lg';
    }
  };

  const getIconSize = () => {
    switch (size) {
      case 'sm':
        return 20;
      case 'lg':
        return 28;
      default:
        return 24;
    }
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showIcon && (
        <TabVaultIcon
          size={getIconSize()}
          variant="gradient"
          className="flex-shrink-0"
        />
      )}
      <div className="flex items-baseline gap-0.5">
        <span
          className={`font-semibold tracking-tight ${getSizeClasses()}`}
          style={{ color: 'var(--color-text-primary)' }}
        >
          TabVault
        </span>
        <span
          className="text-xs font-medium px-1.5 py-0.5 rounded-md"
          style={{
            background: 'var(--color-accent-subtle)',
            color: 'var(--color-accent)'
          }}
        >
          Pro
        </span>
      </div>
    </div>
  );
};

export default TabVaultIcon;
