import React from 'react';
import ModalFrame from './ModalFrame';

export interface AlertDialogProps {
  visible: boolean;
  title: string;
  message: string;
  buttonText?: string;
  type?: 'success' | 'error' | 'warning' | 'info';
  onClose: () => void;
}

export const AlertDialog: React.FC<AlertDialogProps> = ({
  visible,
  title,
  message,
  buttonText = '确定',
  type = 'info',
  onClose
}) => {
  // 2026-10-18 round 38：这是弹窗唯一出口，14px 白字对底色要 ≥4.5:1。
  // amber-500 只有 2.15:1、emerald-600 3.77:1、sky-600 4.10:1，统一下移到 700 档。
  // 焦点环画在 offset-2 的外侧、落在弹窗白底上，改用 slate-600（7.58:1）。
  const getTypeStyles = () => {
    switch (type) {
      case 'success':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          ),
          button: 'bg-emerald-700 hover:bg-emerald-800 text-white'
        };
      case 'error':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          ),
          button: 'bg-rose-600 hover:bg-rose-700 text-white'
        };
      case 'warning':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 19.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
          ),
          button: 'bg-amber-700 hover:bg-amber-800 text-white'
        };
      case 'info':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          ),
          button: 'bg-sky-700 hover:bg-sky-800 text-white'
        };
      default:
        return {
          icon: null,
          button: 'bg-sky-700 hover:bg-sky-800 text-white'
        };
    }
  };

  const typeStyles = getTypeStyles();

  return (
    <ModalFrame
      visible={visible}
      title={title}
      description={message}
      icon={typeStyles.icon}
      onClose={onClose}
      footer={
        <button
          onClick={onClose}
          className={`inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${typeStyles.button}`}
        >
          {buttonText}
        </button>
      }
    />
  );
};

export default AlertDialog;
