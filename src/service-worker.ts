// Chrome 扩展的 Service Worker
import { tabManager } from './background/TabManager';

// 移除定时同步功能，简化逻辑
console.log('Service Worker: 已简化同步逻辑，只保留手动同步功能');

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(() => {
  console.log('Service Worker: 扩展已安装或更新');

  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'open-tab-manager',
    title: '打开标签管理器',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'saveCurrentTab',
    title: '保存当前标签',
    contexts: ['action']
  });
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(() => {
  console.log('Service Worker: 浏览器已启动');
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  console.log('点击扩展图标，检查是否有标签管理页面并处理标签');

  try {
    // 先打开标签管理器页面
    await tabManager.openTabManager(true);

    // 然后保存所有标签页
    console.log('保存所有标签页');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    await tabManager.saveAllTabs(tabs);
  } catch (error) {
    console.error('处理扩展图标点击失败:', error);
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  console.log('收到快捷键命令:', command);

  try {
    switch (command) {
      case 'save_all_tabs':
        console.log('快捷键保存所有标签页');
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        await tabManager.saveAllTabs(allTabs);
        break;

      case 'save_current_tab':
        console.log('快捷键保存当前标签页');
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (activeTab) {
          await tabManager.saveCurrentTab(activeTab);
        }
        break;

      case '_execute_action':
        console.log('快捷键打开标签管理器');
        await tabManager.openTabManager();
        break;
    }
  } catch (error) {
    console.error('处理快捷键命令失败:', error);
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log('右键菜单点击:', info.menuItemId);

  try {
    if (info.menuItemId === 'open-tab-manager') {
      console.log('点击右键菜单，打开标签管理器');
      await tabManager.openTabManager();
    } else if (info.menuItemId === 'saveCurrentTab' && tab) {
      console.log('点击右键菜单，保存当前标签页');
      await tabManager.saveCurrentTab(tab);
      // 保存后打开标签管理器
      await tabManager.openTabManager(true);
    }
  } catch (error) {
    console.error('处理右键菜单点击失败:', error);
  }
});

// 处理消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('Service Worker 收到消息:', message);

  // 处理保存标签页的消息
  if (message.type === 'SAVE_ALL_TABS') {
    tabManager.saveAllTabs(message.data.tabs)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'SAVE_CURRENT_TAB') {
    tabManager.saveCurrentTab(message.data.tab)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'OPEN_TAB') {
    tabManager.openTab(message.data.url)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'OPEN_TABS') {
    tabManager.openTabs(message.data.urls)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 如果没有处理消息，返回 false
  return false;
});

// 导出一个空对象，确保这个文件被视为模块
export { };
