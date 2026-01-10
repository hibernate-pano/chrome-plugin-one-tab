// Chrome 扩展的 Service Worker
// 为了避免模块导入问题，直接在Service Worker中实现核心功能

// 最小 IndexedDB KV 存储，保证与前端一致
const DB_NAME = 'tabvaultpro';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const MIGRATION_KEYS = {
  tabGroups: 'tab_groups',
  legacyTabGroups: 'tabGroups',
  migrationFlags: 'migration_flags'
};

let cachedDb = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

async function getDb() {
  if (cachedDb) return cachedDb;
  cachedDb = await openDatabase();
  cachedDb.onversionchange = () => {
    cachedDb && cachedDb.close();
    cachedDb = null;
  };
  return cachedDb;
}

async function runTransaction(mode, action) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, mode);
    const store = tx.objectStore(KV_STORE);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

const kv = {
  async get(key) {
    const result = await runTransaction('readonly', store => store.get(key));
    if (result && typeof result === 'object' && 'value' in result) return result.value;
    return result ?? null;
  },
  async set(key, value) {
    await runTransaction('readwrite', store => store.put({ key, value }));
  },
  async remove(key) {
    await runTransaction('readwrite', store => store.delete(key));
  }
};

// 迁移 chrome.storage.local -> IndexedDB（只执行一次）
async function migrateStorageKeys() {
  try {
    const flags = (await kv.get(MIGRATION_KEYS.migrationFlags)) || {};
    if (flags.chromeStorageMigrated) return;

    const { tabGroups } = await chrome.storage.local.get([MIGRATION_KEYS.legacyTabGroups]);
    const { tab_groups } = await chrome.storage.local.get([MIGRATION_KEYS.tabGroups]);

    const payload = tab_groups && Array.isArray(tab_groups) ? tab_groups : tabGroups;
    if (Array.isArray(payload) && payload.length) {
      await kv.set(MIGRATION_KEYS.tabGroups, payload);
    }

    flags.chromeStorageMigrated = true;
    await kv.set(MIGRATION_KEYS.migrationFlags, flags);
    await chrome.storage.local.remove([MIGRATION_KEYS.tabGroups, MIGRATION_KEYS.legacyTabGroups]);
  } catch (error) {
    // 迁移失败可忽略
  }
}

