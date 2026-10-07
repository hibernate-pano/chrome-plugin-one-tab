import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';

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
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // 钩子必须在 `if (!visible) return null` 之前调用：
  // visible 是渲染开关而不是卸载开关，焦点契约要跟着它一起开合。
  useDialogA11y(panelRef, visible, onClose);

  if (!visible) {
    return null;
  }

  return createPortal(
    // 2026-10-07 P2-7：外层负责滚动、内层 min-h-full 居中。
    // 原先是 `flex items-center` 且不可滚动：内容比视口高时（典型是
    // 「删除全部 N 个会话」这种文案随数量变长的确认框）溢出部分在视口**上方**
    // 且无法滚动 ——「删除」按钮可能根本点不到。
    // 同一 bug 的正确写法见 AuthModal.tsx 与 SyncButton.tsx 的注释。
    <div className="fixed inset-0 z-[100] overflow-y-auto">
      <div
        className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div
        className="flex min-h-full items-center justify-center p-4"
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={`relative w-full ${maxWidthClassName} overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur focus:outline-none dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80`}
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
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
              <h3
                id={titleId}
                className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50"
              >
                {title}
              </h3>
              {description && (
                <p
                  id={descriptionId}
                  className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600 dark:text-slate-300"
                >
                  {description}
                </p>
              )}
            </div>
          </div>

          {children && <div className="mt-5">{children}</div>}
          {footer && <div className="mt-5 flex justify-end gap-3">{footer}</div>}
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
};

export default ModalFrame;
