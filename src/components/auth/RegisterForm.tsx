import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signUp, signIn, clearError } from '@/store/slices/authSlice';
import { InlineNotice } from '@/components/common/InlineNotice';
import { validateEmail, validatePassword } from '@/utils/inputValidation';
import { logError } from '../../utils/log';

interface RegisterFormProps {
  onSuccess?: () => void;
}

export const RegisterForm: React.FC<RegisterFormProps> = ({ onSuccess }) => {
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector(state => state.auth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [emailError, setEmailError] = useState('');
  const inputClassName = (hasError = false) =>
    `w-full theme-radius-input theme-bg-elevated border px-4 py-3 text-sm shadow-sm transition focus:outline-none text-gray-900 dark:text-gray-100 ${
      hasError
        ? 'border-rose-300 focus:ring-4 focus:ring-rose-100 dark:border-rose-700 dark:focus:ring-rose-950/60'
        : 'theme-border-default theme-focus'
    }`;

  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const emailResult = validateEmail(email);
    if (!emailResult.isValid) {
      setEmailError(emailResult.error || '邮箱格式不正确');
      return;
    }
    setEmailError('');

    const passwordResult = validatePassword(password);
    if (!passwordResult.isValid) {
      setPasswordError(passwordResult.error || '密码不符合要求');
      return;
    }

    if (password !== confirmPassword) {
      setPasswordError('两次输入的密码不一致');
      return;
    }

    setPasswordError('');
    setIsRegistering(true);

    try {
      if (email && password) {
        // 注册用户
        const result = await dispatch(signUp({ email: emailResult.sanitized || email, password })).unwrap();

        if (result) {
          setRegistrationSuccess(true);
          // 自动登录
          await dispatch(signIn({ email, password }));

          if (onSuccess) {
            onSuccess();
          }
        }
      }
    } catch (error) {
      logError('注册失败:', error);
    } finally {
      setIsRegistering(false);
    }
  };



  return (
    <div className="max-w-md mx-auto">
      {registrationSuccess && (
        <InlineNotice
          tone="success"
          title="注册成功"
          message="账号已创建，正在自动登录。"
          className="mb-6"
        />
      )}
      {error && (
        <InlineNotice
          tone="error"
          title="注册失败"
          message={error}
          onDismiss={() => dispatch(clearError())}
          className="mb-6"
        />
      )}
      {passwordError && (
        <InlineNotice
          tone="warning"
          title="请检查密码"
          message={passwordError}
          onDismiss={() => setPasswordError('')}
          className="mb-6"
        />
      )}
      <form onSubmit={handleSubmit} className="theme-radius-panel theme-panel-translucent theme-panel-blur theme-border-default theme-shadow-panel border p-6">
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</label>
          <input
            type="email"
            className={inputClassName(Boolean(emailError))}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) {
                setEmailError('');
              }
            }}
            placeholder="请输入您的邮箱"
            required
          />
          {emailError && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{emailError}</p>
          )}
        </div>
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
          <input
            type="password"
            className={inputClassName(Boolean(passwordError))}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            required
          />
        </div>
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">确认密码</label>
          <input
            type="password"
            className={inputClassName(Boolean(passwordError))}
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (passwordError) {
                setPasswordError('');
              }
            }}
            placeholder="请再次输入密码"
            required
          />
          {passwordError && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{passwordError}</p>
          )}
        </div>
        <button
          type="submit"
          className="theme-cta theme-radius-input w-full py-3 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isLoading || isRegistering}
        >
          {isLoading || isRegistering ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              注册中...
            </span>
          ) : '注册'}
        </button>
      </form>
    </div>
  );
};
