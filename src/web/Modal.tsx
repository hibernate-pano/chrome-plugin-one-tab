import React, { useEffect, useRef } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

/** 轻量自绘模态框：Web 端不依赖扩展组件，替换原生 confirm/prompt */
export const Modal: React.FC<ModalProps> = ({ open, title, children, onClose }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 初始焦点进入面板，便于键盘操作
    const t = setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-xl outline-none"
      >
        <h2 className="mb-3 text-base font-semibold text-gray-900">{title}</h2>
        {children}
      </div>
    </div>
  );
};

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 确认框 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open, title, message, confirmLabel = '确认', danger, busy, onConfirm, onCancel,
}) => (
  <Modal open={open} title={title} onClose={onCancel}>
    <p className="mb-4 text-sm text-gray-600">{message}</p>
    <div className="flex justify-end gap-2">
      <button
        onClick={onCancel}
        disabled={busy}
        className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
      >
        取消
      </button>
      <button
        onClick={onConfirm}
        disabled={busy}
        className={`rounded-lg px-3 py-1.5 text-sm text-white transition disabled:opacity-50 ${
          danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  </Modal>
);

interface PromptModalProps {
  open: boolean;
  title: string;
  initialValue: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** 输入框 */
export const PromptModal: React.FC<PromptModalProps> = ({
  open, title, initialValue, busy, onSubmit, onCancel,
}) => {
  const [value, setValue] = React.useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (v) onSubmit(v);
        }}
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          placeholder="请输入名称"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            确认
          </button>
        </div>
      </form>
    </Modal>
  );
};