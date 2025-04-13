// Chrome 扩展的 Service Worker
import { showNotification, showNotificationWithId } from './utils/notification';

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
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(async () => {
  console.log('Service Worker: 浏览器启动');
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-tab-manager') {
    // 打开标签管理器
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
});

// 监听消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'showNotification') {
    showNotification(message.options)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.action === 'showNotificationWithId') {
    showNotificationWithId(message.id, message.options)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }
});

// 监听通知点击事件
chrome.notifications.onClicked.addListener((notificationId) => {
  // 如果是微信登录通知，打开标签管理器
  if (notificationId === 'wechat-login-success') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
});

// 监听命令
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-tab-manager') {
    // 打开标签管理器
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(() => {
  // 打开标签管理器
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

console.log('Service Worker: 已加载');
