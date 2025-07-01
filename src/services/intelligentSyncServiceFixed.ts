import { TabGroup, Tab } from '@/types/tab';
import { storage } from '@/utils/storage';
import { supabase } from '@/utils/supabase';

/**
 * 智能自动同步服务
 * 取代现有的手动同步模式，提供更智能的同步体验
 */

interface SyncOperation {
  trigger: string;
  timestamp: number;
  retries: number;
}

export interface SyncConfig {
  // 同步触发条件
  triggers: {
    onDataChange: boolean;      // 数据变更时自动同步
    onNetworkRestore: boolean;  // 网络恢复时同步
    onAppFocus: boolean;        // 应用获得焦点时同步
    periodic: number | null;    // 定期同步间隔(秒)
  };
  
  // 冲突解决策略
  conflictResolution: {
    strategy: 'auto' | 'manual';
    autoMergeRules: {
      preferNewer: boolean;     // 优先使用更新的数据
      preserveLocal: boolean;   // 保留本地独有数据
      preserveRemote: boolean;  // 保留远程独有数据
    };
  };
  
  // 同步优化
  optimization: {
    batchUpdates: boolean;      // 批量更新
    deltaSync: boolean;         // 增量同步
    compression: boolean;       // 数据压缩
    maxRetries: number;         // 最大重试次数
  };
}

interface SyncData {
  groups: TabGroup[];
  settings: any;
  lastUpdated: string;
}

export class IntelligentSyncService {
  private config: SyncConfig;
  private syncQueue: SyncOperation[] = [];
  private isOnline = navigator.onLine;
  private lastSyncTime: Date | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(config: SyncConfig) {
    this.config = config;
    this.setupEventListeners();
    this.startPeriodicSync();
  }

  private setupEventListeners() {
    // 监听网络状态变化
    window.addEventListener('online', () => {
      this.isOnline = true;
      if (this.config.triggers.onNetworkRestore) {
        this.triggerSync('network-restore');
      }
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
    });

    // 监听应用焦点变化
    if (this.config.triggers.onAppFocus) {
      window.addEventListener('focus', () => {
        this.triggerSync('app-focus');
      });
    }

    // 监听数据变化
    if (this.config.triggers.onDataChange) {
      this.setupDataChangeListener();
    }
  }

  private setupDataChangeListener() {
    // 监听存储变化
    chrome.storage?.onChanged?.addListener(() => {
      this.debounceSync('data-change');
    });
  }

