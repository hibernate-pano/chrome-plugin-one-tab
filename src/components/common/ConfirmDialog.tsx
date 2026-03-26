import React from 'react';
import ModalFrame from './ModalFrame';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  visible,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  type = 'warning',
  onConfirm,
  onCancel
}) => {
  const getTypeStyles = () => {
    switch (type) {
      case 'danger':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 19.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
          ),
          confirmButton: 'bg-rose-600 hover:bg-rose-700 focus-visible:outline-rose-500 text-white'
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
          confirmButton: 'bg-amber-500 hover:bg-amber-600 focus-visible:outline-amber-500 text-white'
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
          confirmButton: 'bg-sky-600 hover:bg-sky-700 focus-visible:outline-sky-500 text-white'
        };
      default:
        return {
          icon: null,
          confirmButton: 'bg-sky-600 hover:bg-sky-700 focus-visible:outline-sky-500 text-white'
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
      onClose={onCancel}
      footer={
        <>
          <button
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${typeStyles.confirmButton}`}
          >
            {confirmText}
          </button>
        </>
      }
    />
  );
};

export default ConfirmDialog;
