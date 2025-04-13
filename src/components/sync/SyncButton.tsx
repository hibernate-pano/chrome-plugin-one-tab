import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { syncTabsFromCloud, syncTabsToCloud } from '@/store/slices/tabSlice';
import { store } from '@/store';

interface SyncButtonProps {}

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const dispatch = useAppDispatch();
  const { syncStatus, backgroundSync } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  const handleSync = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 清除之前的防抖记录，确保手动同步能立即执行
        const { auth } = store.getState();
        if (auth.user?.id) {
          localStorage.removeItem(`lastRealtimeSyncTime_${auth.user.id}`);
          localStorage.removeItem(`lastRealtimeSettingsSyncTime_${auth.user.id}`);
        }

        // 先将本地数据同步到云端
        await dispatch(syncTabsToCloud());
        // 然后从云端同步数据
        await dispatch(syncTabsFromCloud());
        console.log('手动同步完成');
      } catch (error) {
        console.error('手动同步失败:', error);
      }
    }
  };

  if (!isAuthenticated) {
    return null; // 未登录时不显示同步按钮
  }

  return (
    <button
      onClick={handleSync}
      disabled={syncStatus === 'syncing'}
      className={`flex items-center px-3 py-1 rounded-md text-sm ${
        syncStatus === 'syncing' && !backgroundSync
          ? 'bg-blue-100 text-blue-600'
          : 'bg-green-100 text-green-600 hover:bg-green-200'
      } transition-colors`}
      title="手动同步数据"
    >
      {syncStatus === 'syncing' && !backgroundSync ? (
        <>
          <svg className="animate-spin h-4 w-4 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          同步中...
        </>
      ) : (
        <>
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          同步
        </>
      )}
    </button>
  );
};

export default SyncButton;
