import React, { useState } from 'react';
import { validateEmail, validatePassword, validateForm } from '@/utils/inputValidation';
import { signIn, WebAuthError } from './webApi';

interface Props {
  onSuccess: () => void;
}

export const LoginPage: React.FC<Props> = ({ onSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const inputClassName = (hasError: boolean) =>
    `w-full rounded-2xl border px-4 py-3 text-sm shadow-sm transition focus:outline-none focus:ring-4 focus:border-transparent bg-white text-gray-900 ${
      hasError
        ? 'border-rose-300 focus:ring-rose-100'
        : 'border-gray-200 focus:ring-primary-100'
    }`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const validation = validateForm({ email, password }, {
      email: validateEmail,
      password: validatePassword,
    });

    if (!validation.isValid) {
      setFieldErrors(validation.errors);
      return;
    }

    setLoading(true);
    try {
      await signIn(validation.sanitized.email, validation.sanitized.password);
      onSuccess();
    } catch (err) {
      if (err instanceof WebAuthError) {
        setError(err.message);
      } else {
        setError('登录失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">TapStack 网页版</h1>
        <p className="mt-2 text-sm text-gray-500">登录后查看你的工作会话</p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-xl"
      >
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-gray-700">邮箱</label>
          <input
            type="email"
            className={inputClassName(Boolean(fieldErrors.email))}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) {
                setFieldErrors((prev) => ({ ...prev, email: '' }));
              }
            }}
            placeholder="请输入您的邮箱"
            required
          />
          {fieldErrors.email && (
            <p className="mt-2 text-sm text-rose-600">{fieldErrors.email}</p>
          )}
        </div>

        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700">密码</label>
          <input
            type="password"
            className={inputClassName(Boolean(fieldErrors.password))}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) {
                setFieldErrors((prev) => ({ ...prev, password: '' }));
              }
            }}
            placeholder="请输入您的密码"
            required
          />
          {fieldErrors.password && (
            <p className="mt-2 text-sm text-rose-600">{fieldErrors.password}</p>
          )}
        </div>

        <button
          type="submit"
          className="w-full rounded-2xl bg-primary-600 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading}
        >
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  );
};
