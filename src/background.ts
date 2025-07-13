import { storage } from './utils/storage';
import { nanoid } from '@reduxjs/toolkit';
import { TabGroup } from './types/tab';
import { store } from './store';
import { handleOAuthCallback, updateWechatLoginStatus } from './store/slices/authSlice';
import { showNotification } from './utils/notification';
import { logger } from './shared/utils/logger';

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
    logger.debug('保存标签页 - 所有标签页状态', tabs.map(tab => ({
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

    // 添加详细的调试信息
    logger.info('标签页保存详情', {
      newGroupId: newGroup.id,
      newGroupName: newGroup.name,
      newTabCount: newGroup.tabs.length,
      existingGroupCount: existingGroups.length,
      totalGroupsAfterSave: existingGroups.length + 1
    });

    // 验证保存是否成功
    const verifyGroups = await storage.getGroups();
    logger.info('保存验证', {
      savedGroupCount: verifyGroups.length,
      firstGroupId: verifyGroups[0]?.id,
      firstGroupTabCount: verifyGroups[0]?.tabs?.length
    });

    // 不再自动同步到云端，保证本地操作优先，避免卡顿
    logger.info('标签页已保存到本地，跳过自动同步');

    // 发送消息通知前端刷新标签列表
    // 延迟发送消息，确保popup页面已经加载完成
    setTimeout(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'REFRESH_TAB_LIST' });
        logger.debug('已发送刷新标签列表消息');
      } catch (error) {
        // 如果发送失败，说明popup页面还没准备好，这是正常的
        logger.debug('发送刷新消息失败（popup可能还未加载）', { error: (error as Error).message });
      }
    }, 1000); // 延迟1秒发送

    // 保存后自动关闭标签页
    // 获取要关闭的标签页ID（包括重复的）
    const tabIds = allTabsToClose
      .map(tab => tab.id)
      .filter((id): id is number => id !== undefined);

    if (tabIds.length > 0) {
      // 创建OneTab标签管理页面
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });

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
    logger.error('保存标签失败', error);
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
      syncInterval: 5, // 默认10分钟自动同步一次
      useDoubleColumnLayout: true,
      showNotifications: false, // 默认关闭通知
      showManualSyncButtons: false, // 默认隐藏手动同步按钮
      syncStrategy: 'newest',
      deleteStrategy: 'everywhere',
      themeMode: 'auto', // 默认使用自动模式（跟随系统）
    });
  }
});

// 监听来自微信登录页面的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WECHAT_LOGIN_STATUS_UPDATE') {
    logger.debug('收到微信登录状态更新', message.payload);

    // 更新微信登录状态
    store.dispatch(updateWechatLoginStatus({
      status: message.payload.status,
      error: message.payload.error,
      tabId: sender.tab?.id
    }));

    // 返回成功响应
    sendResponse({ success: true });
  } 
  // 处理保存所有标签页的消息
  else if (message.type === 'SAVE_ALL_TABS') {
    logger.debug('收到保存所有标签页消息');
    
    // 使用消息中的标签数据或重新获取当前窗口的所有标签页
    const tabs = message.data?.tabs || [];
    
    // 异步处理，不阻塞消息响应
    saveTabs(tabs)
      .then(() => {
        logger.debug('标签页保存成功');
        // 延迟发送消息通知前端刷新标签列表
        setTimeout(async () => {
          try {
            await chrome.runtime.sendMessage({ type: 'REFRESH_TAB_LIST' });
            logger.debug('已发送刷新标签列表消息');
          } catch (error) {
            logger.debug('发送刷新消息失败（popup可能还未加载）', { error: (error as Error).message });
          }
        }, 500);
      })
      .catch(error => {
        logger.error('保存标签页失败', error);
      });
    
    // 立即返回响应
    sendResponse({ success: true });
  }
  // 处理打开多个标签页的消息
  else if (message.type === 'OPEN_TABS') {
    logger.debug('收到打开多个标签页消息');
    
    const urls = message.data?.urls || [];
    if (urls.length > 0) {
      // 打开多个标签页
      urls.forEach((url: string) => {
        chrome.tabs.create({ url });
      });
    }
    
    sendResponse({ success: true });
  }
  // 处理打开单个标签页的消息
  else if (message.type === 'OPEN_TAB') {
    logger.debug('收到打开单个标签页消息');
    
    const url = message.data?.url;
    if (url) {
      chrome.tabs.create({ url });
    }
    
    sendResponse({ success: true });
  }

  // 返回true表示异步响应
  return true;
});

// 监听标签页更新事件，处理OAuth回调
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // 处理微信登录回调
  if (changeInfo.url && changeInfo.url.includes('wechat-login.html') && changeInfo.url.includes('access_token')) {
    logger.debug('检测到微信登录回调', { url: changeInfo.url });
    try {
      // 将当前标签页更新为我们的回调页面
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/oauth-callback.html') });

      // 处理微信登录回调
      await store.dispatch(handleOAuthCallback(changeInfo.url));

      // 关闭回调标签页
      await chrome.tabs.remove(tabId);

      // 打开标签管理器页面
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });

      // 显示登录成功通知
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录成功',
        message: '您已成功使用微信登录到OneTabPlus'
      });
    } catch (error) {
      logger.error('处理微信登录回调时出错', error);

      // 关闭回调标签页
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        logger.error('关闭回调标签页失败', e);
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
    logger.debug('检测到OAuth回调URL', { url: changeInfo.url });
    try {
      // 将当前标签页更新为我们的回调页面
      await chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/oauth-callback.html') });

      // 处理OAuth回调
      await store.dispatch(handleOAuthCallback(changeInfo.url));

      // 关闭回调标签页
      await chrome.tabs.remove(tabId);

      // 打开标签管理器页面
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });

      // 显示登录成功通知
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '登录成功',
        message: '您已成功登录到OneTabPlus'
      });
    } catch (error) {
      logger.error('处理OAuth回调时出错', error);

      // 关闭回调标签页
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        logger.error('关闭回调标签页失败', e);
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
  logger.debug('浏览器启动，不再自动检查用户会话');
});