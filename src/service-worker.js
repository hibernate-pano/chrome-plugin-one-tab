// Chrome 扩展的 Service Worker
// 为了避免模块导入问题，直接在Service Worker中实现核心功能

// Service Worker启动日志
console.log('=== TabVault Pro Service Worker 启动 ===');
console.log('版本:', chrome.runtime.getManifest().version);
console.log('启动时间:', new Date().toISOString());
console.log('Chrome APIs 可用性检查:');
console.log('- chrome.tabs:', !!chrome.tabs);
console.log('- chrome.runtime:', !!chrome.runtime);
console.log('- chrome.action:', !!chrome.action);
console.log('- chrome.storage:', !!chrome.storage);
console.log('=====================================');

// 迁移旧的存储键到新的统一键名
async function migrateStorageKeys() {
  try {
    const { tabGroups } = await chrome.storage.local.get(['tabGroups']);
    const { tab_groups } = await chrome.storage.local.get(['tab_groups']);

    // 如果存在旧键且新键不存在或为空，则迁移
    if (Array.isArray(tabGroups) && (!Array.isArray(tab_groups) || tab_groups.length === 0)) {
      await chrome.storage.local.set({ tab_groups: tabGroups });
      // 迁移完成后可选择清理旧键（可选）
      await chrome.storage.local.remove('tabGroups');
      console.log('已将旧键 tabGroups 迁移为 tab_groups');
    }
  } catch (error) {
    console.warn('迁移存储键失败（可忽略）:', error);
  }
}

// 简化的存储工具函数
const storage = {
  async getGroups() {
    try {
      const result = await chrome.storage.local.get(['tab_groups']);
      return result.tab_groups || [];
    } catch (error) {
      console.error('获取标签组失败:', error);
      return [];
    }
  },

  async setGroups(groups) {
    try {
      await chrome.storage.local.set({ tab_groups: groups });
    } catch (error) {
      console.error('保存标签组失败:', error);
      throw error;
    }
  }
};

// 生成简单的ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 清理favicon URL
function sanitizeFaviconUrl(url) {
  if (!url) return '';
  if (url.startsWith('chrome://')) return '';
  if (url.startsWith('chrome-extension://')) return '';
  return url;
}

// 简化的标签管理功能
const tabManager = {
  // 获取扩展页面URL
  getExtensionUrl() {
    return chrome.runtime.getURL('src/popup/index.html');
  },

  // 检查是否已有标签管理页面打开
  async getExistingTabManagerTabs() {
    const extensionUrl = this.getExtensionUrl();
    return await chrome.tabs.query({ url: extensionUrl + '*' });
  },

  // 打开或激活标签管理器页面
  async openTabManager(shouldRefresh = false) {
    console.log('打开标签管理器页面');
    const existingTabs = await this.getExistingTabManagerTabs();

    if (existingTabs.length > 0) {
      console.log('已有标签管理页打开，激活');
      const tab = existingTabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (shouldRefresh) {
          await chrome.tabs.reload(tab.id);
        }
      }
    } else {
      console.log('没有标签管理页打开，创建新的');
      await chrome.tabs.create({ url: this.getExtensionUrl() });
    }
  },

  // 过滤有效的标签页
  filterValidTabs(tabs) {
    return tabs.filter(tab => {
      if (tab.url) {
        return !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:');
      }
      return tab.title && tab.title.trim() !== '';
    });
  },

  // 创建标签组
  async createTabGroup(tabs) {
    const validTabs = this.filterValidTabs(tabs);
    const now = new Date().toISOString();

    const formattedTabs = validTabs.map(tab => ({
      id: generateId(),
      url: tab.url || 'about:blank',
      title: tab.title || '未命名标签页',
      favicon: sanitizeFaviconUrl(tab.favIconUrl),
      createdAt: now,
      lastAccessed: now,
    }));

    return {
      id: generateId(),
      name: `标签组 ${new Date().toLocaleString()}`,
      tabs: formattedTabs,
      createdAt: now,
      updatedAt: now,
      isLocked: false,
    };
  },

  // 保存所有标签页
  async saveAllTabs(inputTabs) {
    console.log('开始保存所有标签页');

    try {
      // 获取标签页列表
      const tabs = inputTabs || await chrome.tabs.query({ currentWindow: true });
      console.log(`查询到 ${tabs.length} 个标签页`);

      // 创建标签组
      const tabGroup = await this.createTabGroup(tabs);

      if (tabGroup.tabs.length === 0) {
        console.log('没有有效的标签页需要保存');
        await this.showNotification('没有找到可保存的标签页');
        return;
      }

      // 保存到存储
      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);

      console.log(`成功保存 ${tabGroup.tabs.length} 个标签页到新标签组`);
      await this.showNotification(`已成功保存 ${tabGroup.tabs.length} 个标签页`);

      // 关闭已保存的标签页
      const tabsToClose = this.filterValidTabs(tabs);
      const tabIdsToClose = tabsToClose
        .map(tab => tab.id)
        .filter(id => id !== undefined);

      if (tabIdsToClose.length > 0) {
        try {
          await chrome.tabs.create({ url: 'chrome://newtab' });
          await chrome.tabs.remove(tabIdsToClose);
          console.log(`已关闭 ${tabIdsToClose.length} 个标签页`);
        } catch (error) {
          console.warn('关闭标签页时出错:', error);
        }
      }

    } catch (error) {
      console.error('保存标签页失败:', error);
      await this.showNotification('保存标签页时发生错误，请重试');
      throw error;
    }
  },

  // 显示通知
  async showNotification(message) {
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'TabVault Pro',
        message: message
      });
    } catch (error) {
      console.error('显示通知失败:', error);
    }
  }
};

