// Chrome 扩展的 Service Worker
import { storage } from './utils/storage';
import { showNotificationWithId } from './utils/notification';

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
chrome.runtime.onStartup.addListener(() => {
  console.log('Service Worker: 浏览器已启动');
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  console.log('点击扩展图标，检查是否有标签管理页面并处理标签');

  // 先检查是否已经有标签管理页打开
  const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  if (existingTabs.length > 0) {
    // 如果已经有标签管理页打开，则激活它并刷新
    console.log('已有标签管理页打开，激活并刷新');
    if (existingTabs[0].id) {
      await chrome.tabs.update(existingTabs[0].id, { active: true });
      await chrome.tabs.reload(existingTabs[0].id);
    }
  } else {
    // 如果没有标签管理页打开，则创建新的
    console.log('没有标签管理页打开，创建新的');
    await chrome.tabs.create({ url: extensionUrl });
  }

  // 然后再保存所有标签页
  console.log('保存所有标签页');
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await saveAllTabs(tabs);
});

// 监听快捷键
chrome.commands.onCommand.addListener(async (command, tab) => {
  switch (command) {
    case 'save_all_tabs':
      console.log('快捷键保存所有标签页');
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await saveAllTabs(tabs);
      break;
    case 'save_current_tab':
      console.log('快捷键保存当前标签页');
      if (tab) {
        await saveCurrentTab(tab);
      }
      break;
    case '_execute_action':
      console.log('快捷键打开标签管理器');
      // 打开标签管理器页面
      const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
      // 检查是否已经有标签管理页打开
      const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

      if (existingTabs.length > 0) {
        // 如果已经有标签管理页打开，则激活它
        console.log('已有标签管理页打开，激活');
        if (existingTabs[0].id) {
          await chrome.tabs.update(existingTabs[0].id, { active: true });
        }
      } else {
        // 如果没有标签管理页打开，则创建新的
        console.log('没有标签管理页打开，创建新的');
        await chrome.tabs.create({ url: extensionUrl });
      }
      break;
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'open-tab-manager') {
    console.log('点击右键菜单，打开标签管理器');
    // 打开标签管理器页面
    const extensionUrl = chrome.runtime.getURL('src/popup/index.html');

    // 检查是否已经有标签管理页打开
    const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

    if (existingTabs.length > 0) {
      // 如果已经有标签管理页打开，则激活它
      console.log('已有标签管理页打开，激活');
      await chrome.tabs.update(existingTabs[0].id!, { active: true });
    } else {
      // 如果没有标签管理页打开，则创建新的
      console.log('没有标签管理页打开，创建新的');
      await chrome.tabs.create({ url: extensionUrl });
    }
  }
});

// 处理消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('Service Worker 收到消息:', message);

  // 移除自动检查更新功能

  // 处理保存标签页的消息
  if (message.type === 'SAVE_ALL_TABS') {
    saveAllTabs(message.data.tabs)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'SAVE_CURRENT_TAB') {
    saveCurrentTab(message.data.tab)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理打开标签页的消息
  if (message.type === 'OPEN_TAB') {
    openTabWithSingleInstance(message.data.url)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'OPEN_TABS') {
    openTabsWithSingleInstance(message.data.urls)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 如果没有处理消息，返回 false
  return false;
});

