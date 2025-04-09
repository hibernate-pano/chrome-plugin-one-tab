// 保存所有标签页
async function saveAllTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const tabUrls = tabs.map(tab => tab.url).filter(Boolean);

  const tabGroup = {
    id: Date.now().toString(),
    name: `Group ${new Date().toLocaleString()}`,
    tabs: tabs.map(tab => ({
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

  // 关闭所有标签页并打开管理页面
  const tabIds = tabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
  await chrome.tabs.remove(tabIds);

  // 打开管理页面展示保存的标签
  await chrome.tabs.create({
    url: chrome.runtime.getURL('popup.html') + `?saved=${encodeURIComponent(JSON.stringify(tabUrls))}`
  });
}

// 保存当前标签页
async function saveCurrentTab(tab: chrome.tabs.Tab) {
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
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
  await saveAllTabs();
});

// 监听快捷键
chrome.commands.onCommand.addListener(async (command, tab) => {
  switch (command) {
    case 'save_all_tabs':
      await saveAllTabs();
      break;
    case 'save_current_tab':
      if (tab) await saveCurrentTab(tab);
      break;
    case '_execute_action':
      // 默认行为，打开弹出窗口
      break;
  }
});
