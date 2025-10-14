import React from 'react';

interface TabVaultIconProps {
  size?: number;
  className?: string;
  variant?: 'default' | 'gradient' | 'outline';
}

/**
 * TabVault Pro 品牌图标组件
 * 提供独特的视觉识别
 */
export const TabVaultIcon: React.FC<TabVaultIconProps> = ({ 
  size = 24, 
  className = '',
  variant = 'default'
}) => {
  const baseClasses = className;
  
  const getVariantClasses = () => {
    switch (variant) {
      case 'gradient':
        return 'text-blue-600 dark:text-blue-400';
      case 'outline':
        return 'text-gray-600 dark:text-gray-300';
      default:
        return 'text-blue-600 dark:text-blue-400';
    }
  };

  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      className={`${baseClasses} ${getVariantClasses()}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 主容器 */}
      <rect 
        x="3" 
        y="3" 
        width="18" 
        height="18" 
        rx="4" 
        stroke="currentColor" 
        strokeWidth="2"
        fill="none"
      />
      
      {/* 标签页线条 */}
      <path 
        d="M7 8h10M7 12h10M7 16h10" 
        stroke="currentColor" 
        strokeWidth="1.5" 
        strokeLinecap="round"
      />
      
      {/* 标签页指示器 */}
      <circle cx="9" cy="8" r="1.5" fill="currentColor" />
      <circle cx="9" cy="12" r="1.5" fill="currentColor" />
      <circle cx="9" cy="16" r="1.5" fill="currentColor" />
      
      {/* 装饰性元素 */}
      <path 
        d="M15 8l2 2-2 2M15 12l2 2-2 2" 
        stroke="currentColor" 
        strokeWidth="1" 
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
};

/**
 * TabVault Pro 文字Logo组件
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
        return 'text-lg';
      case 'lg':
        return 'text-2xl';
      default:
        return 'text-xl';
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
    <div className={`flex items-center space-x-2 ${className}`}>
      {showIcon && (
        <TabVaultIcon 
          size={getIconSize()} 
          variant="gradient"
          className="flex-shrink-0"
        />
      )}
      <div className="flex flex-col">
        <span className={`font-bold text-blue-600 dark:text-blue-400 ${getSizeClasses()}`}>
          TabVault
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
          Pro
        </span>
      </div>
    </div>
  );
};

export default TabVaultIcon;
