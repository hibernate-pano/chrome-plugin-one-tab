import React, { useState } from 'react';
import { syncChecker, SyncStatusInfo, FixResult } from '@/utils/syncChecker';
import { useAppDispatch } from '@/store/hooks';
import { setGroups } from '@/store/slices/tabSlice';

/**
 * 同步状态检查组件
 * 用于检查本地和云端数据是否一致，并提供修复选项
 */
export const SyncStatusChecker: React.FC = () => {
  const dispatch = useAppDispatch();
  const [isChecking, setIsChecking] = useState(false);
  const [statusInfo, setStatusInfo] = useState<SyncStatusInfo | null>(null);
  const [isFixing, setIsFixing] = useState(false);
  const [fixResult, setFixResult] = useState<FixResult | null>(null);

  // 检查同步状态
  const checkSyncStatus = async () => {
    setIsChecking(true);
    setFixResult(null);

    try {
      const info = await syncChecker.checkSyncStatus();
      setStatusInfo(info);
    } catch (error) {
      console.error('检查同步状态失败:', error);
    } finally {
      setIsChecking(false);
    }
  };

  // 修复同步问题
  const fixSyncIssues = async (action: 'upload' | 'download' | 'merge') => {
    setIsFixing(true);

    try {
      const result = await syncChecker.fixSyncIssues(action);
      setFixResult(result);

      if (result.success) {
        // 重新检查同步状态
        const info = await syncChecker.checkSyncStatus();
        setStatusInfo(info);

        // 如果是下载或合并操作，更新Redux状态
        if (action === 'download' || action === 'merge') {
          const groups = await chrome.storage.local.get('groups');
          dispatch(setGroups(groups.groups || []));
        }
      }
    } catch (error) {
      console.error('修复同步问题失败:', error);
    } finally {
      setIsFixing(false);
    }
  };

  // 获取同步状态文本
  const getSyncStatusText = (status: string) => {
    switch (status) {
      case 'synced':
        return '已同步';
      case 'local-ahead':
        return '本地领先';
      case 'cloud-ahead':
        return '云端领先';
      case 'diverged':
        return '已分叉';
      default:
        return '未知';
    }
  };

  // 获取同步状态颜色
  const getSyncStatusColor = (status: string) => {
    switch (status) {
      case 'synced':
        return 'text-green-500';
      case 'local-ahead':
      case 'cloud-ahead':
        return 'text-yellow-500';
      case 'diverged':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  // 渲染修复按钮
  const renderFixButtons = () => {
    if (!statusInfo || statusInfo.syncStatus === 'synced') {
      return null;
    }

    return (
      <div className="mt-4 flex flex-wrap gap-2">
        {statusInfo.syncStatus === 'local-ahead' && (
          <button
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            onClick={() => fixSyncIssues('upload')}
            disabled={isFixing}
          >
            上传本地数据到云端
          </button>
        )}

        {statusInfo.syncStatus === 'cloud-ahead' && (
          <button
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            onClick={() => fixSyncIssues('download')}
            disabled={isFixing}
          >
            从云端下载数据
          </button>
        )}

        {statusInfo.syncStatus === 'diverged' && (
          <button
            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            onClick={() => fixSyncIssues('merge')}
            disabled={isFixing}
          >
            合并本地和云端数据
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow p-4 mb-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">同步状态检查</h2>
        <button
          className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
          onClick={checkSyncStatus}
          disabled={isChecking}
        >
          {isChecking ? '检查中...' : '检查同步状态'}
        </button>
      </div>

      {statusInfo && (
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-50 p-2 rounded">
              <div className="text-sm text-gray-500">本地标签组</div>
              <div className="text-lg font-semibold">{statusInfo.localGroupCount}</div>
            </div>
            <div className="bg-gray-50 p-2 rounded">
              <div className="text-sm text-gray-500">云端标签组</div>
              <div className="text-lg font-semibold">{statusInfo.cloudGroupCount}</div>
            </div>
            <div className="bg-gray-50 p-2 rounded">
              <div className="text-sm text-gray-500">本地标签页</div>
              <div className="text-lg font-semibold">{statusInfo.localTabCount}</div>
            </div>
            <div className="bg-gray-50 p-2 rounded">
              <div className="text-sm text-gray-500">云端标签页</div>
              <div className="text-lg font-semibold">{statusInfo.cloudTabCount}</div>
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center">
              <span className="text-sm text-gray-500 mr-2">同步状态:</span>
              <span className={`font-semibold ${getSyncStatusColor(statusInfo.syncStatus)}`}>
                {getSyncStatusText(statusInfo.syncStatus)}
              </span>
            </div>

            {statusInfo.localOnlyGroups.length > 0 && (
              <div className="text-sm mt-1">
                <span className="text-yellow-500">本地独有:</span> {statusInfo.localOnlyGroups.length} 个标签组
              </div>
            )}

            {statusInfo.cloudOnlyGroups.length > 0 && (
              <div className="text-sm mt-1">
                <span className="text-yellow-500">云端独有:</span> {statusInfo.cloudOnlyGroups.length} 个标签组
              </div>
            )}

            <div className="text-xs text-gray-400 mt-1">
              最后检查: {new Date(statusInfo.lastChecked).toLocaleString()}
            </div>
          </div>

          {renderFixButtons()}
        </div>
      )}

      {fixResult && (
        <div className={`mt-4 p-2 rounded text-sm ${fixResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {fixResult.message}
        </div>
      )}
    </div>
  );
};
