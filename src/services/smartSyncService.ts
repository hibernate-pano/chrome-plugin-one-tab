import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { sync as supabaseSync } from '@/utils/supabase';
import { storage } from '@/utils/storage';
import { errorHandler } from '@/utils/errorHandler';

// 同步选项接口
export interface SmartSyncOptions {
  autoSync: boolean;           // 是否启用自动同步
  syncInterval: number;        // 同步间隔（毫秒）
  syncOnStartup: boolean;      // 启动时同步
  syncOnChange: boolean;       // 数据变化时同步
  conflictStrategy: 'newest' | 'local' | 'remote' | 'ask';
}

// 同步任务接口
interface SyncTask {
  id: string;
  type: 'upload' | 'download' | 'full';
  priority: number;
  retryCount: number;
  maxRetries: number;
  data?: any;
}

// 增量同步数据结构（预留用于未来增量同步功能）
// interface IncrementalSyncData {
//   lastSyncTimestamp: string;
//   modifiedGroups: string[];    // 只同步修改过的标签组
//   deletedGroups: string[];     // 需要删除的标签组
// }

// 同步队列类
class SyncQueue {
  private queue: SyncTask[] = [];
  private processing = false;
  private processingTask: SyncTask | null = null;
  
  async addTask(task: SyncTask) {
    // 检查是否已有相同类型的任务在队列中
    const existingTaskIndex = this.queue.findIndex(t => t.type === task.type);
    if (existingTaskIndex !== -1) {
      // 更新现有任务而不是添加新任务
      this.queue[existingTaskIndex] = task;
    } else {
      this.queue.push(task);
    }
    
    // 按优先级排序
    this.queue.sort((a, b) => b.priority - a.priority);
    
    if (!this.processing) {
      await this.processQueue();
    }
  }
  
  private async processQueue() {
    if (this.queue.length === 0 || this.processing) {
      return;
    }
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.processingTask = task;
      
      try {
        await this.executeTask(task);
      } catch (error) {
        // 使用 errorHandler 统一处理错误
        errorHandler.handle(error as Error, {
          showToast: false,
          logToConsole: true,
          severity: 'medium',
          fallbackMessage: `同步任务失败 (${task.type})`
        });
        
        // 重试逻辑
        if (task.retryCount < task.maxRetries) {
          task.retryCount++;
          // 指数退避重试
          const delay = Math.min(1000 * Math.pow(2, task.retryCount), 30000);
          setTimeout(() => {
            this.queue.unshift(task);
            this.processQueue();
          }, delay);
        }
      }
    }
    
    this.processing = false;
    this.processingTask = null;
  }
  
  private async executeTask(task: SyncTask) {
    const syncService = SmartSyncService.getInstance();
    
    switch (task.type) {
      case 'upload':
        await syncService.uploadToCloud(true, false);
        break;
      case 'download':
        await syncService.downloadFromCloud(true, false);
        break;
      case 'full':
        await syncService.syncAll(true);
        break;
    }
  }
  
  getCurrentTask(): SyncTask | null {
    return this.processingTask;
  }
  
  getPendingTasks(): SyncTask[] {
    return [...this.queue];
  }
  
  clearQueue() {
    this.queue = [];
  }
}

class SmartSyncService {
  private static instance: SmartSyncService;
  private syncQueue: SyncQueue;
  private syncTimer: NodeJS.Timeout | null = null;
  private changeDebounceTimer: NodeJS.Timeout | null = null;
  private options: SmartSyncOptions = {
    autoSync: true,
    syncInterval: 1 * 60 * 1000, // 默认1分钟（测试用）
    syncOnStartup: true,
    syncOnChange: true,
    conflictStrategy: 'newest'
  };
  private lastSyncTime: string | null = null;
  private isInitialized = false;
  private isSyncing = false; // 同步锁：防止云端下载触发不必要的上传
  
  private constructor() {
    this.syncQueue = new SyncQueue();
  }
  
  static getInstance(): SmartSyncService {
    if (!SmartSyncService.instance) {
      SmartSyncService.instance = new SmartSyncService();
    }
    return SmartSyncService.instance;
  }
  
