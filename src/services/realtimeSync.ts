import { supabase } from '@/utils/supabase';
import { store } from '@/app/store';
import { storage } from '@/shared/utils/storage';
import { RealtimeChannel } from '@supabase/supabase-js';
import { selectIsAuthenticated, selectAuthUser } from '@/features/auth/store/authSlice';
import { deviceFilter, shouldProcessRealtimeEvent, type RealtimePayload } from '@/shared/utils/deviceFilter';
import { createRealtimeSyncDebouncer, type SmartDebouncer } from '@/shared/utils/smartDebouncer';
import {
  smartSyncJudge,
  shouldPerformRealtimeSync,
  type ChangeInfo,
  type SystemState,
  ChangeType
} from '@/shared/utils/smartSyncJudge';
import {
  networkManager,
  isNetworkOnline,
  getNetworkQuality,
  addNetworkListener,
  removeNetworkListener,
  type NetworkInfo,
  NetworkStatus,
  NetworkQuality
} from '@/shared/utils/networkManager';

class RealtimeSync {
  private channel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;
  private isEnabled = false;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private debouncer: SmartDebouncer;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5秒
  private readonly HEARTBEAT_INTERVAL = 30000; // 30秒心跳检测

  constructor() {
    // 初始化智能防抖器
    this.debouncer = createRealtimeSyncDebouncer();

    // 添加网络状态监听
    this.setupNetworkListener();
  }

  /**
   * 初始化实时同步
   */
  async initialize() {
    const state = store.getState();
    const user = selectAuthUser(state);

    if (!selectIsAuthenticated(state) || !user) {
      console.log('🔄 用户未登录，跳过实时同步初始化');
      this.connectionStatus = 'disconnected';
      return;
    }

    this.currentUserId = user.id;
    this.isEnabled = state.settings.syncEnabled && state.settings.autoSyncEnabled;

    if (!this.isEnabled) {
      console.log('🔄 实时同步已禁用');
      this.connectionStatus = 'disconnected';
      return;
    }

    // 清理之前的连接
    await this.cleanup();

    // 重置重连计数
    this.reconnectAttempts = 0;

    await this.setupRealtimeSubscription();
  }

