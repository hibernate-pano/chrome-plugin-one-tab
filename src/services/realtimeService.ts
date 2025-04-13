import { supabase } from '@/utils/supabase';
import { store } from '@/store';
import { syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getDeviceId } from '@/utils/deviceUtils';

// Supabase Realtime 消息类型定义
interface RealtimePayload {
  commit_timestamp: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  new: Record<string, any> | null;
  old: Record<string, any> | null;
}

let subscription: any = null;

/**
 * 设置 Realtime 订阅
 */
export const setupRealtimeSubscription = async () => {
  // 如果已经有订阅，先清除
  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
  }

  try {
    // 获取当前用户
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      console.log('用户未登录，不设置 Realtime 订阅');
      return null;
    }

    // 获取设备ID，用于过滤自己设备的更新
    const deviceId = await getDeviceId();
    console.log('设置 Realtime 订阅，用户ID:', user.id, '设备ID:', deviceId);

    // 创建 Realtime 订阅，使用基于用户ID的通道（而非每个设备一个通道）
    // 这样可以显著减少服务器资源消耗，特别是在大规模用户场景下
    const channelName = `user-changes-${user.id}`;
    console.log('使用基于用户ID的通道名称:', channelName);

    subscription = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*', // 监听所有事件（INSERT, UPDATE, DELETE）
          schema: 'public',
          table: 'tab_groups',
          filter: `user_id=eq.${user.id}` // 只监听当前用户的数据
        },
        async (payload: RealtimePayload) => {
          // 获取更新消息的设备ID
          const updateDeviceId = payload.new?.device_id || payload.old?.device_id;

          // 添加更详细的日志
          console.log('收到 tab_groups 表的 Realtime 更新:', {
            eventType: payload.eventType,
            recordId: payload.new?.id || payload.old?.id,
            timestamp: new Date().toISOString(),
            deviceId: updateDeviceId
          });

          // 如果更新来自当前设备，则忽略该更新，避免循环同步
          if (updateDeviceId === deviceId) {
            console.log('忽略自己设备的更新，避免循环同步');
            return;
          }

          // 获取当前状态
          const state = store.getState();
          const { syncStatus, backgroundSync } = state.tabs;

          // 如果当前正在同步，则跳过
          if (syncStatus === 'syncing' || backgroundSync) {
            console.log('当前正在同步，跳过 Realtime 更新');
            return;
          }

          // 添加防抖处理，避免短时间内多次触发同步
          // 使用全局变量跟踪最后一次同步时间
          const now = Date.now();
          const lastSyncTimeKey = `lastRealtimeSyncTime_${user.id}`;
          const lastSyncTime = parseInt(localStorage.getItem(lastSyncTimeKey) || '0');

          // 如果距离上次同步不足 2 秒，则跳过
          if (now - lastSyncTime < 2000) {
            console.log('距离上次同步不足 2 秒，跳过本次更新');
            return;
          }

          // 根据变化类型执行不同操作
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
            console.log(`检测到远程 ${payload.eventType} 操作，开始从云端同步数据...`);

            // 更新最后同步时间
            localStorage.setItem(lastSyncTimeKey, now.toString());

            // 从云端同步最新数据
            await store.dispatch(syncTabsFromCloud({ background: true }));
            console.log('从云端同步数据完成');
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*', // 监听所有事件（INSERT, UPDATE, DELETE）
          schema: 'public',
          table: 'user_settings',
          filter: `user_id=eq.${user.id}` // 只监听当前用户的数据
        },
        async (payload: RealtimePayload) => {
          // 获取更新消息的设备ID
          const updateDeviceId = payload.new?.device_id || payload.old?.device_id;

          // 添加更详细的日志
          console.log('收到 user_settings 表的 Realtime 更新:', {
            eventType: payload.eventType,
            recordId: payload.new?.id || payload.old?.id,
            timestamp: new Date().toISOString(),
            deviceId: updateDeviceId
          });

          // 如果更新来自当前设备，则忽略该更新，避免循环同步
          if (updateDeviceId === deviceId) {
            console.log('忽略自己设备的设置更新，避免循环同步');
            return;
          }

          // 获取当前状态
          const state = store.getState();
          const { syncStatus, backgroundSync } = state.tabs;

          // 如果当前正在同步，则跳过
          if (syncStatus === 'syncing' || backgroundSync) {
            console.log('当前正在同步，跳过 Realtime 设置更新');
            return;
          }

          // 添加防抖处理，避免短时间内多次触发同步
          const now = Date.now();
          const lastSettingsSyncTimeKey = `lastRealtimeSettingsSyncTime_${user.id}`;
          const lastSyncTime = parseInt(localStorage.getItem(lastSettingsSyncTimeKey) || '0');

          // 如果距离上次同步不足 2 秒，则跳过
          if (now - lastSyncTime < 2000) {
            console.log('距离上次设置同步不足 2 秒，跳过本次更新');
            return;
          }

          // 根据变化类型执行不同操作
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            console.log(`检测到远程 ${payload.eventType} 操作，开始从云端同步设置...`);

            // 更新最后同步时间
            localStorage.setItem(lastSettingsSyncTimeKey, now.toString());

            // 从云端同步最新设置
            await store.dispatch(syncSettingsFromCloud());
            console.log('从云端同步设置完成');
          }
        }
      )
      .subscribe((status: any) => {
        console.log('Realtime 订阅状态:', status);
      });

    return subscription;
  } catch (error) {
    console.error('设置 Realtime 订阅失败:', error);
    return null;
  }
};

/**
 * 清除 Realtime 订阅
 */
export const clearRealtimeSubscription = () => {
  if (subscription) {
    subscription.unsubscribe();
    subscription = null;
    console.log('已清除 Realtime 订阅');
  }
};

/**
 * Realtime 服务
 */
export const realtimeService = {
  setupRealtimeSubscription,
  clearRealtimeSubscription
};

export default realtimeService;
