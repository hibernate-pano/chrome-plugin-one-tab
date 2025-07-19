import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
// 使用新版store中的settingsSlice
import { toggleLayoutMode, saveSettings } from '@/store/slices/settingsSlice';
// 使用新版的cleanDuplicateTabs
import { cleanDuplicateTabs } from '@/features/tabs/store/tabGroupsSlice';
import { HeaderDropdown } from './HeaderDropdown';
import { TabCounter } from './TabCounter';
import SyncButton from '@/components/sync/SyncButton';
import { SimpleThemeToggle } from './SimpleThemeToggle';
import { useOnboarding } from '@/features/onboarding/components/OnboardingProvider';

interface HeaderProps {
  onSearch: (query: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ onSearch }) => {
  const dispatch = useAppDispatch();
  const [searchValue, setSearchValue] = useState('');
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ removedCount: number } | null>(null);

  // 引导系统
  const { start: startOnboarding } = useOnboarding();

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchValue(value);
    onSearch(value);
  };

  const handleClearSearch = () => {
    setSearchValue('');
    onSearch('');
  };

  const settings = useAppSelector(state => state.settings);
  const [showDropdown, setShowDropdown] = useState(false);

  // 处理清理重复标签
  const handleCleanDuplicateTabs = () => {
    setShowCleanupConfirm(true);
  };

  // 确认清理
  const confirmCleanup = async () => {
    setShowCleanupConfirm(false);
    try {
      const result = await dispatch(cleanDuplicateTabs()).unwrap();
      setCleanupResult(result);

      // 3秒后自动关闭结果提示
      setTimeout(() => {
        setCleanupResult(null);
      }, 3000);
    } catch (error) {
      console.error('清理重复标签失败:', error);
    }
  };

  // 取消清理
  const cancelCleanup = () => {
    setShowCleanupConfirm(false);
  };

  // 切换布局模式
  const handleToggleLayout = () => {
    // 切换布局模式
    dispatch(toggleLayoutMode());
    dispatch(
      saveSettings({
        ...settings,
        useDoubleColumnLayout: !settings.useDoubleColumnLayout,
      })
    );
  };

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    // 只通过background脚本保存标签页，避免重复保存
    chrome.runtime.sendMessage({
      type: 'SAVE_ALL_TABS',
      data: {
        tabs: tabs,
        settings,
      },
    });
  };

  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 transition-colors">
      <div className="container mx-auto max-w-6xl">
        <div className="flex items-center justify-between py-2 px-2">
          <div className="flex items-center space-x-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 text-primary-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
              />
            </svg>
            <div className="flex items-center">
              <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">OneTabPlus</h1>
              <TabCounter />
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="relative">
              <input
                type="text"
                placeholder="搜索标签..."
                className="pl-8 pr-8 py-1.5 w-60 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 dark:bg-gray-700 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-transparent"
                onChange={handleSearch}
                value={searchValue}
                data-onboarding="search-input"
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              {searchValue && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  title="清空搜索"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={handleToggleLayout}
                className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-300 flex items-center justify-center"
                title={settings.useDoubleColumnLayout ? '切换为单栏布局' : '切换为双栏布局'}
              >
                {settings.useDoubleColumnLayout ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h7"
                    />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h8m-8 6h16"
                    />
                  </svg>
                )}
              </button>

              <button
                onClick={handleCleanDuplicateTabs}
                className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-600 dark:text-gray-300 flex items-center justify-center"
                title="清理所有标签组中的重复标签页"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>

              <SimpleThemeToggle />

              <SyncButton />

              <button
                onClick={handleSaveAllTabs}
                className="px-4 py-1.5 rounded text-sm transition-colors bg-primary-600 text-white hover:bg-primary-700 border border-primary-600 min-w-[100px] text-center"
                data-onboarding="save-tabs-button"
              >
                保存所有标签
              </button>
            </div>

            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-material text-gray-600 dark:text-gray-300"
                aria-label="菜单"
                data-onboarding="settings-button"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                  />
                </svg>
              </button>

              {showDropdown && <HeaderDropdown onClose={() => setShowDropdown(false)} />}
            </div>
          </div>
        </div>
      </div>

      {/* 确认对话框 */}
      {showCleanupConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md">
            <h3 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
              确认清理重复标签
            </h3>
            <p className="mb-4 text-gray-700 dark:text-gray-300">
              此操作将清理所有标签组中URL相同的重复标签页，只保留每个URL最新的一个标签页。此操作不可撤销。
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={cancelCleanup}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                取消
              </button>
              <button
                onClick={confirmCleanup}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                确认清理
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 结果提示 */}
      {cleanupResult && (
        <div className="fixed bottom-4 right-4 bg-green-100 dark:bg-green-900 border-l-4 border-green-500 text-green-700 dark:text-green-200 p-4 rounded shadow-md z-50">
          <div className="flex">
            <div className="py-1">
              <svg
                className="h-6 w-6 text-green-500 mr-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <div>
              <p className="font-bold">清理完成</p>
              <p className="text-sm">已清理 {cleanupResult.removedCount} 个重复标签页</p>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default Header;
