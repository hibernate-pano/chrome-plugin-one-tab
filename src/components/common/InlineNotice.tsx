import React from 'react';

type InlineNoticeTone = 'success' | 'error' | 'warning' | 'info';

interface InlineNoticeProps {
  tone?: InlineNoticeTone;
  title?: string;
  message: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}

const toneStyles: Record<InlineNoticeTone, { shell: string; iconWrap: string; icon: React.ReactNode }> = {
  success: {
    shell: 'border-emerald-200 bg-emerald-50/90 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-100',
    iconWrap: 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
      </svg>
    ),
  },
  error: {
    shell: 'border-rose-200 bg-rose-50/90 text-rose-900 dark:border-rose-900/40 dark:bg-rose-950/40 dark:text-rose-100',
    iconWrap: 'bg-rose-500/15 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.01M10.29 3.86 1.82 18a2.25 2.25 0 0 0 1.93 3.37h16.5A2.25 2.25 0 0 0 22.18 18l-8.47-14.14a2.25 2.25 0 0 0-3.42 0Z" />
      </svg>
    ),
  },
  warning: {
    shell: 'border-amber-200 bg-amber-50/90 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-100',
    iconWrap: 'bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.01M10.29 3.86 1.82 18a2.25 2.25 0 0 0 1.93 3.37h16.5A2.25 2.25 0 0 0 22.18 18l-8.47-14.14a2.25 2.25 0 0 0-3.42 0Z" />
      </svg>
    ),
  },
  info: {
    shell: 'border-sky-200 bg-sky-50/90 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/40 dark:text-sky-100',
    iconWrap: 'bg-sky-500/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
    icon: (
      <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25 12 11.25v5.25h.75m-1.5-8.25h.008v.008h-.008V8.25Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
  },
};

export const InlineNotice: React.FC<InlineNoticeProps> = ({
  tone = 'info',
  title,
  message,
  onDismiss,
  className = '',
}) => {
  const style = toneStyles[tone];

  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm backdrop-blur-sm ${style.shell} ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${style.iconWrap}`}>
          {style.icon}
        </div>

        <div className="min-w-0 flex-1">
          {title && <div className="text-sm font-semibold">{title}</div>}
          <div className={`text-sm ${title ? 'mt-1' : ''}`}>{message}</div>
        </div>

        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-current/70 transition-colors hover:bg-black/5 hover:text-current dark:hover:bg-white/10"
            aria-label="关闭提示"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

export default InlineNotice;
