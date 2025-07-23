/**
 * Chrome扩展后台脚本
 * 处理插件图标点击、标签页管理、OAuth回调等功能
 */
import { nanoid } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { storage } from '@/shared/utils/storage';
import { showNotification } from '@/shared/utils/notification';
import { TabGroup } from '@/shared/types/tab';

console.log('Background script loaded - OneTab Plus');

/**
 * 创建标签组
 */
const createTabGroup = (tabs: chrome.tabs.Tab[]): TabGroup => {
  return {
    id: nanoid(),
    name: `标签组 ${new Date().toLocaleString()}`,
    version: 1, // 新标签组版本号从1开始
    tabs: tabs.map(tab => {
      // 如果标签页没有URL但有标题，使用一个特殊的URL标记
      const url = tab.url || (tab.title ? `loading://${encodeURIComponent(tab.title)}` : '');
      return {
        id: nanoid(),
        url: url,
        title: tab.title || '',
        favicon: tab.favIconUrl || '',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString()
      };
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false
  };
};

/**
 * 检查标签页是否为插件管理页面
 */
const isPluginManagementPage = (tab: chrome.tabs.Tab): boolean => {
  if (!tab.url) return false;
  const pluginUrl = chrome.runtime.getURL('popup.html');
  return tab.url === pluginUrl || tab.url.includes('popup.html');
};

/**
 * 打开或跳转到插件管理页面（确保单实例）
 */
const openOrFocusManagementPage = async (): Promise<void> => {
  try {
    const pluginUrl = chrome.runtime.getURL('popup.html');

    // 查找所有插件管理页面
    const tabs = await chrome.tabs.query({});
    const existingTabs = tabs.filter(tab => tab.url === pluginUrl);

    if (existingTabs.length > 0) {
      // 如果有多个管理页面，关闭除第一个外的所有页面
      if (existingTabs.length > 1) {
        const tabsToClose = existingTabs.slice(1).map(tab => tab.id).filter((id): id is number => id !== undefined);
        if (tabsToClose.length > 0) {
          await chrome.tabs.remove(tabsToClose);
          logger.debug('关闭多余的插件管理页面', { count: tabsToClose.length });
        }
      }

      // 切换到第一个管理页面
      const targetTab = existingTabs[0];
      if (targetTab.id) {
        await chrome.tabs.update(targetTab.id, { active: true });
        await chrome.windows.update(targetTab.windowId!, { focused: true });
        logger.debug('切换到已存在的插件管理页面', { tabId: targetTab.id });
      }
    } else {
      // 如果不存在，则创建新的标签页
      await chrome.tabs.create({ url: pluginUrl });
      logger.debug('创建新的插件管理页面');
    }
  } catch (error) {
    logger.error('打开插件管理页面失败', error);
    // 如果出错，尝试简单创建新标签页
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  }
};

/**
 * 检查是否有可收集的标签页
 */
const hasCollectableTabs = (tabs: chrome.tabs.Tab[]): boolean => {
  return tabs.some(tab => {
    // 排除插件管理页面
    if (isPluginManagementPage(tab)) {
      return false;
    }

    // 排除Chrome内部页面，但允许chrome-extension://页面
    if (tab.url) {
      const isInternalPage = tab.url.startsWith('chrome://') ||
        tab.url.startsWith('edge://');
      if (isInternalPage) {
        return false;
      }
      return true;
    }

    // 如果URL为空但标题不为空，则认为是可收集的（可能是正在加载的页面）
    return tab.title && tab.title.trim() !== '';
  });
};

/**
 * 保存标签页的核心函数
 */
const saveTabs = async (tabs: chrome.tabs.Tab[]) => {
  try {
    logger.debug('开始保存标签页', { totalTabs: tabs.length });

    // 过滤掉插件管理页面、Chrome内部页面等
    let validTabs = tabs.filter(tab => {
      // 排除插件管理页面
      if (isPluginManagementPage(tab)) {
        logger.debug('排除插件管理页面', { url: tab.url, title: tab.title });
        return false;
      }

      // 排除Chrome内部页面，但允许chrome-extension://页面
      if (tab.url) {
        const isInternalPage = tab.url.startsWith('chrome://') ||
          tab.url.startsWith('edge://');
        if (isInternalPage) {
          logger.debug('排除内部页面', { url: tab.url, title: tab.title });
          return false;
        }
        return true;
      }

      // 如果URL为空但标题不为空，则保存该标签页（可能是正在加载的页面）
      return tab.title && tab.title.trim() !== '';
    });

    // 处理chrome-extension://页面：如果有多个，只保留一个
    const chromeExtensionTabs = validTabs.filter(tab =>
      tab.url && tab.url.startsWith('chrome-extension://')
    );

    if (chromeExtensionTabs.length > 1) {
      // 保留第一个chrome-extension://标签页，移除其他的
      const firstExtensionTab = chromeExtensionTabs[0];
      validTabs = validTabs.filter(tab =>
        !tab.url?.startsWith('chrome-extension://') || tab.id === firstExtensionTab.id
      );
      logger.debug('处理chrome-extension://页面', {
        total: chromeExtensionTabs.length,
        kept: 1,
        removed: chromeExtensionTabs.length - 1
      });
    }

    logger.debug('过滤后的有效标签页', {
      originalCount: tabs.length,
      filteredCount: validTabs.length,
      validTabs: validTabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title
      }))
    });

    // 获取设置
    const settings = await storage.getSettings();
    logger.debug('当前设置', {
      allowDuplicateTabs: settings.allowDuplicateTabs,
      autoCloseTabsAfterSaving: settings.autoCloseTabsAfterSaving
    });

    // 保存所有要关闭的标签页（包括重复的）
    const allTabsToClose = [...validTabs];

    // 如果不允许重复标签页，则过滤重复的URL
    if (!settings.allowDuplicateTabs) {
      const uniqueUrls = new Set<string>();
      validTabs = validTabs.filter(tab => {
        if (tab.url && !uniqueUrls.has(tab.url)) {
          uniqueUrls.add(tab.url);
          return true;
        }
        return false;
      });

      logger.debug('去重后的标签页', {
        beforeCount: allTabsToClose.length,
        afterCount: validTabs.length,
        duplicatesRemoved: allTabsToClose.length - validTabs.length
      });
    }

    if (validTabs.length === 0) {
      logger.debug('没有有效的标签页需要保存');
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '没有可保存的标签页',
        message: '当前窗口没有可以保存的标签页'
      });
      return;
    }

    // 创建新标签组
    const newGroup = createTabGroup(validTabs);
    logger.debug('创建的新标签组', {
      id: newGroup.id,
      name: newGroup.name,
      tabCount: newGroup.tabs.length
    });

    // 保存到存储
    const existingGroups = await storage.getGroups();
    await storage.setGroups([newGroup, ...existingGroups]);

    // 触发 pull-first 同步
    console.log('🔄 Background: 触发 pull-first 同步');
    try {
      const { pullFirstSyncService } = await import('./services/PullFirstSyncService');

      // 使用performUserActionSync而不是syncUserOperation，避免重复的pull-process-push
      // 因为我们已经在本地保存了数据，只需要推送到云端
      const result = await pullFirstSyncService.performUserActionSync({
        type: 'create',
        groupId: newGroup.id,
        description: '保存新标签组'
      });

      if (result.success) {
        console.log('✅ Pull-first 同步服务启动成功');
      } else {
        console.warn('⚠️ Pull-first 同步失败，但本地数据已保存:', result.error);
      }
    } catch (error) {
      console.error('❌ Pull-first 同步服务启动失败:', error);
      // 显示错误通知而不是静默降级
      await showNotification({
        type: 'basic',
        iconUrl: '/icons/icon128.png',
        title: '同步服务启动失败',
        message: '数据已保存到本地，但云端同步失败。请检查网络连接。'
      });
    }

    logger.info('标签页保存详情', {
      newGroupId: newGroup.id,
      newGroupName: newGroup.name,
      newTabCount: newGroup.tabs.length,
      existingGroupCount: existingGroups.length,
      totalGroupsAfterSave: existingGroups.length + 1
    });

    // 获取要关闭的标签页ID（包括重复的）
    const tabIds = allTabsToClose
      .map(tab => tab.id)
      .filter((id): id is number => id !== undefined);

    // 先打开或跳转到插件管理页面
    await openOrFocusManagementPage();

    // 根据用户设置决定是否关闭已保存的标签页
    if (settings.autoCloseTabsAfterSaving && tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
      logger.debug('已关闭标签页', { count: tabIds.length });
    } else if (!settings.autoCloseTabsAfterSaving) {
      logger.debug('根据用户设置，不自动关闭标签页');
    }

    // 发送消息通知前端刷新标签列表
    setTimeout(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'REFRESH_TAB_LIST' });
        logger.debug('已发送刷新标签列表消息');
      } catch (error) {
        logger.debug('发送刷新消息失败（popup可能还未加载）', { error: (error as Error).message });
      }
    }, 1000);

    // 显示成功通知
    await showNotification({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '标签已保存',
      message: `已成功保存 ${validTabs.length} 个标签页到新标签组`
    });

  } catch (error) {
    logger.error('保存标签失败', error);
    await showNotification({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '保存失败',
      message: '保存标签时发生错误，请重试'
    });
  }
};

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  try {
    logger.debug('插件图标被点击');

    // 获取当前窗口的所有标签页
    const tabs = await chrome.tabs.query({ currentWindow: true });

    // 检查是否有可收集的标签页
    if (hasCollectableTabs(tabs)) {
      // 如果有可收集的标签页，执行收集操作
      logger.debug('检测到可收集的标签页，开始收集');
      await saveTabs(tabs);
    } else {
      // 如果没有可收集的标签页，直接打开管理页面
      logger.debug('没有可收集的标签页，直接打开管理页面');
      await openOrFocusManagementPage();
    }
  } catch (error) {
    logger.error('处理插件图标点击失败', error);
    await showNotification({
      type: 'basic',
      iconUrl: '/icons/icon128.png',
      title: '操作失败',
      message: '处理插件图标点击时发生错误'
    });
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case 'save_all_tabs':
        // 保存当前窗口的所有标签页
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        await saveTabs(allTabs);
        break;

      case 'save_current_tab':
        // 保存当前活动的标签页
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (activeTab) {
          await saveTabs([activeTab]);
        }
        break;
    }
  } catch (error) {
    logger.error('处理快捷键命令失败', error);
  }
});

