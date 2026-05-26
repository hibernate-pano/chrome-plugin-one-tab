import React from 'react';

interface TabStackIconProps {
  size?: number;
  className?: string;
  variant?: 'default' | 'gradient' | 'outline';
}

/**
 * TabStack 品牌图标组件
 * 叠层标签设计，传达"工作栈"概念
 */
export const TabStackIcon: React.FC<TabStackIconProps> = ({
  size = 24,
  className = '',
  variant = 'default'
}) => {
  const getFill = () => {
    switch (variant) {
      case 'gradient':
        return 'url(#tabstack-grad)';
      case 'outline':
        return 'none';
      default:
        return 'currentColor';
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {variant === 'gradient' && (
        <defs>
          <linearGradient id="tabstack-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4F8EF7" />
            <stop offset="100%" stopColor="#2C5DC3" />
          </linearGradient>
        </defs>
      )}
      {/* Back tab (left) */}
      <rect x="4" y="6" width="12" height="9" rx="2.5"
            fill={variant === 'default' ? '#E8F0FE' : 'none'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeOpacity={variant === 'default' ? 0.5 : 1}/>
      {/* Back tab (right) */}
      <rect x="8" y="10" width="12" height="9" rx="2.5"
            fill={variant === 'default' ? '#D0E2FD' : 'none'}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeOpacity={variant === 'default' ? 0.7 : 1}/>
      {/* Front tab (main) */}
      <rect x="12" y="14" width="12" height="9" rx="2.5"
            fill={getFill()}
            stroke="currentColor"
            strokeWidth="1.5"/>
    </svg>
  );
};

/**
 * TabStack 文字Logo组件
 * 简洁有力
 */
export const TabStackLogo: React.FC<{
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
        <TabStackIcon
          size={getIconSize()}
          variant="gradient"
          className="flex-shrink-0"
        />
      )}
      <span
        className={`font-bold tracking-tight ${getSizeClasses()}`}
        style={{ color: 'var(--color-text-primary)' }}
      >
        TabStack
      </span>
    </div>
  );
};

export default TabStackIcon;