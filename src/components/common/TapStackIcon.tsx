import React from 'react';

interface TapStackIconProps {
  size?: number;
  className?: string;
  variant?: 'default' | 'gradient' | 'outline';
}

/**
 * TapStack 品牌图标组件
 *
 * 构型：「收拢的现场」——三张错位层叠的卡片，散落的标签页被收拢成一叠会话。
 * 与扩展图标（icons/icon128.png）同构：蓝底白卡 + 折角 + 内容条；
 * 应用内为单色 currentColor 版本，随主题着色。
 */
export const TapStackIcon: React.FC<TapStackIconProps> = ({
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
      {/* 三层错位卡片：从左上（远）到右下（近） */}
      <rect x="5.9" y="5.6" width="11.25" height="7.9" rx="1.7" fill="currentColor" opacity=".35" />
      <rect x="6.4" y="8" width="11.25" height="7.9" rx="1.7" fill="currentColor" opacity=".6" />
      <rect x="7" y="10.4" width="11.25" height="7.9" rx="1.7" fill="currentColor" />
    </svg>
  );
};

/**
 * TapStack 文字Logo组件
 * 精致简约风格
 */
export const TapStackLogo: React.FC<{
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
        <TapStackIcon
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
          TapStack
        </span>
      </div>
    </div>
  );
};

export default TapStackIcon;
