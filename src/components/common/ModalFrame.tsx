import React from 'react';
import { createPortal } from 'react-dom';

interface ModalFrameProps {
  visible: boolean;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClassName?: string;
}

export const ModalFrame: React.FC<ModalFrameProps> = ({
  visible,
  title,
  description,
  icon,
  onClose,
  children,
  footer,
  maxWidthClassName = 'max-w-lg',
}) => {
  if (!visible) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div
        className={`relative w-full ${maxWidthClassName} overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80`}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
          aria-label="关闭弹窗"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
          <div className="flex items-start gap-4 pr-10">
            {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
            <div className="min-w-0">
              <h3 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {title}
              </h3>
              {description && (
                <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {description}
                </p>
              )}
            </div>
          </div>

          {children && <div className="mt-5">{children}</div>}
          {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ModalFrame;
