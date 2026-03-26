import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  tone?: 'default' | 'search' | 'warning';
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
  className = '',
  tone = 'default',
}) => {
  const toneStyles = {
    default: {
      shell: 'border-gray-200/80 bg-white/90 dark:border-gray-700/80 dark:bg-gray-900/80',
      icon: 'bg-primary-500/10 text-primary-600 dark:bg-primary-400/10 dark:text-primary-300',
    },
    search: {
      shell: 'border-sky-200/80 bg-sky-50/80 dark:border-sky-900/50 dark:bg-sky-950/20',
      icon: 'bg-sky-500/10 text-sky-600 dark:bg-sky-400/10 dark:text-sky-300',
    },
    warning: {
      shell: 'border-amber-200/80 bg-amber-50/80 dark:border-amber-900/50 dark:bg-amber-950/20',
      icon: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
    },
  }[tone];

  return (
    <div className={`animate-in rounded-[28px] border px-6 py-8 text-center shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur-sm ${toneStyles.shell} ${className}`}>
      <div className={`mx-auto inline-flex h-16 w-16 items-center justify-center rounded-2xl ${toneStyles.icon}`}>
        {icon || <DefaultIcon />}
      </div>

      <h3 className="mt-5 text-lg font-semibold tracking-tight text-gray-950 dark:text-gray-50">{title}</h3>

      {description && (
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-600 dark:text-gray-300">
          {description}
        </p>
      )}

      {action && (
        <div className="mt-6 flex justify-center">
          {action}
        </div>
      )}
    </div>
  );
};

export default EmptyState;
