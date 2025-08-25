import React, { useEffect, useState } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { toast } from '@/shared/utils/toast';

interface SyncError {
  message: string;
  timestamp: string;
  recoverable: boolean;
  action?: string;
}

/**
 * 同步状态监控组件
 * 监控同步状态变化并提供用户反馈
 */
export const SyncStatusMonitor: React.FC = () => {
  const { status: syncStatus, lastSyncTime, error } = useAppSelector(state => state.sync);
  const { status: authStatus } = useAppSelector(state => state.auth);
  const [lastError, setLastError] = useState<SyncError | null>(null);
  const [syncInProgress, setSyncInProgress] = useState(false);

  // 监控同步状态变化
  useEffect(() => {
    if (syncStatus === 'syncing' && !syncInProgress) {
      setSyncInProgress(true);
      toast.info('正在同步数据...', { duration: 0, id: 'sync-progress' });
    } else if (syncStatus === 'idle' && syncInProgress) {
      setSyncInProgress(false);
      toast.dismiss('sync-progress');
      
      if (lastSyncTime) {
        toast.success('数据同步完成', { duration: 3000 });
      }
    } else if (syncStatus === 'error' && error) {
      setSyncInProgress(false);
      toast.dismiss('sync-progress');
      
      const syncError: SyncError = {
        message: error,
        timestamp: new Date().toISOString(),
        recoverable: true,
      };
      
      setLastError(syncError);
      
      // 显示用户友好的错误信息
      if (error.includes('网络')) {
        toast.error('网络连接不稳定，数据已保存到本地', {
          duration: 5000,
          action: {
            label: '重试',
            onClick: () => handleRetrySync(),
          },
        });
      } else if (error.includes('认证') || error.includes('登录')) {
        toast.error('登录状态已过期，请重新登录', {
          duration: 0,
          action: {
            label: '重新登录',
            onClick: () => handleReauth(),
          },
        });
      } else if (error.includes('冲突')) {
        toast.warning('检测到数据冲突，需要手动解决', {
          duration: 0,
          action: {
            label: '查看冲突',
            onClick: () => handleViewConflicts(),
          },
        });
      } else {
        toast.error(`同步失败: ${error}`, {
          duration: 5000,
          action: {
            label: '重试',
            onClick: () => handleRetrySync(),
          },
        });
      }
    }
  }, [syncStatus, error, syncInProgress, lastSyncTime]);

  // 监控认证状态变化
  useEffect(() => {
    if (authStatus === 'unauthenticated' && syncInProgress) {
      setSyncInProgress(false);
      toast.dismiss('sync-progress');
      toast.warning('用户已登出，同步已停止');
    }
  }, [authStatus, syncInProgress]);

  const handleRetrySync = async () => {
    try {
      // 这里可以调用同步服务重试
      const { syncService } = await import('@/services/syncService');
      await syncService.syncAll(false);
    } catch (error) {
      console.error('重试同步失败:', error);
    }
  };

  const handleReauth = () => {
    // 触发重新认证流程
    window.location.hash = '#auth';
  };

  const handleViewConflicts = () => {
    // 打开冲突解决界面
    window.location.hash = '#conflicts';
  };

  // 计算同步状态指示器
  const getSyncStatusIndicator = () => {
    if (authStatus !== 'authenticated') {
      return {
        color: 'gray',
        text: '未登录',
        icon: '⚪',
      };
    }

    switch (syncStatus) {
      case 'syncing':
        return {
          color: 'blue',
          text: '同步中',
          icon: '🔄',
        };
      case 'error':
        return {
          color: 'red',
          text: '同步失败',
          icon: '❌',
        };
      case 'idle':
        if (lastSyncTime) {
          const timeDiff = Date.now() - new Date(lastSyncTime).getTime();
          const minutes = Math.floor(timeDiff / 60000);
          
          if (minutes < 1) {
            return {
              color: 'green',
              text: '刚刚同步',
              icon: '✅',
            };
          } else if (minutes < 60) {
            return {
              color: 'green',
              text: `${minutes}分钟前`,
              icon: '✅',
            };
          } else {
            return {
              color: 'yellow',
              text: '需要同步',
              icon: '⚠️',
            };
          }
        }
        return {
          color: 'gray',
          text: '未同步',
          icon: '⚪',
        };
      default:
        return {
          color: 'gray',
          text: '未知状态',
          icon: '❓',
        };
    }
  };

  const statusIndicator = getSyncStatusIndicator();

  return (
    <div className="sync-status-monitor">
      {/* 状态指示器 */}
      <div className={`sync-indicator sync-indicator--${statusIndicator.color}`}>
        <span className="sync-indicator__icon">{statusIndicator.icon}</span>
        <span className="sync-indicator__text">{statusIndicator.text}</span>
      </div>

      {/* 错误详情（仅在开发模式下显示） */}
      {process.env.NODE_ENV === 'development' && lastError && (
        <div className="sync-error-details">
          <h4>同步错误详情</h4>
          <p>消息: {lastError.message}</p>
          <p>时间: {new Date(lastError.timestamp).toLocaleString()}</p>
          <p>可恢复: {lastError.recoverable ? '是' : '否'}</p>
        </div>
      )}
    </div>
  );
};

// CSS样式（可以移到单独的CSS文件中）
const styles = `
.sync-status-monitor {
  position: relative;
}

.sync-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.sync-indicator--green {
  background-color: #dcfce7;
  color: #166534;
}

.sync-indicator--blue {
  background-color: #dbeafe;
  color: #1e40af;
}

.sync-indicator--yellow {
  background-color: #fef3c7;
  color: #92400e;
}

.sync-indicator--red {
  background-color: #fee2e2;
  color: #dc2626;
}

.sync-indicator--gray {
  background-color: #f3f4f6;
  color: #6b7280;
}

.sync-indicator__icon {
  animation: spin 1s linear infinite;
}

.sync-indicator--blue .sync-indicator__icon {
  animation: spin 1s linear infinite;
}

.sync-indicator:not(.sync-indicator--blue) .sync-indicator__icon {
  animation: none;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.sync-error-details {
  position: absolute;
  top: 100%;
  left: 0;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 8px;
  font-size: 11px;
  z-index: 1000;
  min-width: 200px;
}
`;

// 注入样式
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = styles;
  document.head.appendChild(styleElement);
}