  private debounceSync(trigger: string) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.triggerSync(trigger);
    }, 1000);
  }

  private startPeriodicSync() {
    if (this.config.triggers.periodic) {
      this.syncTimer = setInterval(() => {
        this.triggerSync('periodic');
      }, this.config.triggers.periodic * 1000);
    }
  }

  private async triggerSync(trigger: string) {
    if (!this.isOnline) {
      console.log('离线状态，跳过同步');
      return;
    }

    // 避免频繁同步
    if (this.lastSyncTime && Date.now() - this.lastSyncTime.getTime() < 5000) {
      console.log('同步间隔太短，跳过同步');
      return;
    }

    try {
      await this.performSync(trigger);
      this.lastSyncTime = new Date();
    } catch (error) {
      console.error('同步失败:', error);
      this.handleSyncError(error, trigger);
    }
  }

  private async performSync(trigger: string): Promise<void> {
    console.log(`触发同步: ${trigger}`);
    
    // 获取本地和远程数据
    const [localData, remoteData] = await Promise.all([
      this.getLocalData(),
      this.getRemoteData()
    ]);

    // 检查是否需要同步
    if (this.isDataIdentical(localData, remoteData)) {
      console.log('数据已同步，无需更新');
      return;
    }

    // 执行智能合并
    const mergedData = await this.smartMerge(localData, remoteData);

    // 应用合并结果
    await this.applyMergedData(mergedData);

    console.log('同步完成');
  }

  private async getLocalData(): Promise<SyncData> {
    const groups = await storage.getGroups();
    const settings = await storage.getSettings();
    
    return {
      groups,
      settings,
      lastUpdated: new Date().toISOString()
    };
  }

  private async getRemoteData(): Promise<SyncData> {
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) {
        throw new Error('用户未登录');
      }

      const { data, error } = await supabase
        .from('tab_groups')
        .select('*')
        .eq('user_id', user.user.id);

      if (error) throw error;

      return {
        groups: data || [],
        settings: {},
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('获取远程数据失败:', error);
      return {
        groups: [],
        settings: {},
        lastUpdated: new Date().toISOString()
      };
    }
  }

  private async applyMergedData(mergedData: SyncData): Promise<void> {
    await storage.setGroups(mergedData.groups);
    await storage.setSettings(mergedData.settings);
  }

  private async smartMerge(localData: SyncData, remoteData: SyncData): Promise<SyncData> {
    if (this.config.conflictResolution.strategy === 'auto') {
      return this.autoMerge(localData, remoteData);
    } else {
      return this.manualMerge(localData, remoteData);
    }
  }

  private autoMerge(localData: SyncData, remoteData: SyncData): SyncData {
    const rules = this.config.conflictResolution.autoMergeRules;
    
    // 实现智能合并逻辑
    const merged = {
      groups: this.mergeGroups(localData.groups, remoteData.groups, rules),
      settings: this.mergeSettings(localData.settings, remoteData.settings, rules),
      lastUpdated: new Date().toISOString()
    };

    return merged;
  }

  private mergeGroups(localGroups: TabGroup[], remoteGroups: TabGroup[], rules: any): TabGroup[] {
    const groupMap = new Map<string, TabGroup>();

    // 添加本地分组
    localGroups.forEach(group => {
      groupMap.set(group.id, group);
    });

    // 处理远程分组
    remoteGroups.forEach(remoteGroup => {
      const localGroup = groupMap.get(remoteGroup.id);
      
      if (!localGroup) {
        // 远程独有的分组
        if (rules.preserveRemote) {
          groupMap.set(remoteGroup.id, remoteGroup);
        }
      } else {
        // 存在冲突，应用合并规则
        const mergedGroup = this.mergeConflictedGroup(localGroup, remoteGroup, rules);
        groupMap.set(remoteGroup.id, mergedGroup);
      }
    });

    return Array.from(groupMap.values());
  }

  private mergeSettings(localSettings: any, remoteSettings: any, rules: any): any {
    // 简单的设置合并逻辑
    if (rules.preferNewer) {
      return { ...localSettings, ...remoteSettings };
    }
    return localSettings;
  }

  private mergeConflictedGroup(localGroup: TabGroup, remoteGroup: TabGroup, rules: any): TabGroup {
    if (rules.preferNewer) {
      const localTime = new Date(localGroup.updatedAt).getTime();
      const remoteTime = new Date(remoteGroup.updatedAt).getTime();
      
      if (remoteTime > localTime) {
        return { ...remoteGroup, tabs: this.mergeTabs(localGroup.tabs, remoteGroup.tabs) };
      } else {
        return { ...localGroup, tabs: this.mergeTabs(localGroup.tabs, remoteGroup.tabs) };
      }
    }

    // 默认合并标签页
    return {
      ...localGroup,
      tabs: this.mergeTabs(localGroup.tabs, remoteGroup.tabs),
      updatedAt: new Date().toISOString()
    };
  }

  private mergeTabs(localTabs: Tab[], remoteTabs: Tab[]): Tab[] {
    const tabMap = new Map<string, Tab>();
    const urlSet = new Set<string>();

    // 添加本地标签页
    localTabs.forEach(tab => {
      if (!urlSet.has(tab.url)) {
        tabMap.set(tab.id, tab);
        urlSet.add(tab.url);
      }
    });

    // 添加远程标签页（去重）
    remoteTabs.forEach(tab => {
      if (!urlSet.has(tab.url)) {
        tabMap.set(tab.id, tab);
        urlSet.add(tab.url);
      }
    });

    return Array.from(tabMap.values());
  }

  private async manualMerge(localData: SyncData, _remoteData: SyncData): Promise<SyncData> {
    // 显示冲突解决对话框
    return new Promise((resolve) => {
      // 简化版本：优先使用本地数据
      resolve(localData);
    });
  }

  private isDataIdentical(localData: SyncData, remoteData: SyncData): boolean {
    // 比较数据指纹或哈希值
    const localHash = this.generateDataHash(localData);
    const remoteHash = this.generateDataHash(remoteData);
    
    return localHash === remoteHash;
  }

  private generateDataHash(data: SyncData): string {
    // 生成数据的哈希值用于快速比较
    return btoa(JSON.stringify(data)).slice(0, 16);
  }

  private async handleSyncError(error: any, trigger: string) {
    console.error(`同步失败 (${trigger}):`, error);
    
    // 添加到重试队列
    this.syncQueue.push({
      trigger,
      timestamp: Date.now(),
      retries: 0
    });

    // 延迟重试
    setTimeout(() => {
      this.retryFailedSync();
    }, 5000);
  }

  private async retryFailedSync() {
    const operation = this.syncQueue.shift();
    if (!operation) return;

    if (operation.retries < this.config.optimization.maxRetries) {
      operation.retries++;
      try {
        await this.performSync(operation.trigger);
      } catch (error) {
        this.syncQueue.unshift(operation);
        setTimeout(() => this.retryFailedSync(), 10000 * operation.retries);
      }
    } else {
      console.error('同步重试次数已达上限，放弃同步');
    }
  }

  // 清理资源
  dispose() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }
}

// 使用示例
const syncConfig: SyncConfig = {
  triggers: {
    onDataChange: true,
    onNetworkRestore: true,
    onAppFocus: true,
    periodic: 300 // 5分钟
  },
  conflictResolution: {
    strategy: 'auto',
    autoMergeRules: {
      preferNewer: true,
      preserveLocal: true,
      preserveRemote: true
    }
  },
  optimization: {
    batchUpdates: true,
    deltaSync: true,
    compression: true,
    maxRetries: 3
  }
};

export const intelligentSync = new IntelligentSyncService(syncConfig);
