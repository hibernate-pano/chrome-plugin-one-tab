// 监听消息
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SAVE_ALL_TABS') {
    const { tabs } = message.data;
    saveAllTabs(tabs);
  }
  return true;
});

// 保存所有标签页
async function saveAllTabs(inputTabs: chrome.tabs.Tab[]) {
  const allTabs = inputTabs.length > 0 ? inputTabs : await chrome.tabs.query({ currentWindow: true });
  // 过滤掉 Chrome 内部页面和扩展页面
  let tabsToSave = allTabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

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

  const existingGroups = await chrome.storage.local.get('groups');
  const groups = existingGroups.groups || [];
  await chrome.storage.local.set({ groups: [...groups, tabGroup] });

  // 关闭已保存的标签页
  const tabIdsToClose = tabsToSave.map((tab: chrome.tabs.Tab) => tab.id).filter((id: number | undefined): id is number => id !== undefined);
  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  // 打开管理页面展示保存的标签
  await chrome.tabs.create({
    url: chrome.runtime.getURL('popup.html') + `?saved=${encodeURIComponent(JSON.stringify(tabUrls))}`
  });
}

// 保存当前标签页
async function saveCurrentTab(tab: chrome.tabs.Tab) {
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

  const existingGroups = await chrome.storage.local.get('groups');
  const groups = existingGroups.groups || [];
  await chrome.storage.local.set({ groups: [...groups, tabGroup] });
  await chrome.tabs.remove(tab.id!);
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
      if (tab) await saveCurrentTab(tab);
      break;
    case '_execute_action':
      // 默认行为，打开弹出窗口
      break;
  }
});
