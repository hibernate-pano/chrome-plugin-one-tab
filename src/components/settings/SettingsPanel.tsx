import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  toggleShowNotifications,
  setGroupNameTemplate,
} from '@/store/slices/settingsSlice';
import { SyncSettings } from './SyncSettings';
import { ThemeToggle } from './ThemeToggle';

export const SettingsPanel: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);

  return (
    <div className="p-4 space-y-6">
      <h2 className="text-xl font-bold mb-4">设置</h2>

      {/* 标签组设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">标签组设置</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">标签组名称模板</label>
            <input
              type="text"
              value={settings.groupNameTemplate}
              onChange={(e) => dispatch(setGroupNameTemplate(e.target.value))}
              placeholder="例如：标签组 %Y-%m-%d %H:%M"
              className="
                w-full px-3 py-2 rounded
                bg-white dark:bg-gray-700
                border border-gray-300 dark:border-gray-600
                text-gray-900 dark:text-gray-100
                focus:outline-none focus:ring-2 focus:ring-blue-500
              "
            />
            <p className="mt-1 text-sm text-gray-500">
              支持的变量：%Y (年), %m (月), %d (日), %H (时), %M (分)
            </p>
          </div>
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.allowDuplicateTabs}
              onChange={() => dispatch(toggleAllowDuplicateTabs())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
                dark:bg-gray-700 dark:border-gray-600
              "
            />
            <span>允许保存重复的标签页</span>
          </label>
        </div>
      </div>

      {/* 主题设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">主题设置</h3>
        <div className="mt-2">
          <p className="text-sm text-gray-500 mb-2">选择主题模式：</p>
          <ThemeToggle />
        </div>
      </div>

      {/* 显示设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">显示设置</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.showFavicons}
              onChange={() => dispatch(toggleShowFavicons())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
                dark:bg-gray-700 dark:border-gray-600
              "
            />
            <span>显示网站图标</span>
          </label>
        </div>
      </div>

      {/* 操作确认设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">操作确认设置</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.confirmBeforeDelete}
              onChange={() => dispatch(toggleConfirmBeforeDelete())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
                dark:bg-gray-700 dark:border-gray-600
              "
            />
            <span>删除前确认</span>
          </label>
        </div>
      </div>

      {/* 通知设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">通知设置</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.showNotifications}
              onChange={() => dispatch(toggleShowNotifications())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
                dark:bg-gray-700 dark:border-gray-600
              "
            />
            <span>显示通知</span>
          </label>
          <p className="text-sm text-gray-500 ml-6">
            关闭后将不再显示标签保存、同步等通知，避免打扰用户
          </p>
        </div>
      </div>

      {/* 新增：同步设置 */}
      <div className="border-t pt-4">
        <h3 className="text-lg font-semibold mb-2">数据同步</h3>
        <SyncSettings />
      </div>
    </div>
  );
};

export default SettingsPanel;