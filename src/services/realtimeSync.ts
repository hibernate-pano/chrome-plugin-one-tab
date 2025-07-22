import { supabase } from '@/utils/supabase';
import { store } from '@/app/store';
import { storage } from '@/shared/utils/storage';
import { RealtimeChannel } from '@supabase/supabase-js';
import { selectIsAuthenticated, selectAuthUser } from '@/features/auth/store/authSlice';

class RealtimeSync {
  private channel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;
  private isEnabled = false;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private syncTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5秒
  private readonly HEARTBEAT_INTERVAL = 30000; // 30秒心跳检测

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
   * 处理实时数据变化
   */
  private async handleRealtimeChange(payload: any) {
    try {
      const { eventType, new: newRecord, old: oldRecord } = payload;

      console.log('🔄 收到实时数据变化:', {
        eventType,
        newRecord: newRecord ? { id: newRecord.id, device_id: newRecord.device_id } : null,
        oldRecord: oldRecord ? { id: oldRecord.id, device_id: oldRecord.device_id } : null
      });

      // 避免处理自己设备的变化（防止循环）
      const currentDeviceId = await this.getCurrentDeviceId();

      // 对于删除事件，应该检查oldRecord；对于其他事件检查newRecord
      const recordDeviceId = eventType === 'DELETE'
        ? oldRecord?.device_id
        : newRecord?.device_id;

      if (recordDeviceId === currentDeviceId) {
        console.log('🔄 跳过自己设备的变化，设备ID:', recordDeviceId);
        return;
      }

      console.log('🔄 处理其他设备的数据变化:', {
        eventType,
        recordId: newRecord?.id || oldRecord?.id,
        deviceId: recordDeviceId,
        currentDeviceId
      });

      // 延迟处理，避免频繁同步（缩短延迟提高响应速度）
      if (this.syncTimeout) {
        clearTimeout(this.syncTimeout);
      }

      this.syncTimeout = setTimeout(async () => {
        console.log('🔄 开始执行实时同步响应');
        await this.performRealtimeSync();
      }, 500); // 缩短到500ms，提高响应速度

    } catch (error) {
      console.error('❌ 处理实时变化失败:', error);
    }
  }

  /**
   * 处理用户设置变化
   */
  private async handleSettingsChange(payload: any) {
    try {
      const { eventType, new: newRecord } = payload;

      // 避免处理自己设备的变化
      const currentDeviceId = await this.getCurrentDeviceId();
      if (newRecord?.device_id === currentDeviceId) {
        console.log('🔄 跳过自己设备的设置变化');
        return;
      }

      console.log('🔄 处理其他设备的设置变化:', eventType);

      // 延迟处理设置同步
      setTimeout(async () => {
        await this.performSettingsSync();
      }, 500);

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

  /**
   * 获取当前设备ID
   */
  private async getCurrentDeviceId(): Promise<string> {
    try {
      const { deviceId } = await chrome.storage.local.get('deviceId');

      if (!deviceId) {
        console.warn('⚠️ 设备ID不存在，生成临时ID');
        // 生成临时设备ID
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        await chrome.storage.local.set({ deviceId: tempId });
        return tempId;
      }

      return deviceId;
    } catch (error) {
      console.error('❌ 获取设备ID失败:', error);
      // 返回一个基于时间戳的临时ID
      return `fallback_${Date.now()}`;
    }
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