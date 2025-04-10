import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  setSyncInterval,
  toggleSyncEnabled,
  saveSettings,
} from '@/store/slices/settingsSlice';

export const SyncSettings: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  const handleSyncIntervalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(e.target.value, 10);
    dispatch(setSyncInterval(value));
    dispatch(saveSettings({ ...settings, syncInterval: value }));
  };

  const handleToggleSyncEnabled = () => {
    dispatch(toggleSyncEnabled());
    dispatch(saveSettings({ ...settings, syncEnabled: !settings.syncEnabled }));
  };

  if (!isAuthenticated) {
    return (
      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded">
        <p className="text-yellow-700">
          请先登录以启用数据同步功能
        </p>
        <p className="text-sm text-yellow-600 mt-2">
          登录后，您可以将标签组同步到云端，并在多台设备上访问。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">启用数据同步</h3>
          <p className="text-sm text-gray-500">
            在多台设备间同步您的标签组
          </p>
          <p className="text-xs text-blue-500 mt-1">
            开启后，您的标签组将自动同步到云端，并可在其他设备上访问
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={settings.syncEnabled}
            onChange={handleToggleSyncEnabled}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
        </label>
      </div>

      {settings.syncEnabled && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">同步间隔</h3>
            <p className="text-sm text-gray-500">
              设置自动同步的时间间隔
            </p>
          </div>
          <select
            className="border rounded p-2"
            value={settings.syncInterval}
            onChange={handleSyncIntervalChange}
          >
            <option value={1}>1分钟</option>
            <option value={5}>5分钟</option>
            <option value={10}>10分钟</option>
            <option value={15}>15分钟</option>
            <option value={30}>30分钟</option>
            <option value={60}>1小时</option>
          </select>
        </div>
      )}
    </div>
  );
};