// 生成唯一设备ID
async function generateDeviceId(): Promise<string> {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `device_${timestamp}_${random}`;
}

// 确保设备ID存在
async function ensureDeviceId(): Promise<string> {
  try {
    const { deviceId, deviceIdBackup } = await chrome.storage.local.get(['deviceId', 'deviceIdBackup']);

    if (deviceId) {
      // 如果主设备ID存在，同时创建备份
      if (!deviceIdBackup) {
        await chrome.storage.local.set({ deviceIdBackup: deviceId });
      }
      logger.debug('使用现有设备ID:', deviceId);
      return deviceId;
    }

    // 如果主设备ID丢失，尝试从备份恢复
    if (deviceIdBackup) {
      await chrome.storage.local.set({ deviceId: deviceIdBackup });
      logger.debug('从备份恢复设备ID:', deviceIdBackup);
      return deviceIdBackup;
    }

    // 生成新的设备ID
    const newDeviceId = await generateDeviceId();
    await chrome.storage.local.set({
      deviceId: newDeviceId,
      deviceIdBackup: newDeviceId,
      deviceIdCreatedAt: new Date().toISOString()
    });
    logger.debug('生成新设备ID:', newDeviceId);
    return newDeviceId;
  } catch (error) {
    logger.error('设备ID管理失败:', error);
    // 返回一个基于浏览器指纹的临时ID
    const fingerprint = await generateBrowserFingerprint();
    return `temp_${fingerprint}_${Date.now()}`;
  }
}

