import React from 'react';
import { useAppDispatch } from '@/store/hooks';
import { saveGroup } from '@/store/slices/tabSlice';
import { nanoid } from '@reduxjs/toolkit';

export const Header: React.FC = () => {
  const dispatch = useAppDispatch();

  const handleSaveAllTabs = async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const newGroup = {
      id: nanoid(),
      name: `标签组 ${new Date().toLocaleString()}`,
      tabs: tabs.map(tab => ({
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
    };
    dispatch(saveGroup(newGroup));
  };

  return (
    <header className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
      <h1 className="text-xl font-semibold">标签管理器</h1>
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
    </header>
  );
};

export default Header; 