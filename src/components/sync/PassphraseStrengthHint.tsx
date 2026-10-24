/**
 * 加密口令的强度提示（2026-10-24 审计 SEC-1）。
 *
 * ── 为什么单独抽一个组件 ──────────────────────────────────────────────────
 *
 * 因为「面板上显示了强度提示」这句话，只有**渲染一遍**才能验。
 * 源码里有 `PASSPHRASE_LEVEL_LABEL[...]` 只说明**代码在那儿**，
 * 不说明它真的出现在界面上（条件写反、组件没被接上、JSX 位置写错 ——
 * 这三类错法源码 grep 一个都看不出来）。
 * ⇒ 抽成组件后，可以用 `react-dom/server` 真渲染一遍，
 * 断言**输出的 HTML 里有没有**那句话（见 tests/guards/webdavPassphrasePolicy.test.ts）。
 *
 * ── 它只提示，不拦截 ──────────────────────────────────────────────────────
 *
 * 门槛在适配器**建库那一刻**（`webdav/adapter.ts` 的 `unlock()`），
 * 不在表单 —— 理由见 `webdav/passphrasePolicy.ts` 的文件头：
 * 口令不落盘，老用户每次重开页面都要重新输入当年那个口令，
 * 在表单上拦 ⇒ 他会被**自己的**口令挡在门外。
 *
 * 所以这里的职责只有一个：**在用户按下保存之前就把话说清楚**。
 */
import React, { useMemo } from 'react';
import {
  evaluatePassphrase,
  PASSPHRASE_LEVEL_LABEL,
  type PassphraseLevel,
} from '@/sync-backend/webdav/passphrasePolicy';

/**
 * 档位 → 文字颜色。
 *
 * 用主题令牌（`theme-text-*`）而不是写死的 Tailwind 色 ——
 * 写死的那套在暖色主题下与底色不搭（同 D-2 的教训）。
 */
const TONE_CLASS: Record<PassphraseLevel, string> = {
  weak: 'theme-text-danger',
  fair: 'theme-text-warning',
  strong: 'theme-text-primary',
};

/** 档位 → 指示条点亮几格。 */
const FILLED_BARS: Record<PassphraseLevel, number> = {
  weak: 1,
  fair: 2,
  strong: 3,
};

export interface PassphraseStrengthHintProps {
  /** 用户当前输入的口令（明文只活在这个组件的 props 里，不落盘、不上报）。 */
  passphrase: string;
}

/**
 * 口令强度提示条。
 *
 * 空口令时**什么都不说** —— 还没开始输入就报「太弱」是噪声，
 * 而且那会把「没填」与「填得太弱」两件事混成一件。
 */
export const PassphraseStrengthHint: React.FC<PassphraseStrengthHintProps> = ({ passphrase }) => {
  const verdict = useMemo(() => evaluatePassphrase(passphrase), [passphrase]);
  const hasInput = passphrase.trim().length > 0;
  const level = verdict.level;
  const filled = FILLED_BARS[level];

  return (
    <div
      id="webdav-encryption-pass-hint"
      className={`mt-1 flex items-center gap-1.5 text-[11px] ${TONE_CLASS[level]}`}
    >
      {hasInput ? (
        <>
          <span className="flex gap-0.5" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className={`h-1.5 w-4 rounded-full bg-current ${i < filled ? 'opacity-100' : 'opacity-25'}`}
              />
            ))}
          </span>
          <span>口令强度：{PASSPHRASE_LEVEL_LABEL[level]}</span>
          {verdict.reason ? (
            <span className="theme-text-muted">· {verdict.reason}</span>
          ) : level === 'fair' ? (
            <span className="theme-text-muted">· 再长一些更稳</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
