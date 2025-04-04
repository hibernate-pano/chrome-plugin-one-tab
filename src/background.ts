import { storage } from './utils/storage';
import { nanoid } from '@reduxjs/toolkit';

// 创建新标签组的辅助函数
const createTabGroup = (tabs: chrome.tabs.Tab[]) => {
  return {
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
};

// 保存标签页的辅助函数
const saveTabs = async (tabs: chrome.tabs.Tab[]) => {
  try {
    const newGroup = createTabGroup(tabs);
    const existingGroups = await storage.getGroups();
    await storage.setGroups([newGroup, ...existingGroups]);

    // 显示通知
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '标签已保存',
      message: `已成功保存 ${tabs.length} 个标签页到新标签组`
    });
  } catch (error) {
    console.error('保存标签失败:', error);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '保存失败',
      message: '保存标签时发生错误，请重试'
    });
  }
};

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'save_all_tabs':
      // 保存当前窗口的所有标签页
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      await saveTabs(allTabs);
      break;

    case 'save_current_tab':
      // 保存当前活动的标签页
      const [activeTab] = await chrome.tabs.query({ 
        active: true, 
        currentWindow: true 
      });
      if (activeTab) {
        await saveTabs([activeTab]);
      }
      break;
  }
}); 