import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

/**
 * Toast 类型的��文标签（2026-10-07 P2-3）。
 *
 * 原先直接把 `{type}` 渲染进界面，于是一个全中文的产品在每一条成功/失败/
 * 提示上都会蹦出 SUCCESS / ERROR / WARNING 三个英文大写词（还带
 * `uppercase tracking-[0.18em]` 的标签样式）。这是**所有反馈的唯一通道** ——
 * 也就是说「每一条反馈都带一个英文单词」。
 */
const TYPE_LABEL: Record<ToastType, string> = {
  success: '完成',
  error: '出错',
  info: '提示',
  warning: '注意',
};

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose?: () => void;
  visible: boolean;
}

/**
 * 进度条收缩动画的 keyframes。
 * 原来是 setInterval(…, 60) 驱动一个 React state，只为了画一段 scaleX——
 * 每个 toast 白白重渲染约 50 次。改成纯 CSS 动画后重渲染次数归零。
 */
const PROGRESS_KEYFRAMES =
  '@keyframes tapstack-toast-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }';

export const Toast: React.FC<ToastProps> = ({
  message,
  type = 'success',
  duration = 3000,
  onClose,
  visible
}) => {
  const [isVisible, setIsVisible] = useState(visible);
  const [animation, setAnimation] = useState('animate-fadeIn');

  // onClose 每次渲染都是新的函数引用（ToastContext 里的箭头函数），
  // 放进 effect 依赖会让「弹窗期间再来一个弹窗」把计时器重置、动画重播。
  // 用 ref 取最新值，effect 只依赖 visible / duration。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    setIsVisible(visible);
    if (!visible) return;

    setAnimation('animate-fadeIn');

    let fadeOutTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    const dismissTimer = setTimeout(() => {
      setAnimation('animate-fadeOut');

      fadeOutTimer = setTimeout(() => {
        setIsVisible(false);
        onCloseRef.current?.();
      }, 300);
    }, duration);

    return () => {
      clearTimeout(dismissTimer);
      if (fadeOutTimer !== undefined) clearTimeout(fadeOutTimer);
    };
  }, [visible, duration]);

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

  // 错误要打断当前朗读（assertive），其余提示排队等空档（polite）。
  const isAssertive = type === 'error';

  // 外层 live region 永远挂载（不可见时只留一个空壳，不 display:none）：
  // 读屏只播报「已经存在于无障碍树里的区域」的内容变化，
  // 区域和文案同一帧插入的话多数读屏不会播报 —— 那就等于没有 aria-live。
  return createPortal(
    <div
      role={isAssertive ? 'alert' : 'status'}
      aria-live={isAssertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`pointer-events-none fixed right-4 top-4 z-[110] ${isVisible ? animation : ''}`}
    >
      <style>{PROGRESS_KEYFRAMES}</style>

      {isVisible && (
        <div
          className={`pointer-events-auto relative min-w-[320px] max-w-[420px] overflow-hidden rounded-2xl border shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur ${typeStyles.shell}`}
        >
          <div
            className={`h-1 w-full ${typeStyles.accent}`}
            style={{
              transformOrigin: 'left',
              animation: isVisible
                ? `tapstack-toast-progress ${duration}ms linear forwards`
                : 'none',
            }}
          />
          <div className="flex items-start gap-3 px-4 py-4">
            <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${typeStyles.iconWrap}`}>
              {getIcon()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold tracking-[0.18em] text-slate-400 dark:text-slate-500">
                {TYPE_LABEL[type]}
              </div>
              <p className="mt-1 text-sm font-medium leading-6 text-current">{message}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setAnimation('animate-fadeOut');
                setTimeout(() => {
                  setIsVisible(false);
                  onCloseRef.current?.();
                }, 220);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="关闭提示"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

export default Toast;
