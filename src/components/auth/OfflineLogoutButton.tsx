import React, { useState } from 'react';
import { useAppDispatch } from '@/app/store/hooks';
import { signOut, forceLocalSignOut } from '@/features/auth/store/authSlice';

interface OfflineLogoutButtonProps {
  className?: string;
  children?: React.ReactNode;
}

/**
 * 离线登出按钮组件
 * 当网络连接失败时，提供强制本地登出选项
 */
export const OfflineLogoutButton: React.FC<OfflineLogoutButtonProps> = ({
  className = '',
  children = '退出登录'
}) => {
  const dispatch = useAppDispatch();
  const [isLoading, setIsLoading] = useState(false);
  const [showOfflineOption, setShowOfflineOption] = useState(false);

  const handleLogout = async () => {
    setIsLoading(true);
    setShowOfflineOption(false);

    try {
      // 首先尝试正常登出
      await dispatch(signOut()).unwrap();
      console.log('✅ 正常登出成功');
    } catch (error) {
      console.warn('⚠️ 正常登出失败，显示离线登出选项:', error);
      setShowOfflineOption(true);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForceLogout = async () => {
    setIsLoading(true);
    try {
      await dispatch(forceLocalSignOut()).unwrap();
      console.log('✅ 强制本地登出成功');
      setShowOfflineOption(false);
    } catch (error) {
      console.error('❌ 强制登出失败:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setShowOfflineOption(false);
  };

  if (showOfflineOption) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
          <div className="flex items-center space-x-2 mb-2">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span className="font-medium">网络连接失败</span>
          </div>
          <p className="text-xs mb-3">
            无法连接到服务器进行正常登出。您可以选择强制本地登出，这将清除本地的登录状态。
          </p>
          <div className="flex space-x-2">
            <button
              onClick={handleForceLogout}
              disabled={isLoading}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-xs rounded-md transition-colors duration-200 flex items-center space-x-1"
            >
              {isLoading && (
                <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              )}
              <span>强制登出</span>
            </button>
            <button
              onClick={handleCancel}
              disabled={isLoading}
              className="px-3 py-1.5 bg-gray-300 hover:bg-gray-400 disabled:bg-gray-200 text-gray-700 text-xs rounded-md transition-colors duration-200"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={handleLogout}
      disabled={isLoading}
      className={`${className} flex items-center space-x-2 transition-colors duration-200`}
    >
      {isLoading && (
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-current" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      )}
      <span>{children}</span>
    </button>
  );
};

export default OfflineLogoutButton;
