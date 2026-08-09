import React, { useState, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { LoginForm } from '../auth/LoginForm';
import { RegisterForm } from '../auth/RegisterForm';

/**
 * Account management tab. Migrated from the old `HeaderDropdown` popup.
 * - Authenticated: show email, provider avatar, sign-out button.
 * - Anonymous: show Login / Register modal (re-uses existing forms).
 */
export const AccountTab: React.FC = () => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);

  const userInfo = useMemo(() => {
    if (!user) return null;
    const email = user.email;
    let provider: 'google' | 'github' | 'email' = 'email';
    if (email.endsWith('@gmail.com')) provider = 'google';
    else if (email.includes('github')) provider = 'github';
    return {
      email,
      provider,
      initial: email.charAt(0).toUpperCase(),
    };
  }, [user]);

  const handleSignOut = async () => {
    try {
      await dispatch(signOut()).unwrap();
    } catch (error) {
      console.error('登出失败:', error);
    }
  };

  if (isAuthenticated && userInfo) {
    return (
      <div className="max-w-xl space-y-6">
        <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            已登录账户
          </h3>
          <div className="mt-4 flex items-center gap-3">
            {userInfo.provider === 'google' ? (
              <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-white dark:border-gray-700">
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>
                  <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>
                </svg>
              </div>
            ) : userInfo.provider === 'github' ? (
              <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-white dark:border-gray-700">
                <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-100 text-primary-600 dark:bg-primary-900/40 dark:text-primary-300">
                <span className="text-lg font-bold">{userInfo.initial}</span>
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {userInfo.email}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                已登录云端账户
              </p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="mt-5 inline-flex items-center justify-center rounded-lg border border-gray-300 bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 flat-interaction"
          >
            退出登录
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <section className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          登录 / 注册
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          登录后可使用云端同步、多设备同步等功能。
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setAuthMode('login')}
            className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 flat-interaction"
          >
            登录
          </button>
          <button
            onClick={() => setAuthMode('register')}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 flat-interaction"
          >
            注册
          </button>
        </div>
      </section>

      {authMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-gray-800">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div className="flex gap-1">
                <button
                  className={
                    'px-3 py-2 text-sm font-medium flat-interaction ' +
                    (authMode === 'login'
                      ? 'border-b-2 border-primary-600 text-primary-600'
                      : 'text-gray-600 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400')
                  }
                  onClick={() => setAuthMode('login')}
                >
                  登录
                </button>
                <button
                  className={
                    'px-3 py-2 text-sm font-medium flat-interaction ' +
                    (authMode === 'register'
                      ? 'border-b-2 border-primary-600 text-primary-600'
                      : 'text-gray-600 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400')
                  }
                  onClick={() => setAuthMode('register')}
                >
                  注册
                </button>
              </div>
              <button
                onClick={() => setAuthMode(null)}
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 flat-interaction"
                aria-label="关闭登录窗口"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="p-6">
              {authMode === 'login' ? (
                <LoginForm
                  onSuccess={() => {
                    setAuthMode(null);
                  }}
                />
              ) : (
                <RegisterForm
                  onSuccess={() => {
                    setAuthMode(null);
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountTab;
