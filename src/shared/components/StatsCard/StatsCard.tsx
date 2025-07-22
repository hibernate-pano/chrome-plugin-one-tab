/**
 * 统一的统计卡片组件
 * 基于空标签页面的设计规范，提供一致的统计数据展示样式
 */

import React from 'react';
import { cn } from '@/shared/utils/cn';

export interface StatsCardProps {
  value: string | number;
  label: string;
  color?: 'blue' | 'green' | 'purple' | 'yellow' | 'red';
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

export interface StatsGridProps {
  children: React.ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({
  value,
  label,
  color = 'blue',
  trend,
  className,
}) => {
  const colorStyles = {
    blue: 'text-blue-600 dark:text-blue-400',
    green: 'text-green-600 dark:text-green-400',
    purple: 'text-purple-600 dark:text-purple-400',
    yellow: 'text-yellow-600 dark:text-yellow-400',
    red: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className={cn('text-center', className)}>
      <div className={cn('text-2xl font-bold', colorStyles[color])}>
        {value}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {label}
      </div>
      {trend && (
        <div className={cn(
          'text-xs mt-1',
          trend.isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        )}>
          {trend.isPositive ? '+' : ''}{trend.value}%
        </div>
      )}
    </div>
  );
};

const StatsGrid: React.FC<StatsGridProps> = ({
  children,
  columns = 3,
  className,
}) => {
  const gridClasses = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
  };

  return (
    <div className={cn(
      'grid gap-4 max-w-sm mx-auto',
      gridClasses[columns],
      className
    )}>
      {children}
    </div>
  );
};

export { StatsCard, StatsGrid };
export default StatsCard;
