import { store } from '@/app/store';
import { pullFirstSyncService } from '@/services/PullFirstSyncService';
import { distributedLockManager, LockType } from '@/services/DistributedLockManager';

export interface AutoSyncOptions {
  enabled: boolean;
  interval: number; // 秒
  onUserActions: boolean; // 是否在用户操作后自动同步
  onLogin: boolean; // 是否在登录后自动同步
}

class AutoSyncManager {
  private intervalId: NodeJS.Timeout | null = null;
  private lastSyncTime = 0;
  private readonly MIN_SYNC_INTERVAL = 10000; // 最小同步间隔10秒
  private readonly DEFAULT_SYNC_INTERVAL = 10000; // 默认10秒间隔

  /**
   * 初始化自动同步管理器
   */
  async initialize() {
    console.log('🔄 初始化定时同步管理器');

    // 监听设置变化
    this.watchSettingsChanges();

    // 监听用户登录状态
    this.watchAuthState();

    // 启动定时同步
    await this.startPeriodicSync();
  }

  /**
   * 监听设置变化
   */
  private watchSettingsChanges() {
    let previousSettings = store.getState().settings;

    store.subscribe(() => {
      const currentSettings = store.getState().settings;

      // 检查同步设置变化
      if (
        previousSettings.autoSyncEnabled !== currentSettings.autoSyncEnabled ||
        previousSettings.syncEnabled !== currentSettings.syncEnabled ||
        previousSettings.syncInterval !== currentSettings.syncInterval
      ) {
        console.log('🔄 同步设置发生变化，重新配置定时同步');
        this.updateSyncInterval();
      }

      previousSettings = currentSettings;
    });
  }

  /**
   * 监听认证状态变化
   */
  private watchAuthState() {
    let previousAuthState = store.getState().auth.status === 'authenticated';

    store.subscribe(() => {
      const currentAuthState = store.getState().auth.status === 'authenticated';
      const { autoSyncEnabled, syncEnabled } = store.getState().settings;

      // 用户刚登录且启用自动同步
      if (!previousAuthState && currentAuthState && autoSyncEnabled && syncEnabled) {
        console.log('🔄 用户登录，触发自动下载同步');
        setTimeout(() => {
          this.performAutoDownload();
        }, 1000);
      }

      // 用户登出时停止定时同步
      if (previousAuthState && !currentAuthState) {
        console.log('🔄 用户登出，停止定时同步');
        this.stopPeriodicSync();
      }

      // 用户登录时启动定时同步
      if (!previousAuthState && currentAuthState) {
        console.log('🔄 用户登录，启动定时同步');
        this.startPeriodicSync();
      }

      previousAuthState = currentAuthState;
    });
  }

  /**
   * 启动定时同步
   */
  private async startPeriodicSync() {
    const state = store.getState();
    const { autoSyncEnabled, syncEnabled } = state.settings;
    const isAuthenticated = state.auth.status === 'authenticated';

    if (!isAuthenticated || !syncEnabled || !autoSyncEnabled) {
      console.log('🔄 定时同步条件不满足，跳过启动');
      return;
    }

    // 停止现有的定时器
    this.stopPeriodicSync();

    // 使用10秒间隔
    const intervalMs = this.DEFAULT_SYNC_INTERVAL;
    console.log(`🔄 启动定时同步，间隔: ${intervalMs / 1000} 秒`);

    this.intervalId = setInterval(() => {
      this.performPeriodicSync();
    }, intervalMs);
  }

