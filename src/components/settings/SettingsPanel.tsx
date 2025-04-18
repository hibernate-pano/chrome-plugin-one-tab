import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  setGroupNameTemplate,
  saveSettings,
} from '@/store/slices/settingsSlice';
import { useTheme } from '@/contexts/ThemeContext';

export const SettingsPanel: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  const { themeMode, setThemeMode } = useTheme();
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // 保存设置
  const handleSaveSettings = () => {
    setIsSaving(true);
    dispatch(saveSettings(settings))
      .then(() => {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 3000);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  // 切换主题
  const toggleTheme = () => {
    const newMode = themeMode === 'light' ? 'dark' : 'light';
    setThemeMode(newMode);

    // 同时保存设置到存储
    dispatch(saveSettings({ ...settings, themeMode: newMode }));
  };

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

      {/* 主题设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">主题设置</h3>
        <div className="flex items-center space-x-2">
          <button
            onClick={toggleTheme}
            className="flex items-center space-x-2 px-4 py-2 rounded-md bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            {themeMode === 'light' ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
                <span>当前：浅色模式（点击切换）</span>
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
                <span>当前：深色模式（点击切换）</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 保存按钮 */}
      <div className="pt-6 flex justify-end">
        <button
          onClick={handleSaveSettings}
          disabled={isSaving}
          className={`px-4 py-2 rounded-md text-white ${isSaving ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'} transition-colors flex items-center space-x-2`}
        >
          {isSaving ? (
            <>
              <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>保存中...</span>
            </>
          ) : saveSuccess ? (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>已保存</span>
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              <span>保存设置</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default SettingsPanel;