console.log('Service Worker: 已简化同步逻辑，只保留手动同步功能');

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Service Worker: 扩展已安装或更新');

  // 迁移旧的存储键
  await migrateStorageKeys();

  // 创建右键菜单
  chrome.contextMenus.create({
    id: 'open-tab-manager',
    title: '打开标签管理器',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'saveCurrentTab',
    title: '保存当前标签',
    contexts: ['action']
  });
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(async () => {
  console.log('Service Worker: 浏览器已启动');
  // 尝试进行一次迁移，确保老用户数据可见
  await migrateStorageKeys();
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  console.log('Service Worker版本:', chrome.runtime.getManifest().version);
  console.log('点击扩展图标，开始处理标签收集');

  try {
    // 显示处理中的通知
    await tabManager.showNotification('正在收集标签页...');

    // 查询当前窗口的所有标签页
    console.log('开始查询标签页...');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    console.log(`成功查询到 ${tabs.length} 个标签页`);

    // 保存标签页
    console.log('开始保存标签页...');
    await tabManager.saveAllTabs(tabs);
    console.log('标签页保存完成');

    // 打开标签管理器
    console.log('打开标签管理器...');
    await tabManager.openTabManager(true);
    console.log('标签管理器已打开');

  } catch (error) {
    console.error('处理扩展图标点击失败:', error);
    await tabManager.showNotification('无法收集标签页，请重试。如果问题持续，请重启浏览器。');
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  console.log('收到快捷键命令:', command);

  try {
    switch (command) {
      case 'save_all_tabs':
        console.log('快捷键保存所有标签页');
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        await tabManager.saveAllTabs(allTabs);
        break;

      case 'save_current_tab':
        console.log('快捷键保存当前标签页');
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (activeTab) {
          // 简化的保存当前标签页逻辑
          const tabGroup = await tabManager.createTabGroup([activeTab]);
          if (tabGroup.tabs.length > 0) {
            const existingGroups = await storage.getGroups();
            await storage.setGroups([tabGroup, ...existingGroups]);
            await tabManager.showNotification('当前标签页已保存');
            if (activeTab.id) {
              await chrome.tabs.remove(activeTab.id);
            }
          }
        } else {
          console.warn('未找到活跃标签页');
        }
        break;

      case '_execute_action':
        console.log('快捷键打开标签管理器');
        await tabManager.openTabManager();
        break;
    }
  } catch (error) {
    console.error('处理快捷键命令失败:', error);
    await tabManager.showNotification('快捷键操作失败，请重试');
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log('右键菜单点击:', info.menuItemId);

  try {
    if (info.menuItemId === 'open-tab-manager') {
      console.log('点击右键菜单，打开标签管理器');
      await tabManager.openTabManager();
    } else if (info.menuItemId === 'saveCurrentTab' && tab) {
      console.log('点击右键菜单，保存当前标签页');
      // 简化的保存当前标签页逻辑
      const tabGroup = await tabManager.createTabGroup([tab]);
      if (tabGroup.tabs.length > 0) {
        const existingGroups = await storage.getGroups();
        await storage.setGroups([tabGroup, ...existingGroups]);
        await tabManager.showNotification('当前标签页已保存');
        if (tab.id) {
          await chrome.tabs.remove(tab.id);
        }
      }
      // 保存后打开标签管理器
      await tabManager.openTabManager(true);
    }
  } catch (error) {
    console.error('处理右键菜单点击失败:', error);
  }
});

// 简化的消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Service Worker 收到消息:', message.type);

  // 基本验证
  if (!message || !message.type) {
    sendResponse({ success: false, error: '无效消息' });
    return false;
  }

  try {
    switch (message.type) {
      case 'OPEN_TAB':
        if (message.data?.url) {
          chrome.tabs.create({ url: message.data.url, active: false })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }
        break;

      case 'OPEN_TABS':
        if (Array.isArray(message.data?.urls)) {
          Promise.all(
            message.data.urls.map(url =>
              chrome.tabs.create({ url, active: false })
            )
          )
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }
        break;

      case 'SAVE_ALL_TABS':
        // 允许前端通过消息触发保存
        (async () => {
          try {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            await tabManager.saveAllTabs(tabs);
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || '保存失败' });
          }
        })();
        return true; // 异步响应

      case 'REFRESH_TAB_LIST':
        sendResponse({ success: true });
        return false;

      default:
        sendResponse({ success: false, error: '未知消息类型' });
        return false;
    }
  } catch (error) {
    console.error('处理消息失败:', error);
    sendResponse({ success: false, error: '处理消息失败' });
    return false;
  }
});