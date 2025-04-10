import { syncService } from '@/services/syncService';

// 初始化同步服务
chrome.runtime.onStartup.addListener(() => {
  syncService.initialize();
});

// 扩展安装或更新时初始化
chrome.runtime.onInstalled.addListener(() => {
  syncService.initialize();
});

// 监听消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SAVE_ALL_TABS') {
    const { tabs } = message.data;
    saveAllTabs(tabs);
  } else if (message.type === 'SAVE_CURRENT_TAB') {
    const { tab, settings } = message.data;
    saveCurrentTab(tab, settings);
  } else if (message.type === 'OPEN_TAB') {
    openTabWithSingleInstance(message.data.url);
  } else if (message.type === 'OPEN_TABS') {
    openTabsWithSingleInstance(message.data.urls);
  } else if (message.action === 'sync') {
    syncService.syncAll()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  } else if (message.action === 'updateSyncInterval') {
    syncService.updateSyncInterval();
    sendResponse({ success: true });
  }
  return true;
});

// 使用Chrome的alarms API进行定时同步
chrome.alarms.create('syncAlarm', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'syncAlarm') {
    syncService.syncAll();
  }
});

// 打开单个标签页，保持只有一个 OneTabPlus 标签页
async function openTabWithSingleInstance(url: string) {
  // 打开要恢复的标签页
  await chrome.tabs.create({ url });

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('popup.html');
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
  // 打开要恢复的所有标签页
  for (const url of urls) {
    await chrome.tabs.create({ url });
  }

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('popup.html');
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
  const settings = await chrome.storage.local.get('user_settings');
  const userSettings = settings.user_settings || { allowDuplicateTabs: false };

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

  const tabUrls = tabsToSave.map(tab => tab.url).filter(Boolean);

  const tabGroup = {
    id: Date.now().toString(),
    name: `Group ${new Date().toLocaleString()}`,
    tabs: tabsToSave.map(tab => ({
      id: tab.id?.toString() || '',
      title: tab.title || '',
      url: tab.url || '',
      favicon: tab.favIconUrl || '',
    })),
    createdAt: new Date().toISOString(),
    isLocked: false,
  };

  const existingGroups = await chrome.storage.local.get('tab_groups');
  const groups = existingGroups.tab_groups || [];
  await chrome.storage.local.set({ tab_groups: [...groups, tabGroup] });

  // 关闭已保存的标签页（包括重复的）
  const tabIdsToClose = allTabsToClose.map((tab: chrome.tabs.Tab) => tab.id).filter((id: number | undefined): id is number => id !== undefined);
  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('popup.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  if (existingTabs.length > 0) {
    // 如果已经有标签页打开，则更新并激活它
    const existingTab = existingTabs[0];
    await chrome.tabs.update(existingTab.id!, {
      url: extensionUrl + `?saved=${encodeURIComponent(JSON.stringify(tabUrls))}`,
      active: true
    });
  } else {
    // 如果没有标签页打开，则创建一个新的
    await chrome.tabs.create({
      url: extensionUrl + `?saved=${encodeURIComponent(JSON.stringify(tabUrls))}`
    });
  }
}

// 保存当前标签页
async function saveCurrentTab(tab: chrome.tabs.Tab, userSettings?: any) {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
    return;
  }

  const tabGroup = {
    id: Date.now().toString(),
    name: `Single Tab ${new Date().toLocaleString()}`,
    tabs: [{
      id: tab.id?.toString() || '',
      title: tab.title || '',
      url: tab.url || '',
      favicon: tab.favIconUrl || '',
    }],
    createdAt: new Date().toISOString(),
    isLocked: false,
  };

  const existingGroups = await chrome.storage.local.get('tab_groups');
  const groups = existingGroups.tab_groups || [];
  await chrome.storage.local.set({ tab_groups: [...groups, tabGroup] });

  // 获取设置
  const settings = userSettings || (await chrome.storage.local.get('user_settings')).user_settings || { autoCloseTabsAfterSaving: true };

  // 如果设置为保存后关闭标签页
  if (settings.autoCloseTabsAfterSaving && tab.id) {
    await chrome.tabs.remove(tab.id);
  }

  // 检查是否已经有 OneTabPlus 标签页打开
  const extensionUrl = chrome.runtime.getURL('popup.html');
  const existingTabs = await chrome.tabs.query({ url: extensionUrl + '*' });

  if (existingTabs.length > 0) {
    // 如果已经有标签页打开，则更新并激活它
    const existingTab = existingTabs[0];
    await chrome.tabs.update(existingTab.id!, {
      url: extensionUrl + `?saved=${encodeURIComponent(JSON.stringify([tab.url]))}`,
      active: true
    });
  } else {
    // 如果没有标签页打开，则创建一个新的
    await chrome.tabs.create({
      url: extensionUrl + `?saved=${encodeURIComponent(JSON.stringify([tab.url]))}`
    });
  }
}

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await saveAllTabs(tabs);
});

// 监听快捷键
chrome.commands.onCommand.addListener(async (command, tab) => {
  switch (command) {
    case 'save_all_tabs':
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await saveAllTabs(tabs);
      break;
    case 'save_current_tab':
      if (tab) {
        // 获取用户设置
        const settings = await chrome.storage.local.get('user_settings');
        const userSettings = settings.user_settings || { autoCloseTabsAfterSaving: true };
        await saveCurrentTab(tab, userSettings);
      }
      break;
    case '_execute_action':
      // 默认行为，打开弹出窗口
      break;
  }
});
