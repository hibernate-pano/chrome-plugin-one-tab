import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { toggleLayoutMode, saveSettings } from '@/store/slices/settingsSlice';
import { HeaderDropdown } from './HeaderDropdown';
import { TabCounter } from './TabCounter';

interface HeaderProps {
  onSearch: (query: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ onSearch }) => {
  const dispatch = useAppDispatch();
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearch(e.target.value);
  };

  const settings = useAppSelector(state => state.settings);
  const [showDropdown, setShowDropdown] = useState(false);

  // 切换布局模式
  const handleToggleLayout = () => {
    dispatch(toggleLayoutMode());
    dispatch(saveSettings({ ...settings, useDoubleColumnLayout: !settings.useDoubleColumnLayout }));
  };

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    // 只通过background脚本保存标签页，避免重复保存
    chrome.runtime.sendMessage({
      type: 'SAVE_ALL_TABS',
      data: {
        tabs: tabs,
        settings
      }
    });
  };

  return (
    <header className="bg-white border-b border-gray-200 transition-colors">
      <div className="container mx-auto max-w-6xl">
        <div className="flex items-center justify-between py-2 px-2">
          <div className="flex items-center space-x-3">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
            <div className="flex items-center">
              <h1 className="text-lg font-bold text-gray-800">
                OneTabPlus
              </h1>
              <TabCounter />
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="relative">
              <input
                type="text"
                placeholder="搜索标签..."
                className="pl-8 pr-2 py-1.5 w-60 border border-gray-300 rounded text-gray-700 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-transparent"
                onChange={handleSearch}
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={handleToggleLayout}
                className="p-2 rounded hover:bg-gray-100 transition-colors text-gray-600 flex items-center justify-center"
                title={settings.useDoubleColumnLayout ? '切换为单栏布局' : '切换为双栏布局'}
              >
                {settings.useDoubleColumnLayout ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
                  </svg>
                )}
              </button>

              <button
                onClick={handleSaveAllTabs}
                className="px-4 py-1.5 rounded text-sm transition-colors bg-primary-600 text-white hover:bg-primary-700 border border-primary-600 min-w-[100px] text-center"
              >
                保存所有标签
              </button>
            </div>

            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="p-2 rounded-full hover:bg-gray-100 transition-material text-gray-600"
                aria-label="菜单"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>

              {showDropdown && <HeaderDropdown onClose={() => setShowDropdown(false)} />}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
