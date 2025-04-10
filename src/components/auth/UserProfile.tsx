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
      await dispatch(syncTabsFromCloud());
      await dispatch(syncTabsToCloud());
    } catch (error) {
      console.error('同步失败:', error);
    }
  };

  if (!user) return null;

  return (
    <div className="p-4 border-b">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-medium">{user.email}</h3>
          <p className="text-sm text-gray-500">
            {lastSyncTime
              ? `上次同步: ${new Date(lastSyncTime).toLocaleString()}`
              : '尚未同步'}
          </p>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={handleSync}
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
            disabled={syncStatus === 'syncing'}
          >
            {syncStatus === 'syncing' ? '同步中...' : '立即同步'}
          </button>
          <button
            onClick={handleSignOut}
            className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300"
          >
            退出
          </button>
        </div>
      </div>
      {syncStatus === 'success' && lastSyncTime && (
        <div className="mt-2 text-sm text-green-500">
          数据同步成功！您的标签组已在云端备份。
        </div>
      )}
      {syncStatus === 'error' && (
        <div className="mt-2 text-sm text-red-500">
          同步失败，请重试
        </div>
      )}
      {!lastSyncTime && syncStatus !== 'syncing' && (
        <div className="mt-2 text-sm text-blue-500">
          点击“立即同步”按钮将您的标签组同步到云端，以便在其他设备上访问。
        </div>
      )}
    </div>
  );
};
