import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signIn, clearError } from '@/store/slices/authSlice';
import { InlineNotice } from '@/components/common/InlineNotice';
import { validateEmail, validatePassword, validateForm } from '@/utils/inputValidation';
import { useToast } from '@/contexts/ToastContext';
import { restoreAfterLogin } from './restoreAfterLogin';
import { loginRestoreFeedback } from './restoreFeedbackCopy';
import { logError } from '../../utils/log';

interface LoginFormProps {
  onSuccess?: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess }) => {
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector(state => state.auth);
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const inputClassName = (hasError: boolean) =>
    // 2026-10-20 审计 P1-1：原先带 `focus:outline-none`（Tailwind 展开成
    // `outline: 2px solid transparent`，同特异性靠后）—— 它把全局 :focus-visible
    // 的焦点环整条吃掉。而 apple/chrome/claude 三套主题的 --focus-ring 只是
    // 22% 透明度的一圈柔光（叠在底上 1.24–1.65:1）⇒ 键盘用户完全看不到焦点在哪。
    // 现在不声明 outline ⇒ 全局 :focus-visible 的 2px 环（读 --color-focus-ring，
    // 各主题实测 ≥3:1）照常画出来。theme-focus 的柔光保留为第二通道。
    `w-full theme-radius-input theme-bg-elevated border px-4 py-3 text-sm shadow-sm transition text-gray-900 dark:text-gray-100 ${
      hasError
        ? 'border-rose-300 focus:ring-4 focus:ring-rose-100 dark:border-rose-700 dark:focus:ring-rose-950/60'
        : 'theme-border-default theme-focus'
    }`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 清除之前的验证错误
    setValidationErrors({});
    dispatch(clearError());

    // 验证输入
    const validation = validateForm(
      { email, password },
      {
        email: validateEmail,
        password: validatePassword
      }
    );

    if (!validation.isValid) {
      setValidationErrors(validation.errors);
      return;
    }

    try {
      // 使用清理后的数据
      await dispatch(signIn({
        email: validation.sanitized.email,
        password: validation.sanitized.password
      })).unwrap();

      // ── 2026-10-19 审计 F-6：登录成功 = 拉回云端会话 ────────────────────
      // 修复前登录成功只关弹窗，什么都不拉。新设备上用户登录后列表仍然是
      // 空的 —— 而引导写着「新设备登录即恢复」。用户会以为云端数据丢了。
      //
      // 为什么不靠 popup 打开时的自动下载：那条路被 `syncEnabled` 门禁拦下
      // （默认 false），且 AuthProvider 的 effect 不会因登录而重跑。
      // 登录是**显式意图**（我刚敲了账号密码，就是想看到另一台设备上的会话），
      // 不该被「后台定时轮询的开关」拦下 —— 那是拿错判据。
      //
      // 失败不阻断登录：同步失败不该把用户踢回登录页，手动「下载」入口仍在。
      //
      // ── 2026-10-22 审计 SC-6：三种结果 ⇒ 三种回执 ──────────────────────
      // 修复前这里只 `if (count > 0)` 才说话 ⇒ 「拉回失败」与「云端为空」
      // 都回 0 ⇒ 两种情况**一句话都没有** ⇒ 用户以为云端的数据没了。
      // ⇒ 现在按结果分别出声：拉到 N 个（成功）/ 云端为空（提示）/ 失败（错误 + 出路）。
      void restoreAfterLogin(dispatch).then(outcome => {
        const feedback = loginRestoreFeedback(outcome);
        showToast(feedback.text, feedback.tone);
      });

      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      logError('登录失败:', error);
    }
  };



  return (
    <div className="max-w-md mx-auto">
      {error && (
        <InlineNotice
          tone="error"
          title="登录失败"
          message={error}
          onDismiss={() => dispatch(clearError())}
          className="mb-6"
        />
      )}
      <form onSubmit={handleSubmit} className="theme-radius-panel theme-panel-translucent theme-panel-blur theme-border-default theme-shadow-panel border p-6">
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</label>
          <input
            type="email"
            className={inputClassName(Boolean(validationErrors.email))}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              // 清除该字段的验证错误
              if (validationErrors.email) {
                setValidationErrors(prev => ({ ...prev, email: '' }));
              }
            }}
            placeholder="请输入您的邮箱"
            required
          />
          {validationErrors.email && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{validationErrors.email}</p>
          )}
        </div>
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
          <input
            type="password"
            className={inputClassName(Boolean(validationErrors.password))}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              // 清除该字段的验证错误
              if (validationErrors.password) {
                setValidationErrors(prev => ({ ...prev, password: '' }));
              }
            }}
            placeholder="请输入您的密码"
            required
          />
          {validationErrors.password && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{validationErrors.password}</p>
          )}
        </div>
        <button
          type="submit"
          className="theme-cta theme-radius-input w-full py-3 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              登录中...
            </span>
          ) : '登录'}
        </button>
      </form>
    </div>
  );
};
