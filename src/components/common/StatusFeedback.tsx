import React from 'react';
import { LoadingSpinner } from './LoadingSpinner';

interface StatusFeedbackProps {
  status: 'success' | 'error' | 'loading' | 'info';
  message?: string;
  className?: string;
}

/**
 * 状态反馈组件
 * 提供丰富的状态反馈和微交互
 */
export const StatusFeedback: React.FC<StatusFeedbackProps> = ({ 
  status, 
  message,
  className = '' 
}) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'success':
        return {
          icon: (
            <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ),
          bgColor: 'flat-status-success',
          borderColor: '',
          textColor: '',
          animation: ''
        };
      case 'error':
        return {
          icon: (
            <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ),
          bgColor: 'flat-status-error',
          borderColor: '',
          textColor: '',
          animation: ''
        };
      case 'loading':
        return {
          icon: <LoadingSpinner size="sm" color="primary" />,
          bgColor: 'flat-status-info',
          borderColor: '',
          textColor: '',
          animation: ''
        };
      case 'info':
        return {
          icon: (
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ),
          bgColor: 'flat-status-info',
          borderColor: '',
          textColor: '',
          animation: ''
        };
      default:
        return {
          icon: null,
          bgColor: 'bg-gray-50 dark:bg-gray-900/20',
          borderColor: 'border-gray-200 dark:border-gray-800',
          textColor: 'text-gray-700 dark:text-gray-300',
          animation: ''
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div className={`inline-flex items-center space-x-2 ${config.bgColor} ${className}`}>
      <div className="flex-shrink-0">
        {config.icon}
      </div>
      {message && (
        <span className="text-sm font-medium">
          {message}
        </span>
      )}
    </div>
  );
};

/**
 * 操作确认组件
 * 提供友好的操作确认反馈
 */
export const ActionConfirmation: React.FC<{
  action: string;
  status: 'pending' | 'success' | 'error';
  className?: string;
}> = ({ action, status, className = '' }) => {
  const getStatusMessage = () => {
    switch (status) {
      case 'pending':
        return `正在${action}...`;
      case 'success':
        return `${action}成功！`;
      case 'error':
        return `${action}失败，请重试`;
      default:
        return '';
    }
  };

  const getStatusType = () => {
    switch (status) {
      case 'pending':
        return 'loading';
      case 'success':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  };

  return (
    <StatusFeedback
      status={getStatusType() as any}
      message={getStatusMessage()}
      className={className}
    />
  );
};

/**
 * 进度指示器组件
 * 显示操作进度和状态
 */
export const ProgressIndicator: React.FC<{
  progress: number;
  total: number;
  label?: string;
  className?: string;
}> = ({ progress, total, label, className = '' }) => {
  const percentage = Math.round((progress / total) * 100);

  return (
    <div className={`space-y-2 ${className}`}>
      {label && (
        <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
          <span>{label}</span>
          <span>{progress}/{total} ({percentage}%)</span>
        </div>
      )}
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div
          className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};

export default StatusFeedback;
