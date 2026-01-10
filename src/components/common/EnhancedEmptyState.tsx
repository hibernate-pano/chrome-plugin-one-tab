import React from 'react';

interface EnhancedEmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
  tips?: string[];
  variant?: 'default' | 'search' | 'error' | 'success';
  className?: string;
}

export const EnhancedEmptyState: React.FC<EnhancedEmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  tips,
  variant = 'default',
  className = '',
}) => {
  const getVariantStyles = () => {
    switch (variant) {
      case 'search':
        return 'bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900';
      case 'error':
        return 'bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-900/20 dark:to-orange-900/20';
      case 'success':
        return 'bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20';
      default:
        return 'bg-gradient-to-br from-gray-50 to-slate-50 dark:from-gray-800 dark:to-slate-900';
    }
  };

  const getDefaultIcon = () => {
    switch (variant) {
      case 'search':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        );
      case 'error':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        );
      case 'success':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
      default:
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-16 w-16"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
        );
    }
  };

  return (
    <div
      className={`flex flex-col items-center justify-center py-16 px-4 ${getVariantStyles()} ${className}`}
    >
      <div className="text-gray-400 dark:text-gray-600 mb-6 animate-fade-in">
        {icon || getDefaultIcon()}
      </div>

      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2 animate-slide-up">
        {title}
      </h3>

      <p
        className="text-gray-600 dark:text-gray-400 text-center max-w-md mb-6 animate-slide-up"
        style={{ animationDelay: '50ms' }}
      >
        {description}
      </p>

      {action && (
        <div className="animate-slide-up" style={{ animationDelay: '100ms' }}>
          {action}
        </div>
      )}

      {tips && tips.length > 0 && (
        <div className="mt-8 animate-slide-up" style={{ animationDelay: '150ms' }}>
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">小提示：</div>
          <ul className="space-y-2">
            {tips.map((tip, index) => (
              <li
                key={index}
                className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400"
              >
                <svg
                  className="w-5 h-5 flex-shrink-0 text-blue-500 dark:text-blue-400 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                  />
                </svg>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
