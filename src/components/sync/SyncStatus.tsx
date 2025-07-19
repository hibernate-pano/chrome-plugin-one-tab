import React from 'react';
import { useAppSelector } from '@/app/store/hooks';

export const SyncStatus: React.FC = () => {
  const { lastSyncTime, status: syncStatus } = useAppSelector(state => state.sync);
  const { status } = useAppSelector(state => state.auth);
  const isAuthenticated = status === 'authenticated';
  const { syncEnabled, autoSyncEnabled } = useAppSelector(state => state.settings);

  // 格式化最后同步时间 - 这个函数已经通过getStatusIndicator内部实现了

  // 获取状态指示器的颜色和图标
  const getStatusIndicator = () => {
    if (syncStatus === 'syncing') {
      return { color: 'text-blue-500', icon: '🔄', label: '同步中...' };
    }
    
    if (!lastSyncTime) {
      return { color: 'text-gray-500', icon: '⚠️', label: '从未同步' };
    }
    
    try {
      const syncTime = new Date(lastSyncTime);
      const now = new Date();
      const diffMs = now.getTime() - syncTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      
      if (diffHours < 1) {
        return { color: 'text-green-500', icon: '✅', label: '最近已同步' };
      } else if (diffHours < 24) {
        return { color: 'text-green-400', icon: '✓', label: `${Math.floor(diffHours)}小时前同步` };
      } else if (diffHours < 72) {
        return { color: 'text-yellow-500', icon: '⚠️', label: `${Math.floor(diffHours / 24)}天前同步` };
      } else {
        return { color: 'text-red-500', icon: '⚠️', label: '长时间未同步' };
      }
    } catch (e) {
      return { color: 'text-gray-500', icon: '❓', label: '同步状态未知' };
    }
  };

  if (!isAuthenticated || !syncEnabled) {
    return null;
  }

  const statusIndicator = getStatusIndicator();

  return (
    <div className="text-xs flex items-center justify-center mt-1 mb-2">
      <span className={`inline-flex items-center ${statusIndicator.color}`}>
        <span className="mr-1">{statusIndicator.icon}</span>
        <span>{statusIndicator.label}</span>
        {autoSyncEnabled && (
          <span className="ml-1 text-gray-400">(自动同步已开启)</span>
        )}
      </span>
    </div>
  );
};
