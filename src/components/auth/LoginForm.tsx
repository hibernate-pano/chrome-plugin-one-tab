import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signIn, clearError } from '@/store/slices/authSlice';
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
        <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-lg mb-6 flex justify-between items-center">
          <div className="flex items-center">
            <svg className="h-5 w-5 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            className="text-red-700 hover:text-red-900 flat-interaction p-1 rounded-full"
            onClick={() => dispatch(clearError())}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-900 shadow-md rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <div className="mb-5">
          <label className="block text-gray-700 dark:text-gray-300 text-sm font-medium mb-2">邮箱</label>
          <input
            type="email"
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${validationErrors.email
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 dark:border-gray-600 focus:ring-primary-500'
              }`}
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
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.email}</p>
          )}
        </div>
        <div className="mb-6">
          <label className="block text-gray-700 dark:text-gray-300 text-sm font-medium mb-2">密码</label>
          <input
            type="password"
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${validationErrors.password
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 dark:border-gray-600 focus:ring-primary-500'
              }`}
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
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.password}</p>
          )}
        </div>
        <button
          type="submit"
          className="w-full bg-primary-600 text-white py-3 rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium shadow-sm primary-button-interaction"
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
