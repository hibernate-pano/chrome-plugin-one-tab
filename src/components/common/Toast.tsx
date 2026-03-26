import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose?: () => void;
  visible: boolean;
}

export const Toast: React.FC<ToastProps> = ({
  message,
  type = 'success',
  duration = 3000,
  onClose,
  visible
}) => {
  const [isVisible, setIsVisible] = useState(visible);
  const [animation, setAnimation] = useState('animate-fadeIn');
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    setIsVisible(visible);
    if (visible) {
      setAnimation('animate-fadeIn');
      setProgress(100);

      const startedAt = Date.now();
      const progressTimer = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const nextProgress = Math.max(0, 100 - (elapsed / duration) * 100);
        setProgress(nextProgress);
      }, 60);

      const timer = setTimeout(() => {
        setAnimation('animate-fadeOut');
        window.clearInterval(progressTimer);

        setTimeout(() => {
          setIsVisible(false);
          if (onClose) onClose();
        }, 300);
      }, duration);

      return () => {
        clearTimeout(timer);
        window.clearInterval(progressTimer);
      };
    }
  }, [visible, duration, onClose]);

  if (!isVisible) return null;

  const getTypeStyles = () => {
    switch (type) {
      case 'success':
        return {
          shell: 'border-emerald-200/80 bg-white/95 text-slate-800 dark:border-emerald-500/20 dark:bg-slate-900/95 dark:text-slate-100',
          accent: 'bg-emerald-500',
          iconWrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
        };
      case 'error':
        return {
          shell: 'border-rose-200/80 bg-white/95 text-slate-800 dark:border-rose-500/20 dark:bg-slate-900/95 dark:text-slate-100',
          accent: 'bg-rose-500',
          iconWrap: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
        };
      case 'info':
        return {
          shell: 'border-sky-200/80 bg-white/95 text-slate-800 dark:border-sky-500/20 dark:bg-slate-900/95 dark:text-slate-100',
          accent: 'bg-sky-500',
          iconWrap: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
        };
      case 'warning':
        return {
          shell: 'border-amber-200/80 bg-white/95 text-slate-800 dark:border-amber-500/20 dark:bg-slate-900/95 dark:text-slate-100',
          accent: 'bg-amber-500',
          iconWrap: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
        };
      default:
        return {
          shell: 'border-emerald-200/80 bg-white/95 text-slate-800 dark:border-emerald-500/20 dark:bg-slate-900/95 dark:text-slate-100',
          accent: 'bg-emerald-500',
          iconWrap: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
        };
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        );
      case 'error':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
        );
      case 'info':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
      case 'warning':
        return (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      default:
        return null;
    }
  };

  const typeStyles = getTypeStyles();

  return createPortal(
    <div className={`fixed right-4 top-4 z-[110] ${animation}`}>
      <div
        className={`pointer-events-auto relative min-w-[320px] max-w-[420px] overflow-hidden rounded-2xl border shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur ${typeStyles.shell}`}
      >
        <div className={`h-1 w-full ${typeStyles.accent}`} style={{ transform: `scaleX(${progress / 100})`, transformOrigin: 'left' }} />
        <div className="flex items-start gap-3 px-4 py-4">
          <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${typeStyles.iconWrap}`}>
            {getIcon()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
              {type}
            </div>
            <p className="mt-1 text-sm font-medium leading-6 text-current">{message}</p>
          </div>
          <button
            onClick={() => {
              setAnimation('animate-fadeOut');
              setTimeout(() => {
                setIsVisible(false);
                onClose?.();
              }, 220);
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="关闭提示"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default Toast;
