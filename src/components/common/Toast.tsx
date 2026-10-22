import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

/**
 * Toast 类型的中文标签（2026-10-07 P2-3）。
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

/**
 * Toast 上的**动作按钮**（2026-10-22 审计 P0-4：撤销「恢复即消费」）。
 *
 * 为什么需要它：产品里有些操作是**不可逆**的（恢复会话 = 消费掉那条记录），
 * 而「按了键之后给一条可点回去的路」是这类产品该有的最低配置 ——
 * Chrome 自己的「重新打开已关闭的标签」、Dropbox 的「撤销删除」都是这个形状。
 *
 * 形状说明：
 *   · 动作按钮**常驻可见**（不是 hover 才出现）—— 鼠标不在 toast 上时用户
 *     也必须看得见还有一条退路；
 *   · 点了动作之后 toast 立即退场（动作已经执行，再留着是噪音）；
 *   · 命中区按本项目自己的规则给到 36px（`min-h-9 min-w-9`，见
 *     components/layout/hitTarget.ts 的口径说明）。
 */
export interface ToastAction {
  /** 按钮文字。必须是一个**动作**（动词），不是一个状态。 */
  label: string;
  /** 点击后执行。抛错由调用方自己处理（组件不吞异常，也不假装成功）。 */
  onAction: () => void;
}

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose?: () => void;
  visible: boolean;
  /** 在队列中的堆叠序号，用于错开底部位置，避免多条互相遮挡 */
  stackIndex?: number;
  /** 可选的「撤销/重做」动作按钮。给了就多一条退路。 */
  action?: ToastAction;
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
  visible,
  stackIndex = 0,
  action,
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

    // duration <= 0 表示常驻（error 默认），需用户手动关闭
    if (duration <= 0) return;

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
          iconWrap: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
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

  /**
   * 退场：淡出 → 卸载 → 通知上层从队列里移除。
   *
   * 抽成函数是因为「点关闭」与「点动作」两条路径的退场必须完全一致 ——
   * 动作执行完若还把 toast 留在原地，用户会以为动作没生效（而动作其实做完了）。
   */
  const dismiss = () => {
    setAnimation('animate-fadeOut');
    setTimeout(() => {
      setIsVisible(false);
      onCloseRef.current?.();
    }, 220);
  };

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
      className={`pointer-events-none fixed bottom-4 left-1/2 z-[110] -translate-x-1/2 ${isVisible ? animation : ''}`}
      style={{ marginBottom: stackIndex * 76 }}
    >
      <style>{PROGRESS_KEYFRAMES}</style>

      {isVisible && (
        <div
          className={`pointer-events-auto relative min-w-0 max-w-[calc(100vw-2rem)] overflow-hidden theme-radius-card border shadow-[0_20px_60px_rgba(15,23,42,0.18)] backdrop-blur ${typeStyles.shell}`}
        >
          <div
            className={`h-1 w-full ${typeStyles.accent}`}
            style={{
              transformOrigin: 'left',
              animation: duration > 0 && isVisible
                ? `tapstack-toast-progress ${duration}ms linear forwards`
                : 'none',
              opacity: duration > 0 ? 1 : 0,
            }}
          />
          <div className="flex items-start gap-3 px-4 py-4">
            <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${typeStyles.iconWrap}`}>
              {getIcon()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold tracking-[0.18em] theme-text-muted">
                {TYPE_LABEL[type]}
              </div>
              <p className="mt-1 text-sm font-medium leading-6 text-current">{message}</p>
              {action && (
                <button
                  type="button"
                  onClick={() => {
                    // 动作先执行、再退场：动作里可能是异步的（撤销要落盘），
                    // 但**退场不等待它** —— 界面不该被一次网络往返卡住。
                    // 动作失败由动作自己的调用方负责出声（组件不吞异常、
                    // 也不假装成功）。
                    action.onAction();
                    dismiss();
                  }}
                  className="mt-2 inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-current/20 bg-white/60 px-3 text-sm font-semibold text-current transition-colors hover:bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current dark:bg-white/10 dark:hover:bg-white/20"
                >
                  {action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full theme-text-muted transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 dark:focus-visible:outline-slate-300"
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