  /**
   * 清理连接和定时器
   */
  private async cleanup() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.channel) {
      console.log('🔄 清理现有实时连接');
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  /**
   * 设置实时订阅
   */
  private async setupRealtimeSubscription() {
    if (!this.currentUserId) return;

    console.log('🔄 设置实时同步订阅，用户ID:', this.currentUserId);
    this.connectionStatus = 'connecting';

    // 创建频道监听 tab_groups 表变化
    this.channel = supabase
      .channel('tab_groups_changes')
      .on(
        'postgres_changes',
        {
          event: '*', // 监听所有事件：INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'tab_groups',
          filter: `user_id=eq.${this.currentUserId}` // 只监听当前用户的数据
        },
        (payload) => {
          console.log('🔄 收到实时数据变化:', payload);
          this.handleRealtimeChange(payload);
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_settings',
          filter: `user_id=eq.${this.currentUserId}` // 监听用户设置变化
        },
        (payload) => {
          console.log('🔄 收到用户设置变化:', payload);
          this.handleSettingsChange(payload);
        }
      )
      .subscribe((status) => {
        console.log('🔄 实时订阅状态:', status);
        this.handleConnectionStatus(status);
      });
  }

  /**
   * 处理连接状态变化
   */
  private handleConnectionStatus(status: string) {
    switch (status) {
      case 'SUBSCRIBED':
        console.log('✅ 实时同步已启用');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        break;

      case 'CHANNEL_ERROR':
        console.error('❌ 实时同步连接失败');
        this.connectionStatus = 'error';
        this.scheduleReconnect();
        break;

      case 'CLOSED':
        console.log('🔄 实时同步连接已关闭');
        this.connectionStatus = 'disconnected';
        if (this.isEnabled) {
          this.scheduleReconnect();
        }
        break;

      default:
        console.log('🔄 实时同步状态:', status);
    }
  }

  /**
   * 启动心跳检测
   */
  private startHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      this.checkConnection();
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * 检查连接状态
   */
  private async checkConnection() {
    if (!this.isEnabled || !this.channel) {
      return;
    }

    try {
      // 通过发送一个简单的查询来检查连接
      const state = store.getState();
      if (selectIsAuthenticated(state)) {
        // 连接正常，继续心跳
        this.startHeartbeat();
      } else {
        // 用户已登出，停止心跳
        this.connectionStatus = 'disconnected';
      }
    } catch (error) {
      console.error('❌ 心跳检测失败:', error);
      this.connectionStatus = 'error';
      this.scheduleReconnect();
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('❌ 达到最大重连次数，停止重连');
      this.connectionStatus = 'error';
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = this.RECONNECT_DELAY * this.reconnectAttempts; // 递增延迟

    console.log(`🔄 安排第${this.reconnectAttempts}次重连，${delay}ms后执行`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, delay);
  }

  /**
   * 处理实时数据变化（使用增强的设备过滤器）
   */
  private async handleRealtimeChange(payload: any) {
    try {
      const { eventType, new: newRecord, old: oldRecord } = payload;

      console.log('🔄 收到实时数据变化:', {
        eventType,
        newRecord: newRecord ? { id: newRecord.id, device_id: newRecord.device_id } : null,
        oldRecord: oldRecord ? { id: oldRecord.id, device_id: oldRecord.device_id } : null
      });

      // 使用增强的设备过滤器
      const shouldProcess = await shouldProcessRealtimeEvent(payload as RealtimePayload);

      if (!shouldProcess) {
        console.log('⏭️ 实时事件被设备过滤器拦截');
        return;
      }

      console.log('✅ 实时事件通过设备过滤，开始智能判断:', {
        eventType,
        recordId: newRecord?.id || oldRecord?.id
      });

      // 使用智能同步判断器
      await this.performIntelligentSync(payload);

    } catch (error) {
      console.error('❌ 处理实时变化失败:', error);
    }
  }

  /**
   * 智能同步处理
   */
  private async performIntelligentSync(payload: any): Promise<void> {
    try {
      const { eventType, new: newRecord, old: oldRecord } = payload;

      // 构建变化信息
      const changeInfo: ChangeInfo = {
        type: this.mapEventTypeToChangeType(eventType),
        affectedGroups: 1, // 单个事件通常影响一个组
        affectedTabs: newRecord?.tabs?.length || oldRecord?.tabs?.length || 0,
        timestamp: new Date().toISOString(),
        source: 'remote',
        metadata: {
          groupIds: [newRecord?.id || oldRecord?.id],
          operationType: eventType
        }
      };

      // 构建系统状态
      const systemState: SystemState = await this.getSystemState();

      // 获取本地数据用于判断
      const localData = await storage.getGroups();

      // 智能判断是否需要同步
      const judgment = shouldPerformRealtimeSync(changeInfo, systemState, localData);

      console.log('🧠 智能同步判断结果:', {
        shouldSync: judgment.shouldSync,
        reason: judgment.reason,
        priority: judgment.priority,
        estimatedImpact: judgment.estimatedImpact,
        recommendedDelay: judgment.recommendedDelay
      });

      if (!judgment.shouldSync) {
        console.log('⏭️ 智能判断跳过同步:', judgment.reason);
        return;
      }

      // 根据判断结果执行同步
      const delay = judgment.recommendedDelay || 500;

      this.debouncer.debounce(
        'realtime_sync',
        () => this.performRealtimeSync(),
        'realtime_change',
        delay
      );

    } catch (error) {
      console.error('❌ 智能同步处理失败:', error);

      // 降级到普通防抖处理
      this.debouncer.debounce(
        'realtime_sync',
        () => this.performRealtimeSync(),
        'realtime_change'
      );
    }
  }

  /**
   * 处理用户设置变化（使用增强的设备过滤器）
   */
  private async handleSettingsChange(payload: any) {
    try {
      const { eventType, new: newRecord } = payload;

      // 使用增强的设备过滤器检查设置变化
      const settingsPayload: RealtimePayload = {
        eventType: eventType as 'INSERT' | 'UPDATE' | 'DELETE',
        new: newRecord,
        old: payload.old
      };

      const shouldProcess = await shouldProcessRealtimeEvent(settingsPayload);

      if (!shouldProcess) {
        console.log('⏭️ 设置变化被设备过滤器拦截');
        return;
      }

      console.log('✅ 处理其他设备的设置变化:', eventType);

      // 使用智能防抖器处理设置同步
      this.debouncer.debounce(
        'settings_sync',
        () => this.performSettingsSync(),
        'settings_change'
      );

    } catch (error) {
      console.error('❌ 处理设置变化失败:', error);
    }
  }

  /**
   * 执行实时同步 - 使用乐观锁机制避免数据覆盖
   */
  private async performRealtimeSync() {
    try {
      const state = store.getState();
      if (!selectIsAuthenticated(state) || !state.settings.syncEnabled) {
        return;
      }

      console.log('🔄 开始实时同步数据（使用乐观锁机制 + 冲突检测）');

      // 检查是否有待处理的用户操作，避免覆盖
      try {
        const { syncCoordinator } = await import('./syncCoordinator');
        const localGroups = await storage.getGroups();
        const localGroupIds = localGroups.map(g => g.id);

        if (syncCoordinator.shouldBlockRealtimeSync(localGroupIds)) {
          console.log('⚠️ 检测到待处理的用户操作，暂停实时同步');
          return;
        }
      } catch (error) {
        console.warn('⚠️ 同步协调器检查失败，继续执行同步:', error);
      }

      // 使用乐观锁的pullLatestData方法，包含版本冲突检测
      try {
        const { optimisticSyncService } = await import('./optimisticSyncService');
        const pullResult = await optimisticSyncService.pullLatestData();

        if (pullResult.success) {
          console.log('✅ 实时同步完成（乐观锁 + 冲突检测）');

          if (pullResult.conflicts && pullResult.conflicts.length > 0) {
            console.log(`🔄 实时同步中解决了 ${pullResult.conflicts.length} 个版本冲突`);
          }
        } else {
          console.error('❌ 实时同步失败:', pullResult.message);
          // 记录错误但不降级，避免功能不完整的同步
          console.error('实时同步服务不可用，请检查网络连接');
        }
      } catch (error) {
        console.error('❌ 乐观锁同步失败:', error);
        // 记录错误但不降级，避免功能不完整的同步
        console.error('同步服务不可用，请检查网络连接');
      }

      // 显示通知（如果启用）
      if (state.settings.showNotifications) {
        this.showSyncNotification('其他设备的数据已同步');
      }

    } catch (error) {
      console.error('❌ 实时同步失败:', error);
    }
  }

  /**
   * 执行设置同步
   */
  private async performSettingsSync() {
    try {
      const state = store.getState();
      if (!selectIsAuthenticated(state)) {
        return;
      }

      console.log('🔄 开始同步设置');

      // 这里可以添加设置同步逻辑
      // 由于设置同步比较复杂，暂时记录日志
      console.log('📝 检测到设置变化，可能需要刷新设置');

    } catch (error) {
      console.error('❌ 设置同步失败:', error);
    }
  }

  // getCurrentDeviceId 方法已被 deviceFilter.getCurrentDeviceId() 替代

  /**
   * 获取防抖器状态
   */
  getDebounceStatus(): {
    hasPendingSync: boolean;
    hasPendingSettings: boolean;
    debugInfo: any;
  } {
    return {
      hasPendingSync: this.debouncer.hasPendingTask('realtime_sync'),
      hasPendingSettings: this.debouncer.hasPendingTask('settings_sync'),
      debugInfo: this.debouncer.getDebugInfo()
    };
  }

  /**
   * 立即执行待处理的同步任务
   */
  async flushPendingSync(): Promise<void> {
    await this.debouncer.flush('realtime_sync');
  }

  /**
   * 立即执行待处理的设置同步任务
   */
  async flushPendingSettings(): Promise<void> {
    await this.debouncer.flush('settings_sync');
  }

  /**
   * 取消所有待处理的任务
   */
  cancelAllPendingTasks(): void {
    this.debouncer.cancelAll();
  }

  /**
   * 映射事件类型到变化类型
   */
  private mapEventTypeToChangeType(eventType: string): ChangeType {
    switch (eventType) {
      case 'INSERT':
        return ChangeType.CREATE;
      case 'UPDATE':
        return ChangeType.UPDATE;
      case 'DELETE':
        return ChangeType.DELETE;
      default:
        return ChangeType.UPDATE;
    }
  }

  /**
   * 获取系统状态（使用网络管理器）
   */
  private async getSystemState(): Promise<SystemState> {
    const state = store.getState();

    // 检查用户活跃状态
    const isUserActive = document.hasFocus() && !document.hidden;

    // 使用网络管理器获取网络质量
    const networkInfo = networkManager.getNetworkInfo();
    let networkQuality: SystemState['networkQuality'];

    switch (networkInfo.quality) {
      case NetworkQuality.EXCELLENT:
        networkQuality = 'excellent';
        break;
      case NetworkQuality.GOOD:
        networkQuality = 'good';
        break;
      case NetworkQuality.FAIR:
        networkQuality = 'fair';
        break;
      case NetworkQuality.POOR:
        networkQuality = 'poor';
        break;
      default:
        networkQuality = 'good';
    }

    // 检查待处理操作数量
    const pendingOperations = this.debouncer.getPendingTaskCount();

    return {
      isUserActive,
      networkQuality,
      pendingOperations,
      lastSyncTime: this.getLastSyncTime(),
      // 添加额外的网络信息
      batteryLevel: this.getBatteryLevel(),
      memoryUsage: this.getMemoryUsage()
    };
  }

  /**
   * 获取最后同步时间
   */
  private getLastSyncTime(): string | undefined {
    // 这里可以从存储中获取最后同步时间
    // 暂时返回undefined
    return undefined;
  }

  /**
   * 获取电池电量
   */
  private getBatteryLevel(): number | undefined {
    // 电池API在某些浏览器中可用
    if ('getBattery' in navigator) {
      // 这是一个异步API，这里简化处理
      return undefined;
    }
    return undefined;
  }

  /**
   * 获取内存使用情况
   */
  private getMemoryUsage(): number | undefined {
    // 内存API在某些浏览器中可用
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      if (memory.usedJSHeapSize && memory.totalJSHeapSize) {
        return (memory.usedJSHeapSize / memory.totalJSHeapSize) * 100;
      }
    }
    return undefined;
  }

  /**
   * 获取智能同步统计信息
   */
  getIntelligentSyncStats(): any {
    return smartSyncJudge.getStats();
  }

  /**
   * 设置网络状态监听器
   */
  private setupNetworkListener(): void {
    const networkListener = (networkInfo: NetworkInfo) => {
      console.log('🌐 网络状态变化:', {
        status: networkInfo.status,
        quality: networkInfo.quality,
        effectiveType: networkInfo.effectiveType
      });

      this.handleNetworkStatusChange(networkInfo);
    };

    addNetworkListener(networkListener);
  }

  /**
   * 处理网络状态变化
   */
  private handleNetworkStatusChange(networkInfo: NetworkInfo): void {
    const { status, quality } = networkInfo;

    switch (status) {
      case NetworkStatus.ONLINE:
        this.handleNetworkOnline(quality);
        break;

      case NetworkStatus.OFFLINE:
        this.handleNetworkOffline();
        break;

      case NetworkStatus.UNSTABLE:
        this.handleNetworkUnstable();
        break;

      case NetworkStatus.SLOW:
        this.handleNetworkSlow();
        break;
    }
  }

  /**
   * 处理网络上线
   */
  private handleNetworkOnline(quality: NetworkQuality): void {
    console.log('✅ 网络已连接，质量:', quality);

    // 重置重连计数
    this.reconnectAttempts = 0;

    // 更新连接状态
    this.connectionStatus = 'connected';

    // 如果之前断开，尝试重新初始化
    if (!this.isEnabled) {
      console.log('🔄 网络恢复，重新初始化实时同步');
      this.initialize();
    }

    // 根据网络质量调整同步策略
    this.adjustSyncStrategyByQuality(quality);
  }

  /**
   * 处理网络离线
   */
  private handleNetworkOffline(): void {
    console.warn('❌ 网络已断开');

    // 更新连接状态
    this.connectionStatus = 'disconnected';

    // 取消所有待处理的同步任务
    this.debouncer.cancelAll();

    // 断开实时连接
    this.disconnect();
  }

  /**
   * 处理网络不稳定
   */
  private handleNetworkUnstable(): void {
    console.warn('⚠️ 网络连接不稳定');

    // 更新连接状态
    this.connectionStatus = 'error';

    // 增加同步延迟
    this.debouncer.updateConfig({
      defaultDelay: 2000,
      highFrequencyMultiplier: 2.5
    });
  }

  /**
   * 处理网络缓慢
   */
  private handleNetworkSlow(): void {
    console.warn('🐌 网络连接缓慢');

    // 增加同步延迟，减少频率
    this.debouncer.updateConfig({
      defaultDelay: 3000,
      highFrequencyMultiplier: 3.0
    });
  }

  /**
   * 根据网络质量调整同步策略
   */
  private adjustSyncStrategyByQuality(quality: NetworkQuality): void {
    switch (quality) {
      case NetworkQuality.EXCELLENT:
        this.debouncer.updateConfig({
          defaultDelay: 300,
          highFrequencyMultiplier: 1.2
        });
        break;

      case NetworkQuality.GOOD:
        this.debouncer.updateConfig({
          defaultDelay: 500,
          highFrequencyMultiplier: 1.5
        });
        break;

      case NetworkQuality.FAIR:
        this.debouncer.updateConfig({
          defaultDelay: 1000,
          highFrequencyMultiplier: 2.0
        });
        break;

      case NetworkQuality.POOR:
        this.debouncer.updateConfig({
          defaultDelay: 2000,
          highFrequencyMultiplier: 3.0
        });
        break;
    }

    console.log('🔧 已根据网络质量调整同步策略:', quality);
  }

  /**
   * 显示同步通知
   */
  private showSyncNotification(message: string) {
    if ('Notification' in window) {
      const iconUrl = chrome.runtime.getURL('icons/icon48.png');
      new Notification('OneTab Plus - 🔄', {
        body: message,
        icon: iconUrl,
        silent: true,
      });
    }
  }

  /**
   * 启用实时同步
   */
  async enable() {
    if (!this.isEnabled) {
      this.isEnabled = true;
      await this.initialize();
    }
  }

  /**
   * 禁用实时同步
   */
  async disable() {
    this.isEnabled = false;
    if (this.channel) {
      console.log('🔄 关闭实时同步');
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  /**
   * 重新连接实时同步
   */
  async reconnect() {
    console.log('🔄 开始重新连接实时同步');
    await this.cleanup();

    // 检查用户是否仍然登录
    const state = store.getState();
    if (!selectIsAuthenticated(state)) {
      console.log('🔄 用户已登出，取消重连');
      this.connectionStatus = 'disconnected';
      return;
    }

    await this.initialize();
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): string {
    return this.connectionStatus;
  }

  /**
   * 强制重连
   */
  async forceReconnect() {
    console.log('🔄 强制重连实时同步');
    this.reconnectAttempts = 0;
    await this.reconnect();
  }

  /**
   * 销毁实时同步
   */
  async destroy() {
    console.log('🔄 销毁实时同步服务');
    this.isEnabled = false;
    await this.cleanup();
    this.currentUserId = null;
    this.connectionStatus = 'disconnected';
  }
}

// 创建全局实例
export const realtimeSync = new RealtimeSync();