import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

// 默认图标 - 更精致的设计
const DefaultIcon = () => (
  <svg
    className="w-8 h-8 empty-state-default-icon"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
    />
  </svg>
);

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
  return (
    <div className={`empty-state animate-in ${className}`}>
      {/* 图标容器 */}
      <div className="empty-state-icon">
        {icon || <DefaultIcon />}
      </div>

      {/* 标题 */}
      <h3 className="empty-state-title">{title}</h3>

      {/* 描述 */}
      {description && (
        <p className="empty-state-description">
          {description}
        </p>
      )}

      {/* 操作按钮 */}
      {action && (
        <div className="mt-6">
          {action}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
