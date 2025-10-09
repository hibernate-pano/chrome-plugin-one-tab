import React, { useEffect, useState } from 'react';
import { smartSyncService } from '@/services/smartSyncService';
import { useAppSelector } from '@/store/hooks';

interface SyncStatus {
  isAutoSyncEnabled: boolean;
  syncInterval: number;
  lastSyncTime: string | null;
  pendingTasks: any[];
  currentTask: any | null;
}

interface SyncStatusIndicatorProps {
  /**
   * 显示模式
   * - 'compact': 紧凑模式，只显示图标和简短文字
   * - 'detailed': 详细模式，显示更多信息
   */
  mode?: 'compact' | 'detailed';
  /**
   * 是否在工具提示中显示详细信息
   */
  showTooltip?: boolean;
}

/**
 * 同步状态指示器组件
 * 显示当前同步状态和最后同步时间
 * 
 * 用法：
 * ```tsx
 * <SyncStatusIndicator mode="compact" />
 * ```
 */
export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({ 
  mode = 'compact',
  showTooltip = true 
}) => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  useEffect(() => {
    // 只在用户已登录时显示同步状态
    if (!isAuthenticated) {
      setSyncStatus(null);
      return;
    }

    // 初始获取同步状态
    updateSyncStatus();

    // 定时更新同步状态（每10秒）
    const interval = setInterval(updateSyncStatus, 10000);

    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const updateSyncStatus = () => {
    try {
      const status = smartSyncService.getSyncStatus();
      setSyncStatus(status);
    } catch (error) {
      console.error('获取同步状态失败:', error);
    }
  };

  // 格式化最后同步时间
  const formatLastSyncTime = (timeString: string | null) => {
    if (!timeString) return '从未同步';
    
    const syncTime = new Date(timeString);
    const now = new Date();
    const diffMs = now.getTime() - syncTime.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return '刚刚同步';
    if (diffMins < 60) return `${diffMins}分钟前`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}小时前`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}天前`;
  };

  // 未登录时不显示
  if (!isAuthenticated || !syncStatus) {
    return null;
  }

  // 构建工具提示内容
  const tooltipContent = showTooltip ? [
    syncStatus.lastSyncTime ? `最后同步: ${new Date(syncStatus.lastSyncTime).toLocaleString()}` : '从未同步',
    syncStatus.isAutoSyncEnabled ? `自动同步: 每${syncStatus.syncInterval / 60000}分钟` : '自动同步已禁用',
    syncStatus.currentTask ? '正在同步...' : '',
    syncStatus.pendingTasks.length > 0 ? `待同步任务: ${syncStatus.pendingTasks.length}个` : ''
  ].filter(Boolean).join('\n') : '';

  // 紧凑模式
  if (mode === 'compact') {
    return (
      <div 
        className="flex items-center space-x-1 text-xs group cursor-help"
        title={tooltipContent}
      >
        {/* 状态指示点 */}
        {syncStatus.currentTask ? (
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" title="正在同步"></div>
        ) : syncStatus.pendingTasks.length > 0 ? (
          <div className="w-2 h-2 bg-yellow-500 rounded-full" title={`待同步 ${syncStatus.pendingTasks.length} 个任务`}></div>
        ) : syncStatus.isAutoSyncEnabled ? (
          <div className="w-2 h-2 bg-green-500 rounded-full" title="自动同步已启用"></div>
        ) : (
          <div className="w-2 h-2 bg-gray-400 rounded-full" title="自动同步已禁用"></div>
        )}
      </div>
    );
  }

  // 详细模式
  return (
    <div 
      className="flex items-center space-x-2 text-xs group"
      title={tooltipContent}
    >
      {/* 同步状态图标和文字 */}
      <div className="flex items-center space-x-1">
        {syncStatus.currentTask ? (
          <>
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span className="text-blue-600 dark:text-blue-400">同步中...</span>
          </>
        ) : syncStatus.pendingTasks.length > 0 ? (
          <>
            <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
            <span className="text-yellow-600 dark:text-yellow-400">
              待同步 ({syncStatus.pendingTasks.length})
            </span>
          </>
        ) : syncStatus.isAutoSyncEnabled ? (
          <>
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <span className="text-gray-500 dark:text-gray-400">
              自动同步
            </span>
          </>
        ) : (
          <>
            <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
            <span className="text-gray-400 dark:text-gray-500">
              已禁用
            </span>
          </>
        )}
      </div>

      {/* 最后同步时间 */}
      {syncStatus.lastSyncTime && (
        <span className="text-gray-400 dark:text-gray-500">
          · {formatLastSyncTime(syncStatus.lastSyncTime)}
        </span>
      )}
    </div>
  );
};

export default SyncStatusIndicator;

