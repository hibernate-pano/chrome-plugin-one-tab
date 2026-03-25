import { storage } from '@/utils/storage';
import { createTabGroupFromChromeTabs, filterValidTabs } from '@/domain/tabGroup';
import { cacheManager } from '@/utils/performance';
import { trackProductEvent } from '@/utils/productEvents';

/**
 * 统一的标签页管理器
 * 负责处理所有与标签页相关的操作，避免代码重复
 */
export class TabManager {
  private static instance: TabManager;

  private constructor() { }

  static getInstance(): TabManager {
    if (!TabManager.instance) {
      TabManager.instance = new TabManager();
    }
    return TabManager.instance;
  }

  /**
   * 获取扩展页面URL
   */
  private getExtensionUrl(): string {
    return chrome.runtime.getURL('src/popup/index.html');
  }

  /**
   * 检查是否已有标签管理页面打开
   */
  private async getExistingTabManagerTabs(): Promise<chrome.tabs.Tab[]> {
    const extensionUrl = this.getExtensionUrl();
    return await chrome.tabs.query({ url: extensionUrl + '*' });
  }

  /**
   * 打开或激活标签管理器页面
   * @param shouldRefresh 是否刷新已存在的页面
   */
  async openTabManager(shouldRefresh: boolean = false): Promise<void> {
    const existingTabs = await this.getExistingTabManagerTabs();

    if (existingTabs.length > 0) {
      const tab = existingTabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (shouldRefresh) {
          await chrome.tabs.reload(tab.id);
        }
      }
    } else {
      await chrome.tabs.create({ url: this.getExtensionUrl() });
    }
  }

  /**
   * 保存所有标签页
   */
  async saveAllTabs(inputTabs?: chrome.tabs.Tab[]): Promise<void> {
    try {
      let tabs = inputTabs ?? [];

      if (!inputTabs) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            tabs = await chrome.tabs.query({ currentWindow: true });
            break;
          } catch (error) {
            console.warn(`查询标签页失败，重试 ${attempt + 1}/3`, error);
            if (attempt === 2) {
              throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }

      const cache = cacheManager.getCache('storage');
      cache.delete('settings');
      const settings = await storage.getSettings();
      const collectPinnedTabs = settings.collectPinnedTabs ?? false;

      const tabGroup = createTabGroupFromChromeTabs(tabs, {
        includePinned: collectPinnedTabs,
      });

      if (tabGroup.tabs.length === 0) {
        await this.showNotification({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'TabVault Pro',
          message: '当前窗口里没有可保存的标签页'
        });
        return;
      }

      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);

      await this.showNotification({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'TabVault Pro',
        message: `已将 ${tabGroup.tabs.length} 个标签页保存为新会话`
      });

      await trackProductEvent('session_saved', {
        sessionId: tabGroup.id,
        sessionName: tabGroup.name,
        tabCount: tabGroup.tabs.length,
        pinnedCount: tabGroup.tabs.filter(tab => tab.pinned).length,
      });

      this.notifyTabManagerRefresh();

      const tabsToClose = filterValidTabs(tabs, {
        includePinned: collectPinnedTabs,
      });
      const tabIdsToClose = tabsToClose
        .map(tab => tab.id)
        .filter((id): id is number => id !== undefined);

      if (tabIdsToClose.length > 0) {
        try {
          await chrome.tabs.create({ url: 'chrome://newtab' });
          await chrome.tabs.remove(tabIdsToClose);
        } catch (error) {
          console.warn('关闭标签页时出错:', error);
        }
      }

    } catch (error) {
      console.error('保存标签页失败:', error);

      // 显示错误通知
      await this.showNotification({
        type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'TabVault Pro - 保存失败',
          message: '保存标签页时发生错误，请重试'
        });

      throw error;
    }
  }

  /**
   * 保存当前标签页
   */
  async saveCurrentTab(tab: chrome.tabs.Tab): Promise<void> {
    console.log('保存当前标签页:', tab.url);

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    try {
      const settings = await storage.getSettings();
      const collectPinnedTabs = settings.collectPinnedTabs ?? false;

      if (!collectPinnedTabs && tab.pinned) {
        return;
      }

      const tabGroup = createTabGroupFromChromeTabs([tab], {
        includePinned: collectPinnedTabs,
      });

      if (tabGroup.tabs.length === 0) {
        return;
      }

      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);

      await trackProductEvent('session_saved', {
        sessionId: tabGroup.id,
        sessionName: tabGroup.name,
        tabCount: tabGroup.tabs.length,
        pinnedCount: tabGroup.tabs.filter(item => item.pinned).length,
      });

      this.notifyTabManagerRefresh();

      if (tab.id) {
        await chrome.tabs.remove(tab.id);
      }

    } catch (error) {
      console.error('保存当前标签页失败:', error);
      throw error;
    }
  }

  /**
   * 打开单个标签页，保留标签管理器页面
   */
  async openTab(url: string): Promise<void> {
    try {
      const existingTabs = await this.getExistingTabManagerTabs();
      const tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

      await chrome.tabs.create({ url, active: false });

      if (tabManagerId) {
        await chrome.tabs.update(tabManagerId, { active: true });
      }

    } catch (error) {
      console.error('打开标签页失败:', error);
      throw error;
    }
  }

  /**
   * 打开多个标签页，保留标签管理器页面
   */
  async openTabsInNewWindow(tabs: Array<{ url: string; pinned?: boolean }>): Promise<void> {
    try {
      if (tabs.length === 0) {
        return;
      }

      const [firstTab, ...remainingTabs] = tabs;
      const createdWindow = await chrome.windows.create({ url: firstTab.url, focused: true });
      const targetWindowId = createdWindow.id;
      const createdFirstTabId = createdWindow.tabs?.[0]?.id;

      if (!targetWindowId) {
        throw new Error('无法创建会话恢复窗口');
      }

      if (firstTab.pinned && createdFirstTabId) {
        await chrome.tabs.update(createdFirstTabId, { pinned: true });
      }

      await Promise.all(
        remainingTabs.map(tab =>
          chrome.tabs.create({
            windowId: targetWindowId,
            url: tab.url,
            active: false,
            pinned: tab.pinned,
          })
        )
      );

    } catch (error) {
      console.error('在新窗口恢复会话失败:', error);
      throw error;
    }
  }

  /**
   * 通知标签管理器页面刷新数据
   */
  private notifyTabManagerRefresh(): void {
    chrome.runtime.sendMessage({
      type: 'REFRESH_TAB_LIST',
      data: { timestamp: Date.now() }
    }).catch(() => {});
  }

  /**
   * 显示通知
   */
  async showNotification(options: {
    type: 'basic';
    iconUrl: string;
    title: string;
    message: string;
  }): Promise<void> {
    try {
      await chrome.notifications.create({
        type: options.type,
        iconUrl: options.iconUrl,
        title: options.title,
        message: options.message
      });
    } catch (error) {
      console.error('显示通知失败:', error);
    }
  }
}

// 导出单例实例
export const tabManager = TabManager.getInstance();
