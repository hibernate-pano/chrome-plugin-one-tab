import React from 'react';

interface SkeletonProps {
  variant?: 'text' | 'rectangle' | 'circle';
  width?: string | number;
  height?: string | number;
  className?: string;
}

/**
 * 骨架屏组件 - 用于加载状态
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'rectangle',
  width,
  height,
  className = '',
}) => {
  const getVariantClasses = () => {
    switch (variant) {
      case 'text':
        return 'rounded h-4';
      case 'circle':
        return 'rounded-full';
      case 'rectangle':
      default:
        return 'rounded-lg';
    }
  };

  const style: React.CSSProperties = {
    width: width || '100%',
    height: height || (variant === 'text' ? '1rem' : '3rem'),
  };

  return (
    <div
      className={`skeleton ${getVariantClasses()} ${className}`}
      style={style}
      aria-busy="true"
      aria-live="polite"
    />
  );
};

/**
 * 标签组骨架屏
 */
export const TabGroupSkeleton: React.FC = () => {
  return (
    <div className="flat-card p-4 space-y-3">
      {/* 标签组头部 */}
      <div className="flex items-center justify-between">
        <Skeleton variant="text" width="30%" height="1.25rem" />
        <div className="flex space-x-2">
          <Skeleton variant="circle" width="2rem" height="2rem" />
          <Skeleton variant="circle" width="2rem" height="2rem" />
        </div>
      </div>

      {/* 标签列表 */}
      <div className="space-y-2">
        <Skeleton variant="rectangle" height="2.5rem" />
        <Skeleton variant="rectangle" height="2.5rem" />
        <Skeleton variant="rectangle" height="2.5rem" />
      </div>
    </div>
  );
};

/**
 * 标签列表骨架屏
 */
export const TabListSkeleton: React.FC<{ count?: number }> = ({ count = 3 }) => {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, index) => (
        <TabGroupSkeleton key={index} />
      ))}
    </div>
  );
};
