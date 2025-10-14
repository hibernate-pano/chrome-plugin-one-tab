import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * 空状态组件
 * 用于显示没有数据时的状态
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className = ''
}) => {
  const defaultIcon = (
    <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-10 w-10 text-gray-400 dark:text-gray-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 6v6m0 0v6m0-6h6m-6 0H6"
        />
      </svg>
    </div>
  );

  return (
    <div className={`flex flex-col items-center justify-center py-8 space-y-3 text-gray-500 dark:text-gray-400 ${className}`}>
      {icon || defaultIcon}
      <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300">{title}</h3>
      {description && (
        <p className="text-gray-500 dark:text-gray-400 max-w-md text-center text-sm">
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4">
          {action}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
