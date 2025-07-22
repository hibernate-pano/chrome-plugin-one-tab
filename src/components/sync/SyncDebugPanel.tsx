import React, { useState, useEffect } from 'react';
import { useAppSelector } from '@/app/store/hooks';
import { realtimeSync } from '@/services/realtimeSync';
import { simpleSyncService } from '@/services/simpleSyncService';

interface SyncDebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SyncDebugPanel: React.FC<SyncDebugPanelProps> = ({ isOpen, onClose }) => {
  const { status: authStatus } = useAppSelector(state => state.auth);
  const { syncEnabled, autoSyncEnabled } = useAppSelector(state => state.settings);
  const { lastSyncTime, status: syncStatus } = useAppSelector(state => state.sync);
  
  const [realtimeStatus, setRealtimeStatus] = useState<string>('disconnected');
  const [deviceId, setDeviceId] = useState<string>('');
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;

    const updateStatus = () => {
      setRealtimeStatus(realtimeSync.getConnectionStatus());
    };

    const getDeviceId = async () => {
      try {
        const { deviceId } = await chrome.storage.local.get('deviceId');
        setDeviceId(deviceId || '未设置');
      } catch (error) {
        setDeviceId('获取失败');
      }
    };

    updateStatus();
    getDeviceId();

    const interval = setInterval(updateStatus, 2000);
    return () => clearInterval(interval);
  }, [isOpen]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs(prev => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  };

  const handleForceReconnect = async () => {
    addLog('用户触发强制重连');
    try {
      await realtimeSync.forceReconnect();
      addLog('强制重连完成');
    } catch (error) {
      addLog(`强制重连失败: ${error}`);
    }
  };

  const handleTestUpload = () => {
    addLog('用户触发测试上传');
    simpleSyncService.scheduleUpload();
    addLog('测试上传已安排');
  };

  const handleTestDownload = async () => {
    addLog('用户触发测试下载');
    try {
      await simpleSyncService.downloadFromCloud();
      addLog('测试下载完成');
    } catch (error) {
      addLog(`测试下载失败: ${error}`);
    }
  };

  const handleClearLogs = () => {
    setDebugLogs([]);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            同步调试面板
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        {/* 状态信息 */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="space-y-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">认证状态</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              状态: <span className={authStatus === 'authenticated' ? 'text-green-600' : 'text-red-600'}>
                {authStatus}
              </span>
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              设备ID: <span className="font-mono text-xs">{deviceId}</span>
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">同步设置</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              同步启用: <span className={syncEnabled ? 'text-green-600' : 'text-red-600'}>
                {syncEnabled ? '是' : '否'}
              </span>
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              自动同步: <span className={autoSyncEnabled ? 'text-green-600' : 'text-red-600'}>
                {autoSyncEnabled ? '是' : '否'}
              </span>
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">同步状态</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              当前状态: <span className="font-mono">{syncStatus}</span>
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              最后同步: <span className="font-mono text-xs">
                {lastSyncTime ? new Date(lastSyncTime).toLocaleString() : '从未同步'}
              </span>
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">实时同步</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              连接状态: <span className={`font-mono ${
                realtimeStatus === 'connected' ? 'text-green-600' :
                realtimeStatus === 'connecting' ? 'text-yellow-600' :
                realtimeStatus === 'error' ? 'text-red-600' : 'text-gray-600'
              }`}>
                {realtimeStatus}
              </span>
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={handleForceReconnect}
            className="px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"
          >
            强制重连
          </button>
          <button
            onClick={handleTestUpload}
            className="px-3 py-1 bg-green-500 text-white rounded text-sm hover:bg-green-600"
          >
            测试上传
          </button>
          <button
            onClick={handleTestDownload}
            className="px-3 py-1 bg-purple-500 text-white rounded text-sm hover:bg-purple-600"
          >
            测试下载
          </button>
          <button
            onClick={handleClearLogs}
            className="px-3 py-1 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
          >
            清除日志
          </button>
        </div>

        {/* 调试日志 */}
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">调试日志</h3>
          <div className="bg-gray-100 dark:bg-gray-700 rounded p-3 h-40 overflow-y-auto">
            {debugLogs.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">暂无日志</p>
            ) : (
              debugLogs.map((log, index) => (
                <div key={index} className="text-xs font-mono text-gray-700 dark:text-gray-300 mb-1">
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