  // 初始化同步服务
  async initialize(options?: Partial<SmartSyncOptions>) {
    if (this.isInitialized) {
      console.log('智能同步服务已经初始化');
      return;
    }
    
    // 合并选项
    if (options) {
      this.options = { ...this.options, ...options };
    }
    
    // 从存储中加载用户的同步设置
    const settings = await storage.getSettings();
    if (settings.syncEnabled !== undefined) {
      this.options.autoSync = settings.syncEnabled;
    }
    
    console.log('智能同步服务初始化，配置:', this.options);
    
    // 获取最后同步时间
    this.lastSyncTime = await storage.getLastSyncTime();
    
    // 设置自动同步
    if (this.options.autoSync) {
      this.startAutoSync();
    }
    
    // 启动时同步
    if (this.options.syncOnStartup && this.options.autoSync) {
      const { auth } = store.getState();
      if (auth.isAuthenticated) {
        console.log('启动时执行同步...');
        this.syncQueue.addTask({
          id: `startup-sync-${Date.now()}`,
          type: 'full',
          priority: 5,
          retryCount: 0,
          maxRetries: 3
        });
      }
    }
    
    // 监听存储变化
    if (this.options.syncOnChange) {
      this.setupChangeListener();
    }
    
    this.isInitialized = true;
  }
  
  // 设置自动同步
  private startAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    
    this.syncTimer = setInterval(() => {
      const { auth } = store.getState();
      if (auth.isAuthenticated && this.options.autoSync) {
        console.log('定时自动同步触发...');
        this.syncQueue.addTask({
          id: `auto-sync-${Date.now()}`,
          type: 'full',
          priority: 3,
          retryCount: 0,
          maxRetries: 2
        });
      }
    }, this.options.syncInterval);
    
