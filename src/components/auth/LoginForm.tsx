import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signIn, clearError } from '@/store/slices/authSlice';
import { InlineNotice } from '@/components/common/InlineNotice';
import { validateEmail, validatePassword, validateForm } from '@/utils/inputValidation';

interface LoginFormProps {
  onSuccess?: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess }) => {
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector(state => state.auth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const inputClassName = (hasError: boolean) =>
    `w-full rounded-2xl border px-4 py-3 text-sm shadow-sm transition focus:outline-none focus:ring-4 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${
      hasError
        ? 'border-rose-300 focus:ring-rose-100 dark:border-rose-700 dark:focus:ring-rose-950/60'
        : 'border-gray-200 dark:border-gray-700 focus:ring-primary-100 dark:focus:ring-primary-950/60'
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

      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error('登录失败:', error);
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
      <form onSubmit={handleSubmit} className="rounded-[28px] border border-gray-200/80 bg-white/95 p-6 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.45)] backdrop-blur-sm dark:border-gray-700/80 dark:bg-gray-900/90">
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
          className="w-full rounded-2xl bg-primary-600 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 primary-button-interaction"
          disabled={isLoading}
        >
          {isLoading ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