// 生成浏览器指纹作为备用标识
async function generateBrowserFingerprint(): Promise<string> {
  try {
    const userAgent = navigator.userAgent;
    const language = navigator.language;
    const platform = navigator.platform;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const fingerprint = btoa(`${userAgent}-${language}-${platform}-${timezone}`)
      .replace(/[+/=]/g, '')
      .substring(0, 16);

    return fingerprint;
  } catch (error) {
    return Math.random().toString(36).substring(2, 18);
  }
}

// 监听安装事件
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === 'install') {
      logger.debug('插件首次安装，初始化存储');

      // 生成设备ID
      await ensureDeviceId();

      // 初始化存储
      await storage.setGroups([]);
      await storage.setSettings({
        groupNameTemplate: 'Group %d',
        showFavicons: true,
        showTabCount: true,
        confirmBeforeDelete: true,
        allowDuplicateTabs: false,
        autoCloseTabsAfterSaving: true,
        syncEnabled: true,
        autoSyncEnabled: true,
        syncInterval: 5,
        useDoubleColumnLayout: true,
        showNotifications: false,
        showManualSyncButtons: false,
        syncStrategy: 'newest',
        deleteStrategy: 'everywhere',
        themeMode: 'auto',
      });

      logger.debug('插件初始化完成');
    } else if (details.reason === 'update') {
      // 更新时也确保设备ID存在
      await ensureDeviceId();
      logger.debug('插件更新，设备ID检查完成');
    }
  } catch (error) {
    logger.error('插件安装初始化失败', error);
  }
});

// 监听来自前端的消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message.type === 'SAVE_ALL_TABS') {
      logger.debug('收到保存所有标签页消息', {
        tabsCount: message.data?.tabs?.length || 0
      });

      // 使用消息中的标签数据或重新获取当前窗口的所有标签页
      const tabs = message.data?.tabs || [];

      // 异步处理，不阻塞消息响应
      saveTabs(tabs)
        .then(() => {
          logger.debug('标签页保存成功');
        })
        .catch(error => {
          logger.error('保存标签页失败', error);
        });

      // 立即返回响应
      sendResponse({ success: true });
    }
    // 处理打开多个标签页的消息
    else if (message.type === 'OPEN_TABS') {
      logger.debug('收到打开多个标签页消息');

      const urls = message.data?.urls || [];
      if (urls.length > 0) {
        // 打开多个标签页
        urls.forEach((url: string) => {
          chrome.tabs.create({ url });
        });
      }

      sendResponse({ success: true });
    }
    // 处理打开单个标签页的消息
    else if (message.type === 'OPEN_TAB') {
      logger.debug('收到打开单个标签页消息');

      const url = message.data?.url;
      if (url) {
        chrome.tabs.create({ url });
      }

      sendResponse({ success: true });
    }

    // 返回true表示异步响应
    return true;
  } catch (error) {
    logger.error('处理消息失败', error);
    sendResponse({ success: false, error: (error as Error).message });
    return true;
  }
});
