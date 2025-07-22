/**
 * 统一的状态卡片组件
 * 基于空标签页面的设计规范，提供一致的状态展示样式
 */

import React from 'react';
import { cn } from '@/shared/utils/cn';
import { Icon } from '../Icon/Icon';

export interface StatusCardProps {
  type?: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
  icon?: string;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

const StatusCard: React.FC<StatusCardProps> = ({
  type = 'info',
  title,
  description,
  icon,
  action,
  className,
  children,
}) => {
  const typeStyles = {
    info: {
      container: 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800',
      icon: 'text-blue-600 dark:text-blue-400',
      title: 'text-blue-800 dark:text-blue-200',
      description: 'text-blue-700 dark:text-blue-300',
    },
    success: {
      container: 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800',
      icon: 'text-green-600 dark:text-green-400',
      title: 'text-green-800 dark:text-green-200',
      description: 'text-green-700 dark:text-green-300',
    },
    warning: {
      container: 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800',
      icon: 'text-amber-600 dark:text-amber-400',
      title: 'text-amber-800 dark:text-amber-200',
      description: 'text-amber-700 dark:text-amber-300',
    },
    error: {
      container: 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800',
      icon: 'text-red-600 dark:text-red-400',
      title: 'text-red-800 dark:text-red-200',
      description: 'text-red-700 dark:text-red-300',
    },
  };

  const defaultIcons = {
    info: 'info',
    success: 'check',
    warning: 'warning',
    error: 'close',
  };

  const styles = typeStyles[type];
  const iconName = icon || defaultIcons[type];

  return (
    <div className={cn('rounded-lg p-4', styles.container, className)}>
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <Icon
            name={iconName}
            size="md"
            className={cn('mt-0.5', styles.icon)}
          />
        </div>
        <div className="ml-3 flex-1">
          <h4 className={cn('text-sm font-medium', styles.title)}>
            {title}
          </h4>
          {description && (
            <p className={cn('text-sm mt-1', styles.description)}>
              {description}
            </p>
          )}
          {children && (
            <div className="mt-2">
              {children}
            </div>
          )}
          {action && (
            <div className="mt-3">
              {action}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export { StatusCard };
export default StatusCard;
