import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { saveGroup } from '@/store/slices/tabSlice';
import { nanoid } from '@reduxjs/toolkit';
import { storage } from '@/utils/storage';

interface HeaderProps {
  onSearch: (query: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ onSearch }) => {
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearch(e.target.value);
  };
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);
  const [showDropdown, setShowDropdown] = useState(false);

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    // 过滤掉 chrome://、chrome-extension:// 和 edge:// 页面
    const validTabs = tabs.filter(tab =>
      tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://')
    );

    if (validTabs.length === 0) return;

    dispatch(saveGroup({
      id: nanoid(),
      name: `标签组 ${new Date().toLocaleString()}`,
      tabs: validTabs.map(tab => ({
        id: nanoid(),
        url: tab.url || '',
        title: tab.title || '',
        favicon: tab.favIconUrl || '',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    }));

    // 通过background脚本保存标签页
    chrome.runtime.sendMessage({
      type: 'SAVE_ALL_TABS',
      data: {
        tabs: validTabs,
        settings
      }
    });
  };

  const handleSaveCurrentTab = async () => {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!activeTab || !activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('edge://')) {
      return;
    }

    const newGroup = {
      id: nanoid(),
      name: `当前标签 - ${new Date().toLocaleString()}`,
      tabs: [{
        id: nanoid(),
        url: activeTab.url,
        title: activeTab.title || '',
        favicon: activeTab.favIconUrl || '',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    };

    dispatch(saveGroup(newGroup));

    // 如果设置为保存后关闭标签页
    if (settings.autoCloseTabsAfterSaving && activeTab.id) {
      // 创建一个新标签页
      await chrome.tabs.create({ url: 'chrome://newtab' });

      // 关闭当前标签页
      await chrome.tabs.remove(activeTab.id);
    }
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

  return (
    <header className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
      <h1 className="text-xl font-semibold">标签管理器</h1>

      <div className="flex items-center space-x-4">
        <input
          type="text"
          placeholder="搜索标签组..."
          className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700"
          onChange={handleSearch}
        />
        <button
          onClick={handleSaveCurrentTab}
          className="
            px-3 py-2 rounded-lg
            bg-gray-200 hover:bg-gray-300
            dark:bg-gray-700 dark:hover:bg-gray-600
            text-gray-800 dark:text-gray-200
            transition duration-200
            text-sm
          "
        >
          保存当前标签
        </button>

        <button
          onClick={handleSaveAllTabs}
          className="
            px-4 py-2 rounded-lg
            bg-blue-600 hover:bg-blue-700
            dark:bg-blue-500 dark:hover:bg-blue-600
            text-white
            transition duration-200
          "
        >
          保存所有标签
        </button>

        <div className="relative">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="
              p-2 rounded-lg
              bg-gray-200 hover:bg-gray-300
              dark:bg-gray-700 dark:hover:bg-gray-600
              text-gray-800 dark:text-gray-200
              transition duration-200
            "
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>

          {showDropdown && (
            <div className="
              absolute right-0 mt-2 w-48
              bg-white dark:bg-gray-800
              rounded-lg shadow-lg
              border border-gray-200 dark:border-gray-700
              z-10
            ">
              <ul>
                <li>
                  <button
                    onClick={handleExportData}
                    className="
                      w-full text-left px-4 py-2
                      hover:bg-gray-100 dark:hover:bg-gray-700
                      rounded-t-lg
                    "
                  >
                    导出数据
                  </button>
                </li>
                <li>
                  <label
                    className="
                      block w-full text-left px-4 py-2
                      hover:bg-gray-100 dark:hover:bg-gray-700
                      cursor-pointer
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
                  <a
                    href="chrome://extensions/?options=YOUR_EXTENSION_ID"
                    className="
                      block w-full text-left px-4 py-2
                      hover:bg-gray-100 dark:hover:bg-gray-700
                      rounded-b-lg
                    "
                  >
                    设置
                  </a>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
