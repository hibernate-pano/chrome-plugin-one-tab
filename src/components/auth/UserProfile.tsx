import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';

export const UserProfile: React.FC = () => {
  const dispatch = useAppDispatch();
  const { user } = useAppSelector(state => state.auth);
  const { syncStatus, lastSyncTime } = useAppSelector(state => state.tabs);

  const handleSignOut = async () => {
    await dispatch(signOut());
  };

  const handleSync = async () => {
    try {
      // 使用后台同步模式减少UI卡顿
      await dispatch(syncTabsFromCloud({ background: true }));
      await dispatch(syncTabsToCloud({ background: true }));
    } catch (error) {
      console.error('同步失败:', error);
    }
  };

  if (!user) return null;

  return (
    <div className="container mx-auto max-w-6xl py-4 px-4 border-b border-gray-200">
      <div className="bg-white shadow-sm rounded-lg p-6 border border-gray-200">
        <div className="flex justify-between items-center">
          <div>
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center">
                <span className="text-lg font-bold">{user.email.charAt(0).toUpperCase()}</span>
              </div>
              <div>
                <h3 className="font-medium text-gray-800">{user.email}</h3>
                <p className="text-sm text-gray-500">
                  {lastSyncTime
                    ? `上次同步: ${new Date(lastSyncTime).toLocaleString()}`
                    : '尚未同步'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex space-x-3">
            <button
              onClick={handleSync}
              className="px-4 py-2 bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100 transition-all border border-primary-200 font-medium flex items-center"
              disabled={syncStatus === 'syncing'}
            >
              {syncStatus === 'syncing' ? (
                <span className="flex items-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-primary-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  同步中
                </span>
              ) : (
                <span className="flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  同步数据
                </span>
              )}
            </button>
            <button
              onClick={handleSignOut}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-all border border-gray-300 font-medium"
            >
              退出登录
            </button>
          </div>
        </div>

        {syncStatus === 'error' && (
          <div className="mt-4 bg-red-50 border-l-4 border-red-500 text-red-700 p-4 rounded-lg">
            <div className="flex items-center">
              <svg className="h-5 w-5 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>同步失败，请重试</span>
            </div>
          </div>
        )}

        {!lastSyncTime && syncStatus !== 'syncing' && (
          <div className="mt-4 bg-blue-50 border-l-4 border-blue-500 text-blue-700 p-4 rounded-lg">
            <div className="flex items-center">
              <svg className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>点击“同步数据”按钮将您的标签组备份到云端，以便在其他设备上访问。</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
