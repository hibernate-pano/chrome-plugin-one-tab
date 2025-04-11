import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { UserSettings } from '@/types/tab';
import {
  toggleSyncEnabled,
  saveSettings,
} from '@/store/slices/settingsSlice';

export const SyncSettings: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  // 删除定时同步间隔设置

  const handleToggleSyncEnabled = () => {
    dispatch(toggleSyncEnabled());
    dispatch(saveSettings({ ...settings, syncEnabled: !settings.syncEnabled }));
  };

  const handleSyncStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as UserSettings['syncStrategy'];
    dispatch(saveSettings({ ...settings, syncStrategy: value }));
  };

  const handleDeleteStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as UserSettings['deleteStrategy'];
    dispatch(saveSettings({ ...settings, deleteStrategy: value }));
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
          <h3 className="font-medium">启用数据自动同步</h3>
          <p className="text-sm text-gray-500">
            在多台设备间自动同步您的标签组
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
        <>

          <div className="flex items-center justify-between mt-4">
            <div>
              <h3 className="font-medium">冲突解决策略</h3>
              <p className="text-sm text-gray-500">
                当不同设备上的数据冲突时如何处理
              </p>
            </div>
            <select
              className="border rounded p-2"
              value={settings.syncStrategy}
              onChange={handleSyncStrategyChange}
            >
              <option value="newest">使用最新版本</option>
              <option value="local">使用本地版本</option>
              <option value="remote">使用云端版本</option>
              <option value="ask">询问我</option>
            </select>
          </div>

          <div className="flex items-center justify-between mt-4">
            <div>
              <h3 className="font-medium">删除策略</h3>
              <p className="text-sm text-gray-500">
                删除标签组时的处理方式
              </p>
            </div>
            <select
              className="border rounded p-2"
              value={settings.deleteStrategy}
              onChange={handleDeleteStrategyChange}
            >
              <option value="everywhere">在所有设备上删除</option>
              <option value="local-only">仅在本地删除</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
};
