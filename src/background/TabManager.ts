import { storage } from '@/utils/storage';
import { TabGroup, Tab } from '@/types/tab';
import { nanoid } from '@reduxjs/toolkit';

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
    console.log('打开标签管理器页面');

    const existingTabs = await this.getExistingTabManagerTabs();

    if (existingTabs.length > 0) {
      // 如果已经有标签管理页打开，则激活它
      console.log('已有标签管理页打开，激活');
      const tab = existingTabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (shouldRefresh) {
          await chrome.tabs.reload(tab.id);
        }
      }
    } else {
      // 如果没有标签管理页打开，则创建新的
      console.log('没有标签管理页打开，创建新的');
      await chrome.tabs.create({ url: this.getExtensionUrl() });
    }
  }

  /**
   * 过滤有效的标签页
   * 排除Chrome内部页面和扩展页面
   */
  private filterValidTabs(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
    return tabs.filter(tab => {
      // 如果标签页有URL，则检查URL是否为内部页面
      if (tab.url) {
        return !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:');
      }
      // 如果URL为空，但标题不为空，则保存该标签页（可能是正在加载的页面）
      return tab.title && tab.title.trim() !== '';
    });
  }

  /**
   * 创建标签组
   */
  private async createTabGroup(tabs: chrome.tabs.Tab[]): Promise<TabGroup> {
    const validTabs = this.filterValidTabs(tabs);
    const now = new Date().toISOString();

    // 转换为应用内的Tab格式
    const formattedTabs: Tab[] = validTabs.map(tab => ({
      id: nanoid(),
      url: tab.url || 'about:blank',
      title: tab.title || '未命名标签页',
      favicon: tab.favIconUrl,
      createdAt: now,
      lastAccessed: now,
    }));

    // 创建标签组
    const tabGroup: TabGroup = {
      id: nanoid(),
      name: `标签组 ${new Date().toLocaleString()}`,
      tabs: formattedTabs,
      createdAt: now,
      updatedAt: now,
      isLocked: false,
    };

    return tabGroup;
  }

  /**
   * 保存所有标签页
   */
  async saveAllTabs(inputTabs?: chrome.tabs.Tab[]): Promise<void> {
    console.log('开始保存所有标签页');

    try {
      // 获取标签页列表
      const tabs = inputTabs || await chrome.tabs.query({ currentWindow: true });

      // 创建标签组
      const tabGroup = await this.createTabGroup(tabs);

      if (tabGroup.tabs.length === 0) {
        console.log('没有有效的标签页需要保存');
        return;
      }

      // 保存到存储
      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);

      console.log(`成功保存 ${tabGroup.tabs.length} 个标签页到新标签组`);

      // 通知标签管理器页面刷新数据
      this.notifyTabManagerRefresh();

      // 关闭已保存的标签页（排除扩展页面）
      const tabsToClose = this.filterValidTabs(tabs);
      const tabIdsToClose = tabsToClose
        .map(tab => tab.id)
        .filter((id): id is number => id !== undefined);

      if (tabIdsToClose.length > 0) {
        // 创建一个新标签页
        await chrome.tabs.create({ url: 'chrome://newtab' });
        // 关闭已保存的标签页
        await chrome.tabs.remove(tabIdsToClose);
      }

    } catch (error) {
      console.error('保存标签页失败:', error);
      throw error;
    }
  }

  /**
   * 保存当前标签页
   */
  async saveCurrentTab(tab: chrome.tabs.Tab): Promise<void> {
    console.log('保存当前标签页:', tab.url);

    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      console.log('跳过Chrome内部页面或扩展页面');
      return;
    }

    try {
      // 创建包含单个标签的标签组
      const tabGroup = await this.createTabGroup([tab]);

      if (tabGroup.tabs.length === 0) {
        console.log('没有有效的标签页需要保存');
        return;
      }

      // 保存到存储
      const existingGroups = await storage.getGroups();
      await storage.setGroups([tabGroup, ...existingGroups]);

      console.log('当前标签页已保存');

      // 通知标签管理器页面刷新数据
      this.notifyTabManagerRefresh();

      // 关闭当前标签页
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
    console.log('打开标签页:', url);

    try {
      // 检查是否已经有标签管理器页面打开
      const existingTabs = await this.getExistingTabManagerTabs();
      const tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

      // 打开要恢复的标签页，但不激活它
      await chrome.tabs.create({ url, active: false });

      // 如果有标签管理器页面，则激活它
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
  async openTabs(urls: string[]): Promise<void> {
    console.log('打开多个标签页:', urls);

    try {
      // 检查是否已经有标签管理器页面打开
      const existingTabs = await this.getExistingTabManagerTabs();
      const tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

      // 打开所有标签页，但不激活它们
      for (const url of urls) {
        await chrome.tabs.create({ url, active: false });
      }

      // 如果有标签管理器页面，则激活它
      if (tabManagerId) {
        await chrome.tabs.update(tabManagerId, { active: true });
      }

    } catch (error) {
      console.error('打开多个标签页失败:', error);
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
    }).catch(error => {
      // 如果没有接收者，会抛出错误，可以忽略
      console.log('没有找到标签管理器页面，或者发送消息失败', error);
    });
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
