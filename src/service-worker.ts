// Chrome 扩展的 Service Worker
import { storage } from './utils/storage';
import { auth as supabaseAuth } from './utils/supabase';
import { sync as supabaseSync } from './utils/supabase';

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
      const { data, error } = await supabaseAuth.getSession();
      if (error) {
        console.log('Service Worker: 获取用户会话失败，跳过检查更新', error);
        return;
      }
      if (!data.session) {
        console.log('Service Worker: 用户未登录，跳过检查更新');
        return;
      }
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
      chrome.notifications.create({
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
    // 从云端同步设置
    const settings = await supabaseSync.downloadSettings();
    if (settings) {
      await storage.setSettings(settings);
    }

    // 从云端同步标签组
    const cloudGroups = await supabaseSync.downloadTabGroups();
    if (cloudGroups && cloudGroups.length > 0) {
      // 获取本地数据和已删除的标签组
      const localGroups = await storage.getGroups();
      const deletedGroups = await storage.getDeletedGroups();

      // 合并数据（使用您现有的合并逻辑）
      const { mergeTabGroups } = await import('./utils/syncUtils');
      const settings = await storage.getSettings();
      const mergedGroups = mergeTabGroups(localGroups, cloudGroups, settings.syncStrategy, deletedGroups);

      // 保存合并后的数据
      await storage.setGroups(mergedGroups);
    }

    // 更新最后同步时间
    await storage.setLastSyncTime(new Date().toISOString());

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
  console.log('点击扩展图标，保存所有标签页并打开标签管理器');
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await saveAllTabs(tabs);

  // 检查是否已经有标签管理页打开
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
    saveAllTabs(message.data.tabs);
    return true;
  }

  if (message.type === 'SAVE_CURRENT_TAB') {
    saveCurrentTab(message.data.tab, message.data.settings);
    return true;
  }

  // 处理打开标签页的消息
  if (message.type === 'OPEN_TAB') {
    openTabWithSingleInstance(message.data.url);
    return true;
  }

  if (message.type === 'OPEN_TABS') {
    openTabsWithSingleInstance(message.data.urls);
    return true;
  }
});

// 保存所有标签页
async function saveAllTabs(inputTabs: chrome.tabs.Tab[]) {
  const allTabs = inputTabs.length > 0 ? inputTabs : await chrome.tabs.query({ currentWindow: true });
  // 过滤掉 Chrome 内部页面和扩展页面
  let tabsToSave = allTabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

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
    tabs: tabsToSave.map(tab => ({
      id: tab.id?.toString() || '',
      title: tab.title || '',
      url: tab.url || '',
      favicon: tab.favIconUrl || '',
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    })),
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
    const { data } = await supabaseAuth.getSession();
    if (data.session) {
      console.log('检测到用户已登录，保存后自动同步到云端');
      // 异步执行同步，不阻塞保存操作
      syncData().catch(err => {
        console.error('保存后同步失败:', err);
      });
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
  chrome.notifications.create(notificationId, {
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
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
    return;
  }

  const tabGroup = {
    id: Date.now().toString(),
    name: `单个标签 ${new Date().toLocaleString()}`,
    tabs: [{
      id: tab.id?.toString() || '',
      title: tab.title || '',
      url: tab.url || '',
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
    const { data } = await supabaseAuth.getSession();
    if (data.session) {
      console.log('检测到用户已登录，保存后自动同步到云端');
      // 异步执行同步，不阻塞保存操作
      syncData().catch(err => {
        console.error('保存后同步失败:', err);
      });
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
  chrome.notifications.create(notificationId, {
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

// 打开单个标签页，保持只有一个 OneTabPlus 标签页
async function openTabWithSingleInstance(url: string) {
  console.log('打开标签页:', url);

  // 打开要恢复的标签页
  await chrome.tabs.create({ url });

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  if (existingTabs.length > 0) {
    // 如果有多个标签页，只保留第一个，关闭其他的
    if (existingTabs.length > 1) {
      const tabsToClose = existingTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
      if (tabsToClose.length > 0) {
        await chrome.tabs.remove(tabsToClose);
      }
    }
  }
}

// 打开多个标签页，保持只有一个 OneTabPlus 标签页
async function openTabsWithSingleInstance(urls: string[]) {
  console.log('打开多个标签页:', urls);

  // 打开要恢复的所有标签页
  for (const url of urls) {
    await chrome.tabs.create({ url });
  }

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('src/popup/index.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  if (existingTabs.length > 0) {
    // 如果有多个标签页，只保留第一个，关闭其他的
    if (existingTabs.length > 1) {
      const tabsToClose = existingTabs.slice(1).map(tab => tab.id!).filter(id => id !== undefined);
      if (tabsToClose.length > 0) {
        await chrome.tabs.remove(tabsToClose);
      }
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
