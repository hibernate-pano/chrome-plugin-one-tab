import { tabManager } from '@/background/TabManager';
import { migrateToV2 } from '@/utils/migrationHelper';

// Chrome 扩展的 Service Worker
// 为了避免模块导入问题，早期版本内联了存储逻辑；现统一使用 utils/storage 以与前端页面共享同一数据源（IndexedDB）

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

async function runMigrations() {
  await migrateStorageKeys();

  try {
    await migrateToV2();
  } catch (error) {
    console.error('[Migration] 数据迁移失败:', error);
  }
}

const showNotification = async (message: string, title = 'TabVault Pro'): Promise<void> => {
  await tabManager.showNotification({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
};

console.log('Service Worker: 已简化同步逻辑，只保留手动同步功能');

// 初始化右键菜单
async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (error) {
    console.warn('清理旧的右键菜单失败，可忽略:', error);
  }

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
  console.log('Service Worker: 扩展已安装或更新');

  // 迁移旧的存储键 + 数据版本
  await runMigrations();

  // 创建右键菜单
  await setupContextMenus();
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(async () => {
  console.log('Service Worker: 浏览器已启动');
  // 尝试进行一次迁移，确保老用户数据可见
  await runMigrations();

  // 确保右键菜单存在
  await setupContextMenus();
});

// Service Worker 激活时也初始化一次，防止遗漏
setupContextMenus().catch(error => {
  console.error('初始化右键菜单失败:', error);
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  console.log('Service Worker版本:', chrome.runtime.getManifest().version);
  console.log('点击扩展图标，开始处理标签收集');

  try {
    // 显示处理中的通知
    await showNotification('正在收集标签页...');

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
    await showNotification('无法收集标签页，请重试。如果问题持续，请重启浏览器。');
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
          await tabManager.saveCurrentTab(activeTab);
          await showNotification('当前标签页已保存');
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
    await showNotification('快捷键操作失败，请重试');
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
      await tabManager.saveCurrentTab(tab);
      await showNotification('当前标签页已保存');
      await tabManager.openTabManager(true);
    } else if (info.menuItemId === 'saveOtherTabs') {
      console.log('点击右键菜单，保存除当前标签以外的所有标签');
      // 获取当前窗口的所有标签页和当前活动的标签页
      const [allTabs, activeTabs] = await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        chrome.tabs.query({ active: true, currentWindow: true })
      ]);
      
      // 获取当前活动的标签页ID
      const activeTabId = activeTabs.length > 0 ? activeTabs[0].id : null;
      
      // 过滤掉当前活动的标签页
      const otherTabs = activeTabId 
        ? allTabs.filter(t => t.id !== activeTabId)
        : allTabs;
      
      if (otherTabs.length === 0) {
        await showNotification('没有其他标签页需要保存');
        return;
      }

      await tabManager.saveAllTabs(otherTabs);
      await tabManager.openTabManager(true);
    }
  } catch (error) {
    console.error('处理右键菜单点击失败:', error);
  }
});

// 简化的消息处理
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
            message.data.urls.map((url: string) =>
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
          } catch (e: any) {
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
