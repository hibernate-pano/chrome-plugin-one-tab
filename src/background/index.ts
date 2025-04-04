// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async (tab) => {
  // 如果当前标签页是 chrome:// 或 edge:// 页面，则不处理
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://')) {
    return;
  }

  // 获取当前窗口的所有标签页
  const tabs = await chrome.tabs.query({ currentWindow: true });
  
  // 保存标签页信息到存储
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

  // 从存储中获取现有的标签组
  const existingGroups = await chrome.storage.local.get('groups');
  const groups = existingGroups.groups || [];

  // 添加新的标签组
  await chrome.storage.local.set({
    groups: [...groups, tabGroup],
  });

  // 关闭所有标签页，只保留一个新标签页
  const currentTabs = await chrome.tabs.query({ currentWindow: true });
  const tabIds = currentTabs.map(tab => tab.id).filter((id): id is number => id !== undefined);
  
  // 创建一个新标签页
  await chrome.tabs.create({ url: 'chrome://newtab' });
  
  // 关闭其他标签页
  await chrome.tabs.remove(tabIds);
}); 