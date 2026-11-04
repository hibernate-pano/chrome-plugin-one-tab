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
          // ── 2026-10-19 审计 V-6：弹层必须跟主题 ──────────────────────────
          // 修复前这里写死 slate 系（bg-slate-900/95、border-slate-200/80、
          // text-slate-900、rounded-[28px]）：Claude 深色主题下页面是
          // #191817 暖黑，弹层却是一块 rgba(15,23,42,.95) 的冷蓝黑 ——
          // 一个暖色产品里弹出一块冷蓝面板，主题看起来像半成品。
          // 现在全部走 theme-* 工具类（与 AuthModal 同一写法）。
          className={`relative flex w-full ${maxWidthClassName} max-h-[calc(100dvh-2rem)] flex-col overflow-hidden ts-dialog theme-radius-panel border theme-border-default theme-bg-elevated theme-shadow-panel backdrop-blur focus:outline-none`}
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border theme-border-strong theme-bg-elevated theme-text-secondary transition-colors hover:theme-btn-hover"
            aria-label="关闭弹窗"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

        {/* 2026-11-04：弹窗高度必须受视口约束，正文滚动、底部按钮固定。
            修复前实测（320×600、8 个长会话名的清理确认框）：面板高 916px、
            顶边 -1px，「取消 / 清理」在 y=848 —— 两个出口都在视口之外。
            外层虽然有 overflow-y-auto，但用户必须先滚动整层才能摸到按钮，
            而且标题已经滚出视口。现在面板 = flex 列，顶部正文 min-h-0
            可滚，footer 永远留在面板底部。 */}
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
          {/* tabIndex：长文案时正文是唯一的滚动容器。焦点若只落在标题/
              关闭按钮/底部按钮上，键盘用户没有任何办法滚动它（这些元素的
              最近的滚动祖先都不再是内容区）⇒ 正文自己进 Tab 序，
              PageDown / 方向键可直接阅读。短弹窗多一个焦点停靠点，
              但它带着可见焦点环，不会让人迷失。 */}
          <div
            role="group"
            tabIndex={0}
            aria-label="弹窗内容"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="flex items-start gap-4 pr-10">
              {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
              <div className="min-w-0">
                <h3
                  id={titleId}
                  className="text-lg font-semibold tracking-tight theme-text-primary"
                >
                  {title}
                </h3>
                {description && (
                  <p
                    id={descriptionId}
                    className="mt-2 whitespace-pre-line text-sm leading-6 theme-text-secondary"
                  >
                    {description}
                  </p>
                )}
              </div>
            </div>

            {children && <div className="mt-5">{children}</div>}
          </div>
          {footer && <div className="mt-5 flex shrink-0 justify-end gap-3">{footer}</div>}
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
};

export default ModalFrame;
