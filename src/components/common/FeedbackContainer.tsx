/**
 * 增强的用户反馈组件
 * 显示成功/错误/信息/警告消息
 */

import React, { useEffect, useState, useCallback } from 'react';
import { feedback, FeedbackMessage } from '@/utils/userFeedback';

const FeedbackIcon: React.FC<{ type: string }> = ({ type }) => {
  switch (type) {
    case 'success':
      return (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
      );
    case 'error':
      return (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
            clipRule="evenodd"
          />
        </svg>
      );
    case 'warning':
      return (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
      );
    default:
      return (
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
            clipRule="evenodd"
          />
        </svg>
      );
  }
};

const FeedbackItem: React.FC<{
  message: FeedbackMessage;
  onDismiss: (id: string) => void;
}> = ({ message, onDismiss }) => {
  const [isExiting, setIsExiting] = useState(false);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!message.options.showProgress || !message.options.duration) return;

    const duration = message.options.duration;
    const startTime = Date.now();
    const interval = 16; // 约60fps

    const timer = setInterval(() => {
      const elapsed = Date.now() - message.timestamp;
      const remaining = Math.max(0, duration - elapsed);
      const newProgress = (remaining / duration) * 100;
      setProgress(newProgress);

      if (newProgress === 0) {
        clearInterval(timer);
      }
    }, interval);

    return () => clearInterval(timer);
  }, [message]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      onDismiss(message.id);
    }, 300);
  }, [message.id, onDismiss]);

  const colorClasses = {
    success: 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800',
    error: 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800',
    warning: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800',
    info: 'bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  };

  const iconColorClasses = {
    success: 'text-green-500 dark:text-green-400',
    error: 'text-red-500 dark:text-red-400',
    warning: 'text-yellow-500 dark:text-yellow-400',
    info: 'text-blue-500 dark:text-blue-400',
  };

  return (
    <div
      className={`
        relative overflow-hidden rounded-lg border shadow-lg p-4 mb-3
        transition-all duration-300 ease-out
        ${colorClasses[message.type]}
        ${isExiting ? 'opacity-0 translate-x-full' : 'opacity-100 translate-x-0'}
      `}
      style={{
        animation: isExiting ? 'slideOut 0.3s ease-out' : 'slideIn 0.3s ease-out',
      }}
    >
      <div className="flex items-start gap-3">
        {message.options.showIcon && (
          <div className={`flex-shrink-0 ${iconColorClasses[message.type]}`}>
            <FeedbackIcon type={message.type} />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{message.message}</p>
        </div>

        <button
          onClick={handleDismiss}
          className="flex-shrink-0 ml-2 inline-flex text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          aria-label="关闭"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {message.options.showProgress && message.options.duration && (
        <div
          className="absolute bottom-0 left-0 h-1 bg-current opacity-30 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      )}
    </div>
  );
};

export const FeedbackContainer: React.FC = () => {
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);

  useEffect(() => {
    const unsubscribe = feedback.subscribe(setMessages);
    return unsubscribe;
  }, []);

  if (messages.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-50 max-w-md w-full pointer-events-none"
      style={{ maxHeight: 'calc(100vh - 2rem)' }}
    >
      <div className="flex flex-col items-end pointer-events-auto">
        {messages.map(message => (
          <FeedbackItem
            key={message.id}
            message={message}
            onDismiss={feedback.dismiss.bind(feedback)}
          />
        ))}
      </div>
    </div>
  );
};

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