  /**
   * 停止定时同步
   */
  private stopPeriodicSync() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('🔄 停止定时同步');
    }
  }

  /**
   * 更新同步间隔
   */
  private updateSyncInterval() {
    const state = store.getState();
    const { autoSyncEnabled, syncEnabled } = state.settings;
    const isAuthenticated = state.auth.status === 'authenticated';

    if (isAuthenticated && syncEnabled && autoSyncEnabled) {
      this.startPeriodicSync();
    } else {
      this.stopPeriodicSync();
    }
  }

  /**
   * 执行定期同步 - 使用分布式锁确保原子性
   */
  private async performPeriodicSync() {
    // 检查是否有活跃的高优先级锁
    const currentLock = distributedLockManager.getLockStatus();
    if (currentLock &&
      (currentLock.type === LockType.USER_OPERATION ||
        currentLock.type === LockType.MANUAL_SYNC)) {
      console.log('🔄 检测到高优先级操作正在进行，跳过本次定期同步', {
        lockType: currentLock.type,
        operationId: currentLock.operationId
      });
      return;
    }

    const currentTime = Date.now();
    if (currentTime - this.lastSyncTime < this.MIN_SYNC_INTERVAL) {
      console.log('🔄 距离上次同步时间过短，跳过本次定期同步');
      return;
    }

    // 尝试获取锁，但不重试（低优先级）
    const operationId = `periodic_sync_${Date.now()}`;
    const lockResult = await distributedLockManager.acquireLock(
      LockType.PERIODIC_SYNC,
      operationId,
      '定期同步',
      10000 // 10秒超时
    );

    if (!lockResult.success) {
      console.log('🔄 无法获取同步锁，跳过本次定期同步:', lockResult.error);
      return;
    }

    try {
      this.lastSyncTime = currentTime;
      console.log('🔄 开始定期同步 (pull-first)', { operationId });

      // 使用新的 pull-first 定时同步
      const result = await pullFirstSyncService.performPeriodicSync();

      if (result.success) {
        console.log('✅ 定期同步完成', { operationId });
      } else {
        console.error('❌ 定期同步失败:', result.error, { operationId });
      }

    } catch (error) {
      console.error('❌ 定期同步异常:', error, { operationId });
    } finally {
      // 释放锁
      distributedLockManager.releaseLock(lockResult.lockId!);
    }
  }

  /**
   * 执行自动下载（用户登录后）
   */
  private async performAutoDownload() {
    try {
      console.log('🔄 开始自动下载同步');
      const result = await pullFirstSyncService.performPeriodicSync();

      if (result.success) {
        console.log('✅ 自动下载同步完成');
      } else {
        console.error('❌ 自动下载同步失败:', result.error);
      }
    } catch (error) {
      console.error('❌ 自动下载同步异常:', error);
    }
  }

  /**
   * 手动触发同步（用户操作后）- 使用分布式锁确保原子性
   */
  async triggerUserActionSync() {
    // 直接调用手动同步，锁机制已在PullFirstSyncService中处理
    try {
      console.log('🔄 开始用户操作同步 (pull-first)');

      // 使用新的手动同步
      const result = await pullFirstSyncService.performManualSync();

      if (result.success) {
        console.log('✅ 用户操作同步完成');
      } else {
        console.error('❌ 用户操作同步失败:', result.error);
      }

    } catch (error) {
      console.error('❌ 用户操作同步异常:', error);
    }
  }

  /**
   * 停止所有同步活动
   */
  async shutdown() {
    console.log('🔌 停止自动同步管理器');
    this.stopPeriodicSync();
  }

  /**
   * 获取同步状态
   */
  getStatus() {
    const lockStatus = distributedLockManager.getLockStatus();
    return {
      isRunning: this.intervalId !== null,
      isPending: lockStatus !== null,
      currentLock: lockStatus,
      lastSyncTime: this.lastSyncTime,
      interval: this.DEFAULT_SYNC_INTERVAL
    };
  }
}

/**
 * 全局自动同步管理器实例
 */
export const autoSyncManager = new AutoSyncManager();

/**
 * 便捷函数：初始化自动同步
 */
export async function initializeAutoSync(): Promise<void> {
  await autoSyncManager.initialize();
}

/**
 * 便捷函数：触发用户操作同步
 */
export async function triggerUserActionSync(): Promise<void> {
  await autoSyncManager.triggerUserActionSync();
}
