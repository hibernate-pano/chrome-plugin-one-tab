import React, { useState, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signUp, signIn, clearError } from '@/store/slices/authSlice';
import { InlineNotice } from '@/components/common/InlineNotice';
import {
  validateEmail,
  validatePassword,
  checkPasswordStrength,
  PasswordStrength,
} from '@/utils/inputValidation';

interface RegisterFormProps {
  onSuccess?: () => void;
}

const strengthConfig: Record<PasswordStrength, { label: string; color: string; width: string }> = {
  [PasswordStrength.WEAK]: { label: '弱', color: 'bg-rose-500', width: 'w-1/3' },
  [PasswordStrength.MEDIUM]: { label: '中等', color: 'bg-amber-500', width: 'w-2/3' },
  [PasswordStrength.STRONG]: { label: '强', color: 'bg-emerald-500', width: 'w-full' },
};

export const RegisterForm: React.FC<RegisterFormProps> = ({ onSuccess }) => {
  const dispatch = useAppDispatch();
  const { isLoading, error } = useAppSelector(state => state.auth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  const passwordStrength = useMemo(() => checkPasswordStrength(password), [password]);

  const inputClassName = (fieldName: string) =>
    `w-full rounded-2xl border px-4 py-3 text-sm shadow-sm transition focus:outline-none focus:ring-4 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${
      fieldErrors[fieldName]
        ? 'border-rose-300 focus:ring-rose-100 dark:border-rose-700 dark:focus:ring-rose-950/60'
        : 'border-gray-200 dark:border-gray-700 focus:ring-primary-100 dark:focus:ring-primary-950/60'
    }`;

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    const emailResult = validateEmail(email);
    if (!emailResult.isValid) {
      errors.email = emailResult.error || '邮箱格式不正确';
    }

    const passwordResult = validatePassword(password);
    if (!passwordResult.isValid) {
      errors.password = passwordResult.error || '密码不符合要求';
    }

    if (password !== confirmPassword) {
      errors.confirmPassword = '两次输入的密码不一致';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setIsRegistering(true);

    try {
      const result = await dispatch(signUp({ email, password })).unwrap();

      if (result) {
        setRegistrationSuccess(true);
        await dispatch(signIn({ email, password }));
        onSuccess?.();
      }
    } catch (error) {
      console.error('注册失败:', error);
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
      <form onSubmit={handleSubmit} className="rounded-[28px] border border-gray-200/80 bg-white/95 p-6 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.45)] backdrop-blur-sm dark:border-gray-700/80 dark:bg-gray-900/90">
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</label>
          <input
            type="email"
            className={inputClassName('email')}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setFieldErrors(prev => ({ ...prev, email: '' })); }}
            placeholder="请输入您的邮箱"
            required
          />
          {fieldErrors.email && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{fieldErrors.email}</p>
          )}
        </div>
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
          <input
            type="password"
            className={inputClassName('password')}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setFieldErrors(prev => ({ ...prev, password: '' })); }}
            placeholder="请输入密码（至少8位，含大小写字母、数字、特殊字符中3种）"
            required
          />
          {password && (
            <div className="mt-2">
              <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${strengthConfig[passwordStrength.strength].color}`}
                  style={{ width: passwordStrength.strength === PasswordStrength.WEAK ? '33%' : passwordStrength.strength === PasswordStrength.MEDIUM ? '66%' : '100%' }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                密码强度：{strengthConfig[passwordStrength.strength].label}
                {passwordStrength.feedback.length > 0 && ` — ${passwordStrength.feedback[0]}`}
              </p>
            </div>
          )}
          {fieldErrors.password && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{fieldErrors.password}</p>
          )}
        </div>
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">确认密码</label>
          <input
            type="password"
            className={inputClassName('confirmPassword')}
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setFieldErrors(prev => ({ ...prev, confirmPassword: '' })); }}
            placeholder="请再次输入密码"
            required
          />
          {fieldErrors.confirmPassword && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{fieldErrors.confirmPassword}</p>
          )}
        </div>
        <button
          type="submit"
          className="w-full rounded-2xl bg-primary-600 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 primary-button-interaction"
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
