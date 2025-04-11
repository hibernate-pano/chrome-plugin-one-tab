import React, { useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import { storage } from '@/utils/storage';
import { AuthContainer } from '../auth/AuthContainer';

interface HeaderProps {
  onSearch: (query: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ onSearch }) => {
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearch(e.target.value);
  };

  const settings = useAppSelector(state => state.settings);
  const [showDropdown, setShowDropdown] = useState(false);

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

  const handleSaveCurrentTab = async () => {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!activeTab) {
      return;
    }

    // 只通过background脚本保存标签页，避免重复保存
    chrome.runtime.sendMessage({
      type: 'SAVE_CURRENT_TAB',
      data: {
        tab: activeTab,
        settings
      }
    });
  };

  const handleExportData = async () => {
    try {
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `onetab-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setShowDropdown(false);
    } catch (error) {
      console.error('导出数据失败:', error);
      alert('导出数据失败，请重试');
    }
  };

  // 不再需要获取用户状态，因为 AuthContainer 会自己检查

  return (
    <header className="bg-white border-b border-gray-200 shadow-sm transition-material">
      <div className="container mx-auto max-w-6xl">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center space-x-3">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
            <h1 className="text-2xl font-bold text-gray-800">
              OneTabPlus
            </h1>
          </div>

          <div className="flex items-center space-x-4">
            <div className="relative">
              <input
                type="text"
                placeholder="搜索标签..."
                className="pl-10 pr-4 py-2 w-72 border border-gray-300 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                onChange={handleSearch}
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            <button
              onClick={handleSaveCurrentTab}
              className="px-4 py-2 rounded-lg font-medium transition-all duration-200 ease-out bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300"
            >
              保存当前标签
            </button>

            <button
              onClick={handleSaveAllTabs}
              className="px-4 py-2 rounded-lg font-medium transition-all duration-200 ease-out bg-primary-600 text-white hover:bg-primary-700 shadow-sm"
            >
              保存所有标签
            </button>

            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="p-2 rounded-full hover:bg-gray-100 transition-material text-gray-600"
                aria-label="更多选项"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-elevation-3 border border-gray-100 z-10 overflow-hidden transition-material">
                  <ul className="py-1">
                    <li>
                      <button
                        onClick={handleExportData}
                        className="flex items-center w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700 transition-material"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        导出数据
                      </button>
                    </li>
                    <li>
                      <label
                        className="flex items-center w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700 cursor-pointer transition-material"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                        </svg>
                        导入数据
                        <input
                          type="file"
                          accept=".json"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = async (event) => {
                                try {
                                  const data = JSON.parse(event.target?.result as string);
                                  const success = await storage.importData(data);
                                  if (success) {
                                    alert('数据导入成功');
                                    // 刷新页面
                                    window.location.reload();
                                  } else {
                                    alert('数据导入失败');
                                  }
                                } catch (error) {
                                  console.error('解析导入文件失败:', error);
                                  alert('解析导入文件失败，请确保文件格式正确');
                                }
                                setShowDropdown(false);
                              };
                              reader.readAsText(file);
                            }
                          }}
                        />
                      </label>
                    </li>
                    <li className="border-t border-gray-100 mt-1 pt-1">
                      <button
                        onClick={() => {
                          chrome.runtime.openOptionsPage();
                          setShowDropdown(false);
                        }}
                        className="flex items-center w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700 transition-material"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        设置
                      </button>
                    </li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <AuthContainer />
    </header>
  );
};

export default Header;
