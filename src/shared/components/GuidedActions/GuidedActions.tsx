/**
 * 引导性操作组件
 * 为用户提供明确的下一步操作指引
 */

import React, { useState, useEffect } from 'react';
import { cn } from '@/shared/utils/cn';

export interface GuidedAction {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'success' | 'info';
  disabled?: boolean;
  badge?: string;
  shortcut?: string;
}

export interface GuidedActionsProps {
  title?: string;
  description?: string;
  actions: GuidedAction[];
  layout?: 'grid' | 'list';
  animated?: boolean;
  className?: string;
}

const GuidedActions: React.FC<GuidedActionsProps> = ({
  title,
  description,
  actions,
  layout = 'grid',
  animated = true,
  className,
}) => {
  const [visibleActions, setVisibleActions] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (animated) {
      actions.forEach((action, index) => {
        setTimeout(() => {
          setVisibleActions(prev => new Set(prev).add(action.id));
        }, index * 150);
      });
    } else {
      setVisibleActions(new Set(actions.map(action => action.id)));
    }
  }, [actions, animated]);

  const getVariantClasses = (variant: GuidedAction['variant'] = 'primary') => {
    switch (variant) {
      case 'primary':
        return 'bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-900 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 dark:border-blue-800 dark:text-blue-100';
      case 'secondary':
        return 'bg-gray-50 hover:bg-gray-100 border-gray-200 text-gray-900 dark:bg-gray-800 dark:hover:bg-gray-700 dark:border-gray-700 dark:text-gray-100';
      case 'success':
        return 'bg-green-50 hover:bg-green-100 border-green-200 text-green-900 dark:bg-green-900/20 dark:hover:bg-green-900/30 dark:border-green-800 dark:text-green-100';
      case 'info':
        return 'bg-purple-50 hover:bg-purple-100 border-purple-200 text-purple-900 dark:bg-purple-900/20 dark:hover:bg-purple-900/30 dark:border-purple-800 dark:text-purple-100';
      default:
        return 'bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-900 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 dark:border-blue-800 dark:text-blue-100';
    }
  };

  const renderAction = (action: GuidedAction, index: number) => {
    const isVisible = visibleActions.has(action.id);
    
    return (
      <button
        key={action.id}
        onClick={action.onClick}
        disabled={action.disabled}
        className={cn(
          'relative p-4 rounded-lg border-2 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 group',
          getVariantClasses(action.variant),
          action.disabled && 'opacity-50 cursor-not-allowed',
          layout === 'list' ? 'flex items-start space-x-4 text-left' : 'text-center',
          animated && 'transform',
          isVisible ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-4 opacity-0 scale-95'
        )}
      >
        {/* 徽章 */}
        {action.badge && (
          <div className="absolute -top-2 -right-2 bg-red-500 text-white text-xs px-2 py-1 rounded-full">
            {action.badge}
          </div>
        )}

        {/* 图标 */}
        <div className={cn(
          'flex-shrink-0',
          layout === 'list' ? 'mt-1' : 'mx-auto mb-3'
        )}>
          <div className={cn(
            'flex items-center justify-center rounded-lg transition-transform group-hover:scale-110',
            layout === 'list' ? 'w-10 h-10' : 'w-12 h-12',
            action.variant === 'primary' ? 'bg-blue-100 text-blue-600 dark:bg-blue-800 dark:text-blue-300' :
            action.variant === 'success' ? 'bg-green-100 text-green-600 dark:bg-green-800 dark:text-green-300' :
            action.variant === 'info' ? 'bg-purple-100 text-purple-600 dark:bg-purple-800 dark:text-purple-300' :
            'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
          )}>
            {action.icon}
          </div>
        </div>

        {/* 内容 */}
        <div className={cn(layout === 'list' ? 'flex-1' : '')}>
          <h3 className={cn(
            'font-semibold',
            layout === 'list' ? 'text-base' : 'text-lg'
          )}>
            {action.title}
          </h3>
          <p className={cn(
            'text-sm opacity-80 mt-1',
            layout === 'list' ? 'text-left' : 'text-center'
          )}>
            {action.description}
          </p>

          {/* 快捷键 */}
          {action.shortcut && (
            <div className="mt-2">
              <kbd className="px-2 py-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded shadow-sm">
                {action.shortcut}
              </kbd>
            </div>
          )}
        </div>

        {/* 箭头指示器（仅在列表布局中显示） */}
        {layout === 'list' && (
          <div className="flex-shrink-0 ml-4">
            <svg
              className="w-5 h-5 opacity-50 group-hover:opacity-100 transition-opacity"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        )}
      </button>
    );
  };

  return (
    <div className={cn('space-y-6', className)}>
      {/* 标题和描述 */}
      {(title || description) && (
        <div className="text-center">
          {title && (
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {title}
            </h2>
          )}
          {description && (
            <p className="text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              {description}
            </p>
          )}
        </div>
      )}

      {/* 操作列表 */}
      <div className={cn(
        layout === 'grid' 
          ? 'grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
          : 'space-y-3'
      )}>
        {actions.map((action, index) => renderAction(action, index))}
      </div>
    </div>
  );
};

export { GuidedActions };
export default GuidedActions;
