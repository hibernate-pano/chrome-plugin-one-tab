import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { signUpWithEmail, signInWithEmail, signInWithOAuth, clearError } from '@/features/auth/store/authSlice';

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

  const [isRegistering, setIsRegistering] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      setPasswordError('两次输入的密码不一致');
      return;
    }

    setPasswordError('');
    setIsRegistering(true);

    try {
      if (email && password) {
        // 注册用户
        const result = await dispatch(signUpWithEmail({ email, _password: password })).unwrap();

        if (result) {
          setRegistrationSuccess(true);
          // 自动登录
          await dispatch(signInWithEmail({ email, password }));

          if (onSuccess) {
            onSuccess();
          }
        }
      }
    } catch (error) {
      console.error('注册失败:', error);
    } finally {
      setIsRegistering(false);
    }
  };

  const handleOAuthLogin = async (provider: 'google' | 'github' | 'wechat') => {
    try {
      await dispatch(signInWithOAuth(provider));
      // 注意：由于这是重定向流程，我们不会在这里调用 onSuccess
      // 成功的回调处理将在后台脚本中完成
    } catch (error) {
      console.error(`${provider} 登录失败:`, error);
    }
  };

  return (
    <div className="max-w-md mx-auto">
      {registrationSuccess && (
        <div className="bg-green-50 border-l-4 border-green-500 text-green-700 p-4 rounded-lg mb-6 flex justify-between items-center">
          <div className="flex items-center">
            <svg className="h-5 w-5 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span>注册成功！正在自动登录...</span>
          </div>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-lg mb-6 flex justify-between items-center">
          <div className="flex items-center">
            <svg className="h-5 w-5 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            className="text-red-700 hover:text-red-900"
            onClick={() => dispatch(clearError())}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {passwordError && (
        <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-lg mb-6 flex justify-between items-center">
          <div className="flex items-center">
            <svg className="h-5 w-5 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{passwordError}</span>
          </div>
          <button
            className="text-red-700 hover:text-red-900"
            onClick={() => setPasswordError('')}
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
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="请输入您的邮箱"
            required
          />
        </div>
        <div className="mb-5">
          <label className="block text-gray-700 dark:text-gray-300 text-sm font-medium mb-2">密码</label>
          <input
            type="password"
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            required
          />
        </div>
        <div className="mb-6">
          <label className="block text-gray-700 dark:text-gray-300 text-sm font-medium mb-2">确认密码</label>
          <input
            type="password"
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="请再次输入密码"
            required
          />
        </div>
        <button
          type="submit"
          className="w-full bg-primary-600 text-white py-3 rounded-lg hover:bg-primary-700 transition-colors font-medium shadow-sm"
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

        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400">或者使用第三方账号注册</span>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => handleOAuthLogin('google')}
              className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-sm font-medium text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60"
              disabled={true}
            >
              <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
                <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                  <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z" />
                  <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z" />
                  <path fill="#FBBC05" d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.724 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z" />
                  <path fill="#EA4335" d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z" />
                </g>
              </svg>
              <span>Google (未启用)</span>
            </button>

            <button
              type="button"
              onClick={() => handleOAuthLogin('github')}
              className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-sm font-medium text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60"
              disabled={true}
            >
              <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              <span>GitHub (未启用)</span>
            </button>

            <button
              type="button"
              onClick={() => handleOAuthLogin('wechat')}
              className="w-full inline-flex justify-center py-2 px-4 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-800 text-sm font-medium text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-60"
              disabled={true}
            >
              <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" fill="#07C160">
                <path d="M8.691 2C4.493 2 1 4.762 1 8.129c0 1.938 1.057 3.624 2.647 4.802l-0.561 1.82c-0.036 0.121-0.003 0.252 0.085 0.339 0.056 0.055 0.129 0.083 0.203 0.083 0.047 0 0.094-0.01 0.138-0.029l2.357-1.231c0.921 0.302 1.884 0.453 2.822 0.453 0.203 0 0.406-0.008 0.609-0.022 -0.225-0.624-0.336-1.269-0.336-1.913 0-3.366 3.493-6.129 7.691-6.129 0.203 0 0.406 0.008 0.609 0.022C16.72 3.876 13.059 2 8.691 2zM5.897 6.07c0.633 0 1.146 0.513 1.146 1.146S6.53 8.362 5.897 8.362 4.751 7.849 4.751 7.216 5.264 6.07 5.897 6.07zM11.485 6.07c0.633 0 1.146 0.513 1.146 1.146s-0.513 1.146-1.146 1.146S10.339 7.849 10.339 7.216 10.852 6.07 11.485 6.07z" />
                <path d="M22.952 16.318c1.311-0.95 2.094-2.279 2.094-3.703 0-2.667-2.738-4.83-6.109-4.83s-6.109 2.163-6.109 4.83 2.738 4.83 6.109 4.83c0.742 0 1.465-0.119 2.137-0.344l1.737 0.906c0.035 0.019 0.074 0.027 0.112 0.027 0.059 0 0.118-0.021 0.165-0.065 0.071-0.068 0.098-0.171 0.069-0.264l-0.412-1.342C22.952 16.343 22.952 16.331 22.952 16.318zM15.561 14.464c-0.503 0-0.91-0.407-0.91-0.91s0.407-0.91 0.91-0.91 0.91 0.407 0.91 0.91S16.064 14.464 15.561 14.464zM19.976 14.464c-0.503 0-0.91-0.407-0.91-0.91s0.407-0.91 0.91-0.91 0.91 0.407 0.91 0.91S20.479 14.464 19.976 14.464z" />
              </svg>
              <span>微信 (未启用)</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
