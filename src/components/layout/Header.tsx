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

  const { syncStatus, lastSyncTime } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  return (
    <header className="border-b border-gray-200 shadow-sm bg-surface transition-material">
      <div className="flex items-center justify-between p-4">
        <div>
          <h1 className="text-xl font-medium text-primary-700">
            OneTabPlus
          </h1>
          {isAuthenticated && (
            <div className="text-xs flex items-center">
              {syncStatus === 'syncing' ? (
                <div className="text-blue-500 flex items-center">
                  <span className="mr-1">
                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  </span>
                  正在同步数据...
                </div>
              ) : lastSyncTime ? (
                <div className="text-green-500">
                  上次同步: {new Date(lastSyncTime).toLocaleString()}
                </div>
              ) : (
                <div className="text-gray-500">
                  尚未同步数据
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center space-x-4">
          <div className="relative">
            <input
              type="text"
              placeholder="搜索标签..."
              className="input-material pl-8 pr-3 py-2 w-64"
              onChange={handleSearch}
            />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <button
            onClick={handleSaveCurrentTab}
            className="btn-material"
          >
            保存当前标签
          </button>

          <button
            onClick={handleSaveAllTabs}
            className="btn-material btn-material-primary"
          >
            保存所有标签
          </button>

          <div className="relative">
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              className="p-2 rounded-full hover:bg-gray-100 transition-material"
              aria-label="更多选项"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-600" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>

            {showDropdown && (
              <div className="
              absolute right-0 mt-2 w-48
              bg-surface
              rounded-md shadow-elevation-2
              border border-gray-200
              z-10 overflow-hidden
              transition-material
            ">
                <ul className="py-1">
                  <li>
                    <button
                      onClick={handleExportData}
                      className="
                      w-full text-left px-4 py-2
                      hover:bg-gray-100
                      text-gray-800
                      transition-material
                    "
                    >
                      导出数据
                    </button>
                  </li>
                  <li>
                    <label
                      className="
                      block w-full text-left px-4 py-2
                      hover:bg-gray-100
                      text-gray-800
                      cursor-pointer
                      transition-material
                    "
                    >
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
                  <li>
                    <button
                      onClick={() => {
                        chrome.runtime.openOptionsPage();
                        setShowDropdown(false);
                      }}
                      className="
                      block w-full text-left px-4 py-2
                      hover:bg-gray-100
                      text-gray-800
                      transition-material
                    "
                    >
                      设置
                    </button>
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
      <AuthContainer />
    </header>
  );
};

export default Header;
