import { supabase } from '@/utils/supabase';
import { store } from '@/store';
import { syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsFromCloud } from '@/store/slices/settingsSlice';

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

    console.log('设置 Realtime 订阅，用户ID:', user.id);

    // 创建 Realtime 订阅
    subscription = supabase
      .channel('table-changes')
      .on(
        'postgres_changes',
        {
          event: '*', // 监听所有事件（INSERT, UPDATE, DELETE）
          schema: 'public',
          table: 'tab_groups',
          filter: `user_id=eq.${user.id}` // 只监听当前用户的数据
        },
        async (payload) => {
          console.log('收到 tab_groups 表的 Realtime 更新:', payload);

          // 获取当前状态
          const state = store.getState();
          const { syncStatus, backgroundSync } = state.tabs;

          // 如果当前正在同步，则跳过
          if (syncStatus === 'syncing' || backgroundSync) {
            console.log('当前正在同步，跳过 Realtime 更新');
            return;
          }

          // 根据变化类型执行不同操作
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE' || payload.eventType === 'DELETE') {
            console.log(`检测到远程 ${payload.eventType} 操作，开始从云端同步数据...`);

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
        async (payload) => {
          console.log('收到 user_settings 表的 Realtime 更新:', payload);

          // 根据变化类型执行不同操作
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            console.log(`检测到远程 ${payload.eventType} 操作，开始从云端同步设置...`);

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