// 与前端统一的存储接口
const storage = {
  async getGroups() {
    try {
      const groups = await kv.get(MIGRATION_KEYS.tabGroups);
      return Array.isArray(groups) ? groups : [];
    } catch {
      return [];
    }
  },

  async setGroups(groups) {
    await kv.set(MIGRATION_KEYS.tabGroups, groups);
  },

  async getSettings() {
    try {
      const settings = await kv.get('user_settings');
      return settings || { collectPinnedTabs: false };
    } catch {
      return { collectPinnedTabs: false };
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
    const existingTabs = await this.getExistingTabManagerTabs();
    if (existingTabs.length > 0) {
      const tab = existingTabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (shouldRefresh) await chrome.tabs.reload(tab.id);
      }
    } else {
      await chrome.tabs.create({ url: this.getExtensionUrl() });
    }
  },

  // 过滤有效的标签页
  filterValidTabs(tabs, collectPinnedTabs = false) {
    return tabs.filter(tab => {
      if (!collectPinnedTabs && tab.pinned) return false;
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
    const settings = await storage.getSettings();
    const collectPinnedTabs = settings.collectPinnedTabs ?? false;
    const validTabs = this.filterValidTabs(tabs, collectPinnedTabs);
    const now = new Date().toISOString();

    const formattedTabs = validTabs.map(tab => ({
      id: generateId(),
      url: tab.url || 'about:blank',
      title: tab.title || '未命名标签页',
      favicon: sanitizeFaviconUrl(tab.favIconUrl),
      createdAt: now,
      lastAccessed: now,
      isPinned: tab.pinned ?? false, // 保留固定状态
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

  // 保存所有标签页（不关闭标签页，由调用方决定是否关闭）
  async saveAllTabs(inputTabs, closeAfterSave = true) {
    try {
      const tabs = inputTabs || await chrome.tabs.query({ currentWindow: true });
      const tabGroup = await this.createTabGroup(tabs);

      if (tabGroup.tabs.length === 0) {
        await this.showNotification('没有找到可保存的标签页');
        return { saved: false, tabsToClose: [] };
      }

      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);
      await this.showNotification(`已成功保存 ${tabGroup.tabs.length} 个标签页`);

      // 获取需要关闭的标签页ID
      const settings = await storage.getSettings();
      const collectPinnedTabs = settings.collectPinnedTabs ?? false;
      const tabsToClose = this.filterValidTabs(tabs, collectPinnedTabs);
      const tabIdsToClose = tabsToClose.map(tab => tab.id).filter(id => id !== undefined);

      return { saved: true, tabIdsToClose };
    } catch (error) {
      await this.showNotification('保存标签页时发生错误，请重试');
      throw error;
    }
  },

  // 关闭指定的标签页（在确保有其他标签页存在后调用）
  async closeTabs(tabIds) {
    if (!tabIds || tabIds.length === 0) return;
    try {
      await chrome.tabs.remove(tabIds);
    } catch { /* ignore */ }
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

// 初始化右键菜单
async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch { /* ignore */ }

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

  chrome.contextMenus.create({
    id: 'saveOtherTabs',
    title: '保存除当前标签以外的所有标签',
    contexts: ['action']
  });
}

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(async () => {
  await migrateStorageKeys();
  await setupContextMenus();
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(async () => {
  await migrateStorageKeys();
  await setupContextMenus();
});

// Service Worker 激活时也初始化一次
setupContextMenus().catch(() => {});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  try {
    await tabManager.showNotification('正在收集标签页...');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const result = await tabManager.saveAllTabs(tabs);
    
    if (result.saved && result.tabIdsToClose && result.tabIdsToClose.length > 0) {
      // 先打开标签管理器，确保窗口中有标签页
      await tabManager.openTabManager(true);
      // 然后关闭已保存的标签页
      await tabManager.closeTabs(result.tabIdsToClose);
    } else {
      await tabManager.openTabManager(true);
    }
  } catch {
    await tabManager.showNotification('无法收集标签页，请重试。如果问题持续，请重启浏览器。');
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case 'save_all_tabs': {
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const result = await tabManager.saveAllTabs(allTabs);
        if (result.saved && result.tabIdsToClose && result.tabIdsToClose.length > 0) {
          await tabManager.openTabManager(true);
          await tabManager.closeTabs(result.tabIdsToClose);
        }
        break;
      }
      case 'save_current_tab': {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          const tabGroup = await tabManager.createTabGroup([activeTab]);
          if (tabGroup.tabs.length > 0) {
            const existingGroups = await storage.getGroups();
            await storage.setGroups([tabGroup, ...existingGroups]);
            await tabManager.showNotification('当前标签页已保存');
            // 先打开标签管理器，再关闭当前标签
            await tabManager.openTabManager(false);
            if (activeTab.id) await chrome.tabs.remove(activeTab.id);
          }
        }
        break;
      }
      case '_execute_action':
        await tabManager.openTabManager();
        break;
    }
  } catch {
    await tabManager.showNotification('快捷键操作失败，请重试');
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'open-tab-manager') {
      await tabManager.openTabManager();
    } else if (info.menuItemId === 'saveCurrentTab' && tab) {
      const tabGroup = await tabManager.createTabGroup([tab]);
      if (tabGroup.tabs.length > 0) {
        const existingGroups = await storage.getGroups();
        await storage.setGroups([tabGroup, ...existingGroups]);
        await tabManager.showNotification('当前标签页已保存');
        // 先打开标签管理器，再关闭当前标签
        await tabManager.openTabManager(true);
        if (tab.id) await chrome.tabs.remove(tab.id);
      } else {
        await tabManager.openTabManager(true);
      }
    } else if (info.menuItemId === 'saveOtherTabs') {
      const [allTabs, activeTabs] = await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        chrome.tabs.query({ active: true, currentWindow: true })
      ]);

      const activeTabId = activeTabs.length > 0 ? activeTabs[0].id : null;
      const otherTabs = activeTabId ? allTabs.filter(t => t.id !== activeTabId) : allTabs;

      if (otherTabs.length === 0) {
        await tabManager.showNotification('没有其他标签页需要保存');
        return;
      }

      const tabGroup = await tabManager.createTabGroup(otherTabs);
      if (tabGroup.tabs.length > 0) {
        const existingGroups = await storage.getGroups();
        await storage.setGroups([tabGroup, ...existingGroups]);
        await tabManager.showNotification(`已保存 ${tabGroup.tabs.length} 个标签页`);

        const settings = await storage.getSettings();
        const collectPinnedTabs = settings.collectPinnedTabs ?? false;
        const tabsToClose = tabManager.filterValidTabs(otherTabs, collectPinnedTabs);
        const tabIdsToClose = tabsToClose.map(t => t.id).filter(id => id !== undefined);

        // 先打开标签管理器，再关闭其他标签
        await tabManager.openTabManager(true);
        await tabManager.closeTabs(tabIdsToClose);
      } else {
        await tabManager.openTabManager(true);
      }
    }
  } catch { /* ignore */ }
});

// 简化的消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
          Promise.all(message.data.urls.map(url => chrome.tabs.create({ url, active: false })))
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }
        break;

      case 'SAVE_ALL_TABS':
        (async () => {
          try {
            const tabs = await chrome.tabs.query({ currentWindow: true });
            const result = await tabManager.saveAllTabs(tabs);
            if (result.saved && result.tabIdsToClose && result.tabIdsToClose.length > 0) {
              await tabManager.openTabManager(true);
              await tabManager.closeTabs(result.tabIdsToClose);
            }
            sendResponse({ success: true });
          } catch (e) {
            sendResponse({ success: false, error: e?.message || '保存失败' });
          }
        })();
        return true;

      case 'REFRESH_TAB_LIST':
        sendResponse({ success: true });
        return false;

      default:
        sendResponse({ success: false, error: '未知消息类型' });
        return false;
    }
  } catch {
    sendResponse({ success: false, error: '处理消息失败' });
    return false;
  }
});