// 保存所有标签页
async function saveAllTabs(inputTabs: chrome.tabs.Tab[]) {
  const allTabs = inputTabs.length > 0 ? inputTabs : await chrome.tabs.query({ currentWindow: true });

  // 记录所有标签页的状态，用于调试
  console.log('所有标签页状态:', allTabs.map(tab => ({
    id: tab.id,
    url: tab.url,
    status: tab.status,
    title: tab.title
  })));

  // 过滤掉 Chrome 内部页面和扩展页面
  // 注意：不再检查标签页的加载状态，允许所有有效URL的标签页被保存
  let tabsToSave = allTabs.filter(tab => {
    // 如果标签页有URL，则检查URL是否为内部页面
    if (tab.url) {
      return !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://');
    }
    // 如果URL为空，但标题不为空，则保存该标签页（可能是正在加载的页面）
    return tab.title && tab.title.trim() !== '';
  });

  // 保存所有要关闭的标签页（包括重复的）
  const allTabsToClose = [...tabsToSave];

  // 获取设置
  const settings = await storage.getSettings();
  const userSettings = settings || { allowDuplicateTabs: false };

  // 如果不允许重复标签页，则过滤重复的URL
  if (!userSettings.allowDuplicateTabs) {
    const uniqueUrls = new Set<string>();
    tabsToSave = tabsToSave.filter(tab => {
      if (tab.url && !uniqueUrls.has(tab.url)) {
        uniqueUrls.add(tab.url);
        return true;
      }
      return false;
    });
  }

  if (tabsToSave.length === 0) {
    console.log("没有需要保存的有效标签页。");
    return; // 如果没有有效标签页，则不执行后续操作
  }

  const tabGroup = {
    id: Date.now().toString(),
    name: `标签组 ${new Date().toLocaleString()}`,
    tabs: tabsToSave.map(tab => {
      // 如果标签页没有URL但有标题，使用一个特殊的URL标记
      const url = tab.url || (tab.title ? `loading://${encodeURIComponent(tab.title)}` : '');
      return {
        id: tab.id?.toString() || '',
        title: tab.title || '',
        url: url,
        favicon: tab.favIconUrl || '',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
      };
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false
  };

  // 获取现有标签组
  const existingGroups = await storage.getGroups();
  // 保存新标签组
  await storage.setGroups([tabGroup, ...existingGroups]);

  // 不再自动同步到云端，保证本地操作优先，避免卡顿
  // 用户可以通过点击同步按钮手动同步
  console.log('标签页已保存到本地，跳过自动同步，保证操作丰满顺畅');

  // 关闭已保存的标签页（包括重复的）
  const tabIdsToClose = allTabsToClose.map((tab: chrome.tabs.Tab) => tab.id).filter((id: number | undefined): id is number => id !== undefined);
  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  // 创建通知ID
  const notificationId = `save-tabs-${Date.now()}`;

  // 显示通知，并添加按钮
  await showNotificationWithId(notificationId, {
    type: 'basic',
    iconUrl: '/icons/icon128.png',
    title: '标签已保存',
    message: `已成功保存 ${tabsToSave.length} 个标签页`,
    buttons: [
      { title: '打开标签管理器' }
    ],
    requireInteraction: true // 保持通知直到用户与其交互
  });

  // 监听通知按钮点击
  chrome.notifications.onButtonClicked.addListener(async (clickedId, buttonIndex) => {
    if (clickedId === notificationId && buttonIndex === 0) {
      // 打开标签管理器
      const extensionUrl = chrome.runtime.getURL('src/popup/index.html');

      // 检查是否已经有标签管理页打开
      const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

      if (existingTabs.length > 0) {
        // 如果已经有标签管理页打开，则激活它并刷新
        await chrome.tabs.update(existingTabs[0].id!, { active: true });
        await chrome.tabs.reload(existingTabs[0].id!);
      } else {
        // 如果没有标签管理页打开，则创建新的
        await chrome.tabs.create({ url: extensionUrl });
      }
    }
  });
}

// 保存当前标签页
async function saveCurrentTab(tab: chrome.tabs.Tab) {
  // 如果有URL，检查是否为内部页面
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://'))) {
    return;
  }

  // 如果URL为空且标题为空，则不保存
  if (!tab.url && (!tab.title || tab.title.trim() === '')) {
    return;
  }

  // 记录标签页状态，用于调试
  console.log('保存当前标签页状态:', {
    id: tab.id,
    url: tab.url,
    status: tab.status,
    title: tab.title
  });

  // 如果标签页没有URL但有标题，使用一个特殊的URL标记
  const url = tab.url || (tab.title ? `loading://${encodeURIComponent(tab.title)}` : '');

  const tabGroup = {
    id: Date.now().toString(),
    name: `单个标签 ${new Date().toLocaleString()}`,
    tabs: [{
      id: tab.id?.toString() || '',
      title: tab.title || '',
      url: url,
      favicon: tab.favIconUrl || '',
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false
  };

  // 获取现有标签组
  const existingGroups = await storage.getGroups();
  // 保存新标签组
  await storage.setGroups([tabGroup, ...existingGroups]);

  // 不再自动同步到云端，保证本地操作优先，避免卡顿
  // 用户可以通过点击同步按钮手动同步
  console.log('标签页已保存到本地，跳过自动同步，保证操作丰满顺畅');

  // 保存后自动关闭标签页
  if (tab.id) {
    await chrome.tabs.remove(tab.id);
  }

  // 创建通知ID
  const notificationId = `save-tab-${Date.now()}`;

  // 显示通知，并添加按钮
  await showNotificationWithId(notificationId, {
    type: 'basic',
    iconUrl: '/icons/icon128.png',
    title: '标签已保存',
    message: `已成功保存标签页: ${tab.title || tab.url}`,
    buttons: [
      { title: '打开标签管理器' }
    ],
    requireInteraction: true // 保持通知直到用户与其交互
  });

  // 监听通知按钮点击
  chrome.notifications.onButtonClicked.addListener(async (clickedId, buttonIndex) => {
    if (clickedId === notificationId && buttonIndex === 0) {
      // 打开标签管理器
      const extensionUrl = chrome.runtime.getURL('src/popup/index.html');

      // 检查是否已经有标签管理页打开
      const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

      if (existingTabs.length > 0) {
        // 如果已经有标签管理页打开，则激活它并刷新
        await chrome.tabs.update(existingTabs[0].id!, { active: true });
        await chrome.tabs.reload(existingTabs[0].id!);
      } else {
        // 如果没有标签管理页打开，则创建新的
        await chrome.tabs.create({ url: extensionUrl });
      }
    }
  });
}

// 打开单个标签页，保留标签管理器页面
async function openTabWithSingleInstance(url: string) {
  console.log('打开标签页:', url);

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  // 记录标签管理器页面的ID，以便后续激活
  let tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

  // 打开要恢复的标签页，但不激活它
  await chrome.tabs.create({ url, active: false });

  // 如果有标签管理器页面，则激活它
  if (tabManagerId) {
    await chrome.tabs.update(tabManagerId, { active: true });
  }

  // 如果有多个标签管理器页面，只保留第一个，关闭其他的
  if (existingTabs.length > 1) {
    const tabsToClose = existingTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose);
    }
  }
}

// 打开多个标签页，保留标签管理器页面
async function openTabsWithSingleInstance(urls: string[]) {
  console.log('打开多个标签页:', urls);

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  // 记录标签管理器页面的ID，以便后续激活
  let tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

  // 打开要恢复的所有标签页，但不激活它们
  for (const url of urls) {
    await chrome.tabs.create({ url, active: false });
  }

  // 如果有标签管理器页面，则激活它
  if (tabManagerId) {
    await chrome.tabs.update(tabManagerId, { active: true });
  }

  // 如果有多个标签管理器页面，只保留第一个，关闭其他的
  if (existingTabs.length > 1) {
    const tabsToClose = existingTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose);
    }
  }
}

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  // 创建右键菜单项
  chrome.contextMenus.create({
    id: 'saveCurrentTab',
    title: '保存当前标签',
    contexts: ['action'] // 只在点击扩展图标时显示
  });
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'saveCurrentTab' && tab) {
    // 保存当前标签页
    await handleSaveCurrentTab(tab);
  }
});

// 监听右键菜单保存当前标签页
async function handleSaveCurrentTab(tab: chrome.tabs.Tab) {
  if (tab && tab.url) {
    // 调用保存当前标签页的函数
    await saveCurrentTab(tab);

    // 保存后打开标签管理器并刷新数据
    const extensionUrl = chrome.runtime.getURL('src/popup/index.html');

    // 检查是否已经有标签管理页打开
    const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

    if (existingTabs.length > 0) {
      // 如果已经有标签管理页打开，则激活它并刷新
      await chrome.tabs.update(existingTabs[0].id!, { active: true });
      await chrome.tabs.reload(existingTabs[0].id!);
    } else {
      // 如果没有标签管理页打开，则创建新的
      await chrome.tabs.create({ url: extensionUrl });
    }
  }
}

// 导出一个空对象，确保这个文件被视为模块
export { };
