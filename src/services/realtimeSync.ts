import { supabase } from '@/utils/supabase';
import { store } from '@/app/store';
import { syncService } from '@/services/syncService';
import { simpleSyncService } from '@/services/simpleSyncService';
import { RealtimeChannel } from '@supabase/supabase-js';

class RealtimeSync {
  private channel: RealtimeChannel | null = null;
  private currentUserId: string | null = null;
  private isEnabled = false;

  /**
   * 初始化实时同步
   */
  async initialize() {
    const state = store.getState();
    if (!state.auth.isAuthenticated || !state.auth.user) {
      console.log('🔄 用户未登录，跳过实时同步初始化');
      return;
    }

    this.currentUserId = state.auth.user.id;
    this.isEnabled = state.settings.syncEnabled && state.settings.autoSyncEnabled;

    if (!this.isEnabled) {
      console.log('🔄 实时同步已禁用');
      return;
    }

    await this.setupRealtimeSubscription();
  }

  /**
   * 设置实时订阅
   */
  private async setupRealtimeSubscription() {
    if (!this.currentUserId) return;

    console.log('🔄 设置实时同步订阅，用户ID:', this.currentUserId);

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
        if (status === 'SUBSCRIBED') {
          console.log('✅ 实时同步已启用');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ 实时同步连接失败');
        }
      });
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

      // 延迟处理，避免频繁同步
      setTimeout(async () => {
        await this.performRealtimeSync();
      }, 1000);

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
   * 执行实时同步
   */
  private async performRealtimeSync() {
    try {
      const state = store.getState();
      if (!state.auth.isAuthenticated || !state.settings.syncEnabled) {
        return;
      }

      console.log('🔄 开始实时同步数据');

      // 使用简化的同步服务立即下载
      await simpleSyncService.downloadFromCloud();

      console.log('✅ 实时同步完成');

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
      if (!state.auth.isAuthenticated) {
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
    const { deviceId } = await chrome.storage.local.get('deviceId');
    return deviceId || '';
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
    await this.disable();
    await this.initialize();
  }

  /**
   * 销毁实时同步
   */
  destroy() {
    this.disable();
    this.currentUserId = null;
  }
}

// 创建全局实例
export const realtimeSync = new RealtimeSync();