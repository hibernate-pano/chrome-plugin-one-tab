import { storage } from './utils/storage';
import { nanoid } from '@reduxjs/toolkit';
import { TabGroup } from './types/tab';
import { store } from './store';
import { handleOAuthCallback, updateWechatLoginStatus } from './store/slices/authSlice';
import { showNotification } from './utils/notification';

// 创建新标签组的辅助函数
const createTabGroup = (tabs: chrome.tabs.Tab[]): TabGroup => {
  return {
    id: nanoid(),
    name: `标签组 ${new Date().toLocaleString()}`,
    tabs: tabs.map(tab => {
      // 如果标签页没有URL但有标题，使用一个特殊的URL标记
      const url = tab.url || (tab.title ? `loading://${encodeURIComponent(tab.title)}` : '');
      return {
        id: nanoid(),
        url: url,
        title: tab.title || '',
        favicon: tab.favIconUrl || '',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
      };
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false
  };
};

// 保存标签页的辅助函数
const saveTabs = async (tabs: chrome.tabs.Tab[]) => {
  try {
    // 记录所有标签页的状态，用于调试
    console.log('所有标签页状态:', tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      status: tab.status,
      title: tab.title
    })));

    // 过滤掉 chrome://、chrome-extension:// 和 edge:// 页面
    // 注意：不再检查标签页的加载状态，允许所有有效URL的标签页被保存
    let validTabs = tabs.filter(tab => {
      // 如果标签页有URL，则检查URL是否为内部页面
      if (tab.url) {
        return !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('edge://');
      }
      // 如果URL为空，但标题不为空，则保存该标签页（可能是正在加载的页面）
      return tab.title && tab.title.trim() !== '';
    });

    // 保存所有要关闭的标签页（包括重复的）
    const allTabsToClose = [...validTabs];

    // 获取设置
    const settings = await storage.getSettings();

    // 如果不允许重复标签页，则过滤重复的URL
    if (!settings.allowDuplicateTabs) {
      const uniqueUrls = new Set<string>();
      validTabs = validTabs.filter(tab => {
        if (tab.url && !uniqueUrls.has(tab.url)) {
          uniqueUrls.add(tab.url);
          return true;
        }
        return false;
      });
    }

    if (validTabs.length === 0) return;

    const newGroup = createTabGroup(validTabs);
    const existingGroups = await storage.getGroups();
    await storage.setGroups([newGroup, ...existingGroups]);

    // 不再自动同步到云端，保证本地操作优先，避免卡顿
    console.log('标签页已保存到本地，跳过自动同步，保证操作丰满顺畅');

    // 保存后自动关闭标签页
    // 获取要关闭的标签页ID（包括重复的）
    const tabIds = allTabsToClose
      .map(tab => tab.id)
      .filter((id): id is number => id !== undefined);

    if (tabIds.length > 0) {
      // 创建一个新标签页
      await chrome.tabs.create({ url: 'chrome://newtab' });

      // 关闭已保存的标签页（包括重复的）
      await chrome.tabs.remove(tabIds);
    }

    // 显示通知
    await showNotification({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '标签已保存',
      message: `已成功保存 ${validTabs.length} 个标签页到新标签组`
    });
  } catch (error) {
    console.error('保存标签失败:', error);
    await showNotification({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '保存失败',
      message: '保存标签时发生错误，请重试'
    });
  }
};

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  // 获取当前窗口的所有标签页
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await saveTabs(tabs);
});

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

// 监听安装事件
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // 初始化存储
    await storage.setGroups([]);
    await storage.setSettings({
      groupNameTemplate: 'Group %d',
      showFavicons: true,
      showTabCount: true,
      confirmBeforeDelete: true,
      allowDuplicateTabs: false,
      syncEnabled: true,
      autoSyncEnabled: true,
      syncInterval: 30,
      useDoubleColumnLayout: true,
      showNotifications: false, // 默认关闭通知
      syncStrategy: 'newest',
      deleteStrategy: 'everywhere',
      themeMode: 'auto', // 默认使用自动模式（跟随系统）
    });
  }
});

// 监听来自微信登录页面的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WECHAT_LOGIN_STATUS_UPDATE') {
    console.log('收到微信登录状态更新:', message.payload);

    // 更新微信登录状态
    store.dispatch(updateWechatLoginStatus({
      status: message.payload.status,
      error: message.payload.error,
      tabId: sender.tab?.id
    }));

    // 返回成功响应
    sendResponse({ success: true });
  }

  // 返回true表示异步响应
  return true;
});

// 监听标签页更新事件，处理OAuth回调
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // 处理微信登录回调
  if (changeInfo.url && changeInfo.url.includes('wechat-login.html') && changeInfo.url.includes('access_token')) {
    console.log('检测到微信登录回调:', changeInfo.url);
    try {
      // 将当前标签页更新为我们的回调页面
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/oauth-callback.html') });

      // 处理微信登录回调
      await store.dispatch(handleOAuthCallback(changeInfo.url));

      // 关闭回调标签页
      await chrome.tabs.remove(tabId);

      // 打开标签管理器页面
      await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });

      // 显示登录成功通知
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录成功',
        message: '您已成功使用微信登录到OneTabPlus'
      });
    } catch (error) {
      console.error('处理微信登录回调时出错:', error);

      // 关闭回调标签页
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        console.error('关闭回调标签页失败:', e);
      }

      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录失败',
        message: '微信登录失败，请重试'
      });
    }
  }
  // 处理其他OAuth回调（Google、GitHub等）
  else if (changeInfo.url && changeInfo.url.startsWith(chrome.identity.getRedirectURL())) {
    console.log('检测到OAuth回调URL:', changeInfo.url);
    try {
      // 将当前标签页更新为我们的回调页面
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/oauth-callback.html') });

      // 处理OAuth回调
      await store.dispatch(handleOAuthCallback(changeInfo.url));

      // 关闭回调标签页
      await chrome.tabs.remove(tabId);

      // 打开标签管理器页面
      await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });

      // 显示登录成功通知
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录成功',
        message: '您已成功登录到OneTabPlus'
      });
    } catch (error) {
      console.error('处理OAuth回调时出错:', error);

      // 关闭回调标签页
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        console.error('关闭回调标签页失败:', e);
      }

      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录失败',
        message: '第三方登录失败，请重试'
      });
    }
  }
});

// 浏览器启动时不再自动检查用户会话，避免自动同步
chrome.runtime.onStartup.addListener(() => {
  console.log('浏览器启动，不再自动检查用户会话，避免自动同步');
});