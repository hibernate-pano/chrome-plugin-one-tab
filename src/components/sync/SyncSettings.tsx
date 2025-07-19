import React from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import {
  toggleSyncEnabled,
  toggleAutoSyncEnabled,
  toggleShowManualSyncButtons,
  setSyncInterval,
  saveSettings
} from '@/features/settings/store/settingsSlice';

export const SyncSettings: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  const { status } = useAppSelector(state => state.auth);
  const isAuthenticated = status === 'authenticated';

  const handleSyncEnabledChange = async () => {
    dispatch(toggleSyncEnabled());
    await dispatch(saveSettings({
      ...settings,
      syncEnabled: !settings.syncEnabled
    }));
  };

  const handleAutoSyncEnabledChange = async () => {
    dispatch(toggleAutoSyncEnabled());
    await dispatch(saveSettings({
      ...settings,
      autoSyncEnabled: !settings.autoSyncEnabled
    }));
  };
  
  const handleShowManualSyncButtonsChange = async () => {
    dispatch(toggleShowManualSyncButtons());
    await dispatch(saveSettings({
      ...settings,
      showManualSyncButtons: !settings.showManualSyncButtons
    }));
  };

  const handleSyncIntervalChange = async (interval: number) => {
    console.log('🔄 更改同步间隔：', interval);
    dispatch(setSyncInterval(interval));
    await dispatch(saveSettings({
      ...settings,
      syncInterval: interval
    }));
  };

  if (!isAuthenticated) {
    return (
      <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <p className="text-sm text-gray-600 dark:text-gray-400 text-center">
          请先登录以启用同步功能
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="p-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          📱 同步设置
        </h3>
        
        {/* 调试信息 */}
        <div className="mb-4 p-2 bg-gray-50 dark:bg-gray-900 rounded text-xs">
          <div>当前设置：syncInterval = {settings.syncInterval}</div>
          <div>autoSyncEnabled = {settings.autoSyncEnabled ? 'true' : 'false'}</div>
        </div>

        {/* 基础同步开关 */}
        <div className="flex items-center justify-between py-2">
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100">
              启用同步
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              允许数据在设备间同步
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.syncEnabled}
              onChange={handleSyncEnabledChange}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
          </label>
        </div>

        {/* 自动同步开关 */}
        <div className="flex items-center justify-between py-2 border-t border-gray-100 dark:border-gray-700 mt-3 pt-3">
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100">
              🔄 智能自动同步
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              在操作后自动同步数据
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoSyncEnabled && settings.syncEnabled}
              onChange={handleAutoSyncEnabledChange}
              disabled={!settings.syncEnabled}
              className="sr-only peer"
            />
            <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600 ${!settings.syncEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}></div>
          </label>
        </div>

                  {/* 同步间隔设置 */}
        {settings.syncEnabled && settings.autoSyncEnabled && (
          <div className="py-2 border-t border-gray-100 dark:border-gray-700 mt-3 pt-3">
            <div className="font-medium text-gray-900 dark:text-gray-100 mb-2">
              ⏱️ 定期同步间隔
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[5, 10, 30].map(interval => (
                <button
                  key={interval}
                  onClick={() => handleSyncIntervalChange(interval)}
                  className={`px-3 py-2 text-sm rounded-md transition-colors ${
                    settings.syncInterval === interval
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  {interval}分钟
                </button>
              ))}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              除了定期同步外，还会在操作后自动同步
            </div>
          </div>
        )}

        {/* 手动同步按钮显示设置 */}
        <div className="flex items-center justify-between py-2 border-t border-gray-100 dark:border-gray-700 mt-3 pt-3">
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100">
              👋 显示手动同步按钮
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              在界面中显示手动上传/下载按钮
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.showManualSyncButtons && settings.syncEnabled}
              onChange={handleShowManualSyncButtonsChange}
              disabled={!settings.syncEnabled}
              className="sr-only peer"
            />
            <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600 ${!settings.syncEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}></div>
          </label>
        </div>

        {/* 同步状态说明 */}
        <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <div className="font-medium mb-1">💡 智能双向同步说明：</div>
            <ul className="space-y-1 text-xs">
              <li>• 登录后自动检查并下载云端数据</li>
              <li>• 操作后3秒内自动上传到云端</li>
              <li>• 定期检查云端数据更新并自动下载</li>
              <li>• 智能合并，避免数据冲突</li>
              <li>• 防抖处理，避免频繁同步</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};