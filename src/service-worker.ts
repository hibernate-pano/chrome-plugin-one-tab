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

// 定义允许的消息类型
const ALLOWED_MESSAGE_TYPES = [
  'SAVE_ALL_TABS',
  'SAVE_CURRENT_TAB',
  'OPEN_TAB',
  'OPEN_TABS',
  'REFRESH_TAB_LIST'
] as const;

// type AllowedMessageType = typeof ALLOWED_MESSAGE_TYPES[number];

// 消息验证函数
function validateMessage(message: any, sender: chrome.runtime.MessageSender): boolean {
  // 检查消息结构
  if (!message || typeof message !== 'object') {
    console.warn('Service Worker: 收到无效消息结构:', message);
    return false;
  }

  // 检查消息类型
  if (!message.type || !ALLOWED_MESSAGE_TYPES.includes(message.type)) {
    console.warn('Service Worker: 收到未知消息类型:', message.type);
    return false;
  }

  // 验证发送者来源
  if (!sender.id || sender.id !== chrome.runtime.id) {
    console.warn('Service Worker: 消息来源验证失败:', sender);
    return false;
  }

  // 验证消息数据结构
  if (message.type !== 'REFRESH_TAB_LIST' && (!message.data || typeof message.data !== 'object')) {
    console.warn('Service Worker: 消息缺少有效数据:', message);
    return false;
  }

  return true;
}

// 安全的错误响应函数
function sendSecureErrorResponse(sendResponse: (response: any) => void, error: Error | string) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  // 过滤敏感信息，只返回安全的错误信息
  const safeErrorMessage = errorMessage.includes('chrome-extension://')
    ? '操作失败，请重试'
    : errorMessage;

  sendResponse({
    success: false,
    error: safeErrorMessage,
    timestamp: Date.now()
  });
}

// 处理消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 验证消息
  if (!validateMessage(message, sender)) {
    sendSecureErrorResponse(sendResponse, '无效的消息格式或来源');
    return false;
  }

  console.log('Service Worker 收到验证通过的消息:', message.type);

  try {
    // 处理保存标签页的消息
    if (message.type === 'SAVE_ALL_TABS') {
      if (!Array.isArray(message.data.tabs)) {
        sendSecureErrorResponse(sendResponse, '标签页数据格式无效');
        return false;
      }

      tabManager.saveAllTabs(message.data.tabs)
        .then(() => sendResponse({ success: true, timestamp: Date.now() }))
        .catch(error => sendSecureErrorResponse(sendResponse, error));
      return true; // 异步响应
    }

    if (message.type === 'SAVE_CURRENT_TAB') {
      if (!message.data.tab || typeof message.data.tab !== 'object') {
        sendSecureErrorResponse(sendResponse, '标签页数据格式无效');
        return false;
      }

      tabManager.saveCurrentTab(message.data.tab)
        .then(() => sendResponse({ success: true, timestamp: Date.now() }))
        .catch(error => sendSecureErrorResponse(sendResponse, error));
      return true; // 异步响应
    }

    if (message.type === 'OPEN_TAB') {
      if (!message.data.url || typeof message.data.url !== 'string') {
        sendSecureErrorResponse(sendResponse, 'URL格式无效');
        return false;
      }

      // 验证URL安全性
      try {
        const url = new URL(message.data.url);
        if (!['http:', 'https:'].includes(url.protocol)) {
          sendSecureErrorResponse(sendResponse, '不支持的URL协议');
          return false;
        }
      } catch {
        sendSecureErrorResponse(sendResponse, 'URL格式无效');
        return false;
      }

      tabManager.openTab(message.data.url)
        .then(() => sendResponse({ success: true, timestamp: Date.now() }))
        .catch(error => sendSecureErrorResponse(sendResponse, error));
      return true; // 异步响应
    }

    if (message.type === 'OPEN_TABS') {
      if (!Array.isArray(message.data.urls)) {
        sendSecureErrorResponse(sendResponse, 'URL列表格式无效');
        return false;
      }

      // 验证所有URL的安全性
      for (const url of message.data.urls) {
        if (typeof url !== 'string') {
          sendSecureErrorResponse(sendResponse, 'URL格式无效');
          return false;
        }

        try {
          const urlObj = new URL(url);
          if (!['http:', 'https:'].includes(urlObj.protocol)) {
            sendSecureErrorResponse(sendResponse, '不支持的URL协议');
            return false;
          }
        } catch {
          sendSecureErrorResponse(sendResponse, 'URL格式无效');
          return false;
        }
      }

      tabManager.openTabs(message.data.urls)
        .then(() => sendResponse({ success: true, timestamp: Date.now() }))
        .catch(error => sendSecureErrorResponse(sendResponse, error));
      return true; // 异步响应
    }

    if (message.type === 'REFRESH_TAB_LIST') {
      // 这个消息类型不需要响应，只是通知
      sendResponse({ success: true, timestamp: Date.now() });
      return false;
    }

    // 如果没有处理消息，返回错误
    sendSecureErrorResponse(sendResponse, '未知的消息类型');
    return false;

  } catch (error) {
    console.error('Service Worker: 处理消息时发生错误:', error);
    sendSecureErrorResponse(sendResponse, '处理消息时发生内部错误');
    return false;
  }
});

// 导出一个空对象，确保这个文件被视为模块
export { };
