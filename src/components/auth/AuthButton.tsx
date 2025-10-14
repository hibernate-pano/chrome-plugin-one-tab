import React, { useState, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';

export const AuthButton: React.FC = () => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const { lastSyncTime } = useAppSelector(state => state.tabs);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [initialRender, setInitialRender] = useState(true);

  // 首次渲染后标记为非初始渲染状态
  useEffect(() => {
    if (initialRender) {
      // 使用微任务延迟标记，确保缓存数据已加载
      setTimeout(() => setInitialRender(false), 0);
    }
  }, [initialRender]);

  const handleSignOut = async () => {
    await dispatch(signOut());
    setShowDropdown(false);
  };

  // 在初始渲染时不显示任何内容，避免闪烁
  if (initialRender) {
    return null;
  }

  if (isAuthenticated && user) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center space-x-2 px-3 py-2 rounded-lg hover:bg-gray-100 transition-all"
        >
          <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center">
            <span className="text-sm font-bold">{user.email.charAt(0).toUpperCase()}</span>
          </div>
          <div className="hidden sm:block">
            <div className="text-gray-700 font-medium">{user.email}</div>
            <div className="text-xs text-gray-500 flex items-center">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>
              已登录
            </div>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {showDropdown && (
          <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
            <div className="py-2">
              <div className="px-4 py-2 border-b border-gray-100">
                <p className="text-sm font-medium text-gray-900">{user.email}</p>
                <p className="text-xs text-gray-500 flex items-center">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                  已登录
                  {lastSyncTime && (
                    <span className="ml-2 text-gray-400">· 上次同步: {new Date(lastSyncTime).toLocaleString()}</span>
                  )}
                </p>
              </div>
              <button
                onClick={handleSignOut}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                退出登录
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowAuthModal(true)}
        className="px-4 py-1.5 rounded text-sm transition-colors bg-primary-600 text-white hover:bg-primary-700 border border-primary-600 min-w-[100px] text-center"
      >
        登录 / 注册
      </button>

      {showAuthModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="flex border-b border-gray-200">
              <button
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'login' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 hover:text-primary-600'}`}
                onClick={() => setActiveTab('login')}
              >
                登录
              </button>
              <button
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'register' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 hover:text-primary-600'}`}
                onClick={() => setActiveTab('register')}
              >
                注册
              </button>
              <button
                className="p-3 text-gray-500 hover:text-gray-700"
                onClick={() => setShowAuthModal(false)}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              {activeTab === 'login' ? (
                <LoginForm onSuccess={() => setShowAuthModal(false)} />
              ) : (
                <RegisterForm onSuccess={() => setShowAuthModal(false)} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