    console.log(`自动同步已启动，间隔: ${this.options.syncInterval / 1000 / 60} 分钟`);
  }
  
  // 监听数据变化
  private setupChangeListener() {
    // 监听存储变化事件
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.tab_groups) {
        this.handleDataChange();
      }
    });
  }
  
  // 处理数据变化（带防抖）
  private handleDataChange() {
    // 如果正在同步，跳过（防止云端下载触发上传）
    if (this.isSyncing) {
      console.log('[SmartSync] 正在同步中，跳过本次变化监听');
      return;
    }
    
    if (!this.options.syncOnChange || !this.options.autoSync) {
      return;
    }
    
    // 清除之前的定时器
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
    }
    
    // 设置新的定时器（防抖5秒）
    this.changeDebounceTimer = setTimeout(() => {
      const { auth } = store.getState();
      if (auth.isAuthenticated) {
        console.log('[SmartSync] 检测到数据变化，触发同步...');
        this.syncQueue.addTask({
          id: `change-sync-${Date.now()}`,
          type: 'upload',
          priority: 4,
          retryCount: 0,
          maxRetries: 2
        });
      }
    }, 5000);
  }
  
  // 更新同步选项
  updateOptions(options: Partial<SmartSyncOptions>) {
    this.options = { ...this.options, ...options };
    
    // 重新设置自动同步
    if (options.autoSync !== undefined || options.syncInterval !== undefined) {
      if (this.options.autoSync) {
        this.startAutoSync();
      } else {
        this.stopAutoSync();
      }
    }
  }
  
  // 停止自动同步
  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('自动同步已停止');
    }
  }
  
  // 手动触发同步
  async manualSync() {
    const { auth } = store.getState();
    if (!auth.isAuthenticated) {
      return { success: false, error: '用户未登录' };
    }
    
    console.log('手动触发同步...');
    this.syncQueue.addTask({
      id: `manual-sync-${Date.now()}`,
      type: 'full',
      priority: 10, // 最高优先级
      retryCount: 0,
      maxRetries: 3
    });
    
    return { success: true };
  }
  
  // 检查云端是否有数据
  async hasCloudData() {
    try {
      const cloudGroups = await supabaseSync.downloadTabGroups();
      return cloudGroups.length > 0;
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'low',
        fallbackMessage: '检查云端数据失败'
      });
      return false;
    }
  }
  
  // 检查本地是否有数据
  async hasLocalData() {
    try {
      const localGroups = await storage.getGroups();
      return localGroups.length > 0;
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'low',
        fallbackMessage: '检查本地数据失败'
      });
      return false;
    }
  }
  
  // 上传数据到云端
  async uploadToCloud(background = false, overwriteCloud = false) {
    const { auth } = store.getState();
    
    if (!auth.isAuthenticated) {
      console.warn('[SmartSync] 用户未登录，无法上传数据到云端');
      return { success: false, error: '用户未登录' };
    }
    
    // 设置同步锁
    this.isSyncing = true;
    console.log('[SmartSync] 开始上传到云端（同步锁已设置）');
    
    try {
      // 上传数据到云端
      await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));
      await store.dispatch(syncSettingsToCloud());
      
      // 更新最后同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
      
      console.log('[SmartSync] 上传完成');
      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据上传失败'
      });
      
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        errorHandler.handle(e as Error, {
          showToast: false,
          logToConsole: true,
          severity: 'low',
          fallbackMessage: '重新获取用户信息失败'
        });
      }
      return { success: false, error: error instanceof Error ? error.message : '上传失败' };
    } finally {
      // 延迟释放同步锁（确保 storage 事件已处理完成）
      setTimeout(() => {
        this.isSyncing = false;
        console.log('[SmartSync] 上传操作完成，同步锁已释放');
      }, 1000);
    }
  }
  
  // 从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    const { auth } = store.getState();
    
    if (!auth.isAuthenticated) {
      console.warn('[SmartSync] 用户未登录，无法从云端下载数据');
      return { success: false, error: '用户未登录' };
    }
    
    // 设置同步锁
    this.isSyncing = true;
    console.log('[SmartSync] 开始从云端下载（同步锁已设置）');
    
    try {
      // 从云端下载数据
      await store.dispatch(syncSettingsFromCloud());
      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: overwriteLocal }));
      
      // 更新最后同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
      
      console.log('[SmartSync] 下载完成');
      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '从云端下载数据失败'
      });
      
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        errorHandler.handle(e as Error, {
          showToast: false,
          logToConsole: true,
          severity: 'low',
          fallbackMessage: '重新获取用户信息失败'
        });
      }
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    } finally {
      // 延迟释放同步锁（确保 storage 事件已处理完成）
      setTimeout(() => {
        this.isSyncing = false;
        console.log('[SmartSync] 下载操作完成，同步锁已释放');
      }, 1000);
    }
  }
  
  // 同步所有数据（智能合并）
  async syncAll(background = true) {
    const { auth } = store.getState();
    
    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return { success: false, error: '用户未登录' };
    }
    
    try {
      // 根据冲突策略决定同步顺序
      const { settings } = store.getState() as any;
      const strategy = settings.syncStrategy || this.options.conflictStrategy;
      
      console.log(`使用同步策略: ${strategy}`);
      
      switch (strategy) {
        case 'local':
          // 本地优先：先上传，后下载（但不覆盖本地）
          await this.uploadToCloud(background, false);
          await this.downloadFromCloud(background, false);
          break;
          
        case 'remote':
          // 远程优先：先下载（覆盖本地），后上传
          await this.downloadFromCloud(background, true);
          await this.uploadToCloud(background, false);
          break;
          
        case 'newest':
        default:
          // 最新优先：智能合并
          await this.uploadToCloud(background, false);
          await this.downloadFromCloud(background, false);
          break;
      }
      
      // 更新最后同步时间
      const syncTime = new Date().toISOString();
      await storage.setLastSyncTime(syncTime);
      this.lastSyncTime = syncTime;
      
      return { success: true };
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '数据同步失败'
      });
      return { success: false, error: error instanceof Error ? error.message : '同步失败' };
    }
  }
  
  // 获取同步状态
  getSyncStatus() {
    return {
      isAutoSyncEnabled: this.options.autoSync,
      syncInterval: this.options.syncInterval,
      lastSyncTime: this.lastSyncTime,
      pendingTasks: this.syncQueue.getPendingTasks(),
      currentTask: this.syncQueue.getCurrentTask()
    };
  }
  
  // 清理资源
  cleanup() {
    this.stopAutoSync();
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
    }
    this.syncQueue.clearQueue();
    this.isInitialized = false;
  }
}

// 导出单例实例
export const smartSyncService = SmartSyncService.getInstance();
