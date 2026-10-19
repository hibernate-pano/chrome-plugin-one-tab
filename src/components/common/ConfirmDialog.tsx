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
  // 2026-10-18 round 38：确认/取消是弹窗唯一出口，14px 白字对底色要 ≥4.5:1。
  // amber-500 只有 2.15:1、sky-600 4.10:1，统一下移到 700 档；rose-600 的 4.70:1 已达标，保持。
  // primary 是主题变量（主题侧已有 --color-accent-fg 的对比契约），这里不动。
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
          confirmButton: 'bg-rose-600 hover:bg-rose-700 focus-visible:outline-slate-600 dark:focus-visible:outline-slate-300 text-white'
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
          confirmButton: 'bg-amber-700 hover:bg-amber-800 focus-visible:outline-slate-600 dark:focus-visible:outline-slate-300 text-white'
        };
      case 'info':
        return {
          icon: (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-100 text-primary-600 dark:bg-primary-500/15 dark:text-primary-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          ),
          confirmButton: 'bg-primary-600 hover:bg-primary-700 focus-visible:outline-primary-500 text-white'
        };
      default:
        return {
          icon: null,
          confirmButton: 'bg-sky-700 hover:bg-sky-800 focus-visible:outline-slate-600 dark:focus-visible:outline-slate-300 text-white'
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
          {/* ── 2026-10-19 审计 P1-5：描边用 border-strong ──────────────────
           * 修复前是 `border theme-border-default`：在 legacy / creamy / apple 的
           * **深色**主题里，--color-border-default 与 --color-bg-tertiary 是
           * 同一个值 —— 描边与底色一起塌成一块，「取消」按钮融进面板里，
           * 看不出这是个按钮（实测底色与描边都是 rgb(55,65,81) / rgb(63,58,54)）。
           * border-strong 在这些主题里都明显更亮（#4b5563 / #57534e / #48484a）。
           */}
          <button
            onClick={onCancel}
            // 2026-10-19 审计 V-6：取消按钮也跟主题（原先写死 slate 系，
            // 在暖色主题下是一块冷灰补丁）。
            className="inline-flex items-center justify-center rounded-xl border theme-border-strong theme-bg-tertiary px-4 py-2.5 text-sm font-medium theme-text-primary transition-colors hover:theme-btn-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
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
