// Chrome 扩展的 Service Worker
import { showNotification, showNotificationWithId } from './utils/notification';
// 生成随机 ID
function generateId(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
import { storage } from './utils/storage';
import { auth as supabaseAuth } from './utils/supabase';

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
    // 打开标签管理器，确保只有一个标签管理器页面打开
    openTabManager();
  }
});

// 打开标签管理器页面，确保只有一个标签管理器页面打开
async function openTabManager() {
  try {
    console.log('尝试打开标签管理器页面');

    // 检查是否已经有标签管理器页面打开
    // 使用更精确的查询方式，包括 popup.html 和 src/popup/index.html
    const popupUrl = chrome.runtime.getURL('popup.html');
    const srcPopupUrl = chrome.runtime.getURL('src/popup/index.html');

    // 查询所有标签页
    const allTabs = await chrome.tabs.query({});

    // 过滤出标签管理器页面
    const managerTabs = allTabs.filter(tab => {
      const url = tab.url || '';
      return url.startsWith(popupUrl) || url.startsWith(srcPopupUrl);
    });

    console.log('找到标签管理器页面数量:', managerTabs.length);

    if (managerTabs.length > 0) {
      // 如果已经有标签管理器页面打开，激活它
      console.log('激活现有标签管理器页面:', managerTabs[0].id);
      await chrome.tabs.update(managerTabs[0].id!, { active: true });

      // 如果有多个标签管理器页面，关闭其他的
      if (managerTabs.length > 1) {
        const tabsToClose = managerTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
        if (tabsToClose.length > 0) {
          console.log('关闭多余的标签管理器页面:', tabsToClose);
          await chrome.tabs.remove(tabsToClose);
        }
      }
    } else {
      // 如果没有标签管理器页面打开，创建一个新的
      console.log('创建新的标签管理器页面');
      await chrome.tabs.create({ url: popupUrl, active: true });
    }
    return true;
  } catch (error) {
    console.error('打开标签管理器页面失败:', error);
    return false;
  }
}

// 打开单个标签页，保持只有一个 OneTabPlus 标签页
async function openTabWithSingleInstance(url: string) {
  try {
    console.log('打开标签页:', url);
    // 打开要恢复的标签页
    await chrome.tabs.create({ url });

    // 使用与 openTabManager 相同的方法检查标签管理器页面
    const popupUrl = chrome.runtime.getURL('popup.html');
    const srcPopupUrl = chrome.runtime.getURL('src/popup/index.html');

    // 查询所有标签页
    const allTabs = await chrome.tabs.query({});

    // 过滤出标签管理器页面
    const managerTabs = allTabs.filter(tab => {
      const tabUrl = tab.url || '';
      return tabUrl.startsWith(popupUrl) || tabUrl.startsWith(srcPopupUrl);
    });

    if (managerTabs.length > 1) {
      // 如果有多个标签管理器页面，只保留第一个，关闭其他的
      const tabsToClose = managerTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
      if (tabsToClose.length > 0) {
        console.log('关闭多余的标签管理器页面:', tabsToClose);
        await chrome.tabs.remove(tabsToClose);
      }
    }
    return true;
  } catch (error) {
    console.error('打开标签页失败:', error);
    return false;
  }
}

// 打开多个标签页，保持只有一个 OneTabPlus 标签页
async function openTabsWithSingleInstance(urls: string[]) {
  try {
    console.log('打开多个标签页:', urls);
    // 打开要恢复的所有标签页
    for (const url of urls) {
      await chrome.tabs.create({ url });
    }

    // 使用与 openTabManager 相同的方法检查标签管理器页面
    const popupUrl = chrome.runtime.getURL('popup.html');
    const srcPopupUrl = chrome.runtime.getURL('src/popup/index.html');

    // 查询所有标签页
    const allTabs = await chrome.tabs.query({});

    // 过滤出标签管理器页面
    const managerTabs = allTabs.filter(tab => {
      const tabUrl = tab.url || '';
      return tabUrl.startsWith(popupUrl) || tabUrl.startsWith(srcPopupUrl);
    });

    if (managerTabs.length > 1) {
      // 如果有多个标签管理器页面，只保留第一个，关闭其他的
      const tabsToClose = managerTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
      if (tabsToClose.length > 0) {
        console.log('关闭多余的标签管理器页面:', tabsToClose);
        await chrome.tabs.remove(tabsToClose);
      }
    }
    return true;
  } catch (error) {
    console.error('打开多个标签页失败:', error);
    return false;
  }
}

// 创建新标签组的辅助函数
const createTabGroup = (tabs: chrome.tabs.Tab[]) => {
  return {
    id: generateId(),
    name: `标签组 ${new Date().toLocaleString()}`,
    tabs: tabs.map(tab => {
      // 如果标签页没有URL但有标题，使用一个特殊的URL标记
      const url = tab.url || (tab.title ? `loading://${encodeURIComponent(tab.title)}` : '');
      return {
        id: generateId(),
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

    // 如果用户已登录，自动同步到云端
    try {
      const { data } = await supabaseAuth.getSession();
      if (data.session) {
        console.log('检测到用户已登录，保存后自动同步到云端');
        // 异步执行同步，不阻塞保存操作
        // 简化后不再自动同步，需要用户手动同步
      }
    } catch (syncError) {
      console.error('检查用户登录状态失败:', syncError);
      // 继续执行保存操作，不影响用户体验
    }

    // 如果设置为保存后关闭标签页
    if (settings.autoCloseTabsAfterSaving) {
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

// 监听消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 处理打开单个标签页的消息
  if (message.type === 'OPEN_TAB') {
    openTabWithSingleInstance(message.data.url)
      .then(success => sendResponse({ success }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理打开多个标签页的消息
  if (message.type === 'OPEN_TABS') {
    openTabsWithSingleInstance(message.data.urls)
      .then(success => sendResponse({ success }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理保存所有标签页的消息
  if (message.type === 'SAVE_ALL_TABS') {
    const { tabs } = message.data;
    saveTabs(tabs)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理保存当前标签页的消息
  if (message.type === 'SAVE_CURRENT_TAB') {
    const { tab } = message.data;
    saveTabs([tab])
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理显示通知的消息
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
    openTabManager();
  }
});

// 监听命令
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-tab-manager') {
    // 打开标签管理器，确保只有一个标签管理器页面打开
    openTabManager();
  }
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  // 获取当前窗口的所有标签页
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await saveTabs(tabs);

  // 打开标签管理器，确保只有一个标签管理器页面打开
  await openTabManager();
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

    case 'open_tab_manager':
      // 打开标签管理器，确保只有一个标签管理器页面打开
      await openTabManager();
      break;
  }
});

console.log('Service Worker: 已加载');
