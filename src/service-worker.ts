// Chrome 扩展的 Service Worker
import { storage } from './utils/storage';
import { auth as supabaseAuth } from './utils/supabase';
import { sync as supabaseSync } from './utils/supabase';
import { showNotification, showNotificationWithId } from './utils/notification';

// 定义检查更新的间隔（分钟）
const CHECK_INTERVAL_MINUTES = 15;

// 创建一个定期检查更新的 alarm
chrome.alarms.create('checkUpdates', {
  periodInMinutes: CHECK_INTERVAL_MINUTES
});

// 监听 alarm 事件
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkUpdates') {
    await checkForUpdates();
  }
});

// 检查云端更新
async function checkForUpdates() {
  try {
    console.log('Service Worker: 检查云端更新...');

    // 检查用户是否已登录
    try {
      const { data } = await supabaseAuth.getSession();
      // 如果没有会话或会话不存在，直接跳过检查更新
      if (!data || !data.session) {
        console.log('Service Worker: 用户未登录，跳过检查更新');
        return;
      }
      // 到这里说明用户已登录，继续检查更新
      console.log('Service Worker: 用户已登录，开始检查更新');
    } catch (err) {
      console.error('Service Worker: 检查用户登录状态异常', err);
      return;
    }

    // 获取本地数据
    const localGroups = await storage.getGroups();
    const localSettings = await storage.getSettings();

    // 获取最后同步时间
    const lastSyncTime = await storage.getLastSyncTime();

    // 如果没有最后同步时间，或者最后同步时间超过一定时间，则执行同步
    const now = new Date().getTime();
    const lastSync = lastSyncTime ? new Date(lastSyncTime).getTime() : 0;
    const timeSinceLastSync = now - lastSync;

    // 如果最后同步时间超过 1 小时，则执行同步
    if (timeSinceLastSync > 60 * 60 * 1000) {
      console.log('Service Worker: 最后同步时间超过 1 小时，执行同步');
      await syncData();
      return;
    }

    // 检查云端是否有更新
    const cloudGroups = await supabaseSync.downloadTabGroups();
    const cloudSettings = await supabaseSync.downloadSettings();

    // 检查是否有更新
    const hasUpdates = checkForChanges(localGroups, cloudGroups) ||
      checkForChanges(localSettings, cloudSettings);

    if (hasUpdates) {
      console.log('Service Worker: 检测到云端有更新，执行同步');
      await syncData();

      // 发送通知（可选）
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: 'OneTabPlus 更新',
        message: '检测到云端数据有更新，已自动同步'
      });
    } else {
      console.log('Service Worker: 云端没有更新');
    }
  } catch (error) {
    console.error('Service Worker: 检查更新失败', error);
  }
}

// 执行数据同步
async function syncData() {
  try {
    // 导入同步服务
    const { syncService } = await import('./services/syncService');

    // 使用后台同步模式
    await syncService.backgroundSync();

    console.log('Service Worker: 数据同步完成');
  } catch (error) {
    console.error('Service Worker: 数据同步失败', error);
  }
}

// 检查两个对象是否有差异
function checkForChanges(local: any, cloud: any) {
  if (!local || !cloud) return true;

  // 如果是数组，检查长度和内容
  if (Array.isArray(local) && Array.isArray(cloud)) {
    if (local.length !== cloud.length) return true;

    // 检查最后更新时间
    const localLastUpdated = local.reduce((latest, item) => {
      const itemTime = new Date(item.updatedAt || 0).getTime();
      return itemTime > latest ? itemTime : latest;
    }, 0);

    const cloudLastUpdated = cloud.reduce((latest, item) => {
      const itemTime = new Date(item.updatedAt || 0).getTime();
      return itemTime > latest ? itemTime : latest;
    }, 0);

    return cloudLastUpdated > localLastUpdated;
  }

  // 简单比较对象
  return JSON.stringify(local) !== JSON.stringify(cloud);
}

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(() => {
  console.log('Service Worker: 扩展已安装或更新');
  // 设置初始检查
  chrome.alarms.create('initialCheck', { delayInMinutes: 1 });

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
  // 设置初始检查
  chrome.alarms.create('initialCheck', { delayInMinutes: 1 });
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
    await chrome.tabs.update(existingTabs[0].id!, { active: true });
    await chrome.tabs.reload(existingTabs[0].id!);
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
        // 获取用户设置
        const settings = await storage.getSettings();
        await saveCurrentTab(tab, settings);
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
        await chrome.tabs.update(existingTabs[0].id!, { active: true });
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

  if (message.action === 'checkUpdates') {
    checkForUpdates()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  // 处理保存标签页的消息
  if (message.type === 'SAVE_ALL_TABS') {
    saveAllTabs(message.data.tabs)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }

  if (message.type === 'SAVE_CURRENT_TAB') {
    saveCurrentTab(message.data.tab, message.data.settings)
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

  // 如果用户已登录，自动同步到云端
  try {
    // 首先检查是否有活跃会话，避免未登录用户触发错误
    const { data } = await supabaseAuth.getSession();

    // 只有存在会话时才执行同步
    if (data && data.session) {
      console.log('检测到用户已登录，保存后自动同步到云端');
      // 异步执行同步，不阻塞保存操作
      // 使用后台同步模式
      const { syncService } = await import('./services/syncService');
      syncService.backgroundSync().catch(err => {
        console.error('保存后同步失败:', err);
      });
    } else {
      console.log('用户未登录，跳过同步操作');
    }
  } catch (syncError) {
    console.error('检查用户登录状态失败:', syncError);
  }

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
async function saveCurrentTab(tab: chrome.tabs.Tab, userSettings?: any) {
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

  // 如果用户已登录，自动同步到云端
  try {
    // 首先检查是否有活跃会话，避免未登录用户触发错误
    const { data } = await supabaseAuth.getSession();

    // 只有存在会话时才执行同步
    if (data && data.session) {
      console.log('检测到用户已登录，保存后自动同步到云端');
      // 异步执行同步，不阻塞保存操作
      // 使用后台同步模式
      const { syncService } = await import('./services/syncService');
      syncService.backgroundSync().catch(err => {
        console.error('保存后同步失败:', err);
      });
    } else {
      console.log('用户未登录，跳过同步操作');
    }
  } catch (syncError) {
    console.error('检查用户登录状态失败:', syncError);
  }

  // 获取设置
  const settings = userSettings || await storage.getSettings() || { autoCloseTabsAfterSaving: true };

  // 如果设置为保存后关闭标签页
  if (settings.autoCloseTabsAfterSaving && tab.id) {
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
    // 获取设置
    const settings = await storage.getSettings();
    // 调用保存当前标签页的函数
    await saveCurrentTab(tab, settings);

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
