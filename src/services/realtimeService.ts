import { supabase } from '@/utils/supabase';
import { store } from '@/store';
import { setGroups } from '@/store/slices/tabSlice';
import { syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { storage } from '@/utils/storage';
import { TabGroup, TabData } from '@/types/tab';

let subscription: any = null;

/**
 * 将 Supabase 标签组转换为应用格式
 */
const convertSupabaseGroupToAppFormat = (group: any): TabGroup => {
  // 从 JSONB 字段获取标签数据
  const tabsData = group.tabs_data || [];

  // 将 TabData 转换为 Tab 格式
  const formattedTabs = tabsData.map((tab: TabData) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    createdAt: tab.created_at,
    lastAccessed: tab.last_accessed,
    group_id: group.id
  }));

  return {
    id: group.id,
    name: group.name,
    tabs: formattedTabs,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
    isLocked: group.is_locked,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString()
  };
};

/**
 * 处理远程删除
 */
async function handleRemoteDelete(groupId: string) {
  try {
    // 获取当前标签组
    const groups = await storage.getGroups();

    // 移除已删除的标签组
    const updatedGroups = groups.filter(group => group.id !== groupId);

    // 保存更新后的标签组
    await storage.setGroups(updatedGroups);

    // 更新 Redux 存储
    store.dispatch(setGroups(updatedGroups));

    console.log(`成功处理远程删除标签组: ${groupId}`);
  } catch (error) {
    console.error('处理远程删除失败:', error);
  }
}

/**
 * 处理远程变更（插入或更新）
 */
async function handleRemoteChange(groupId: string) {
  try {
    // 获取特定变更的标签组
    const { data: changedGroup, error } = await supabase
      .from('tab_groups')
      .select('*')
      .eq('id', groupId)
      .single();

    if (error || !changedGroup) {
      console.error('获取变更的标签组失败:', error);
      return;
    }

    // 转换为应用格式
    const formattedGroup = convertSupabaseGroupToAppFormat(changedGroup);

    // 获取当前标签组
    const groups = await storage.getGroups();

    // 查找并替换或添加变更的标签组
    const updatedGroups = [...groups];
    const existingIndex = updatedGroups.findIndex(g => g.id === groupId);

    if (existingIndex >= 0) {
      // 更新现有标签组
      updatedGroups[existingIndex] = formattedGroup;
    } else {
      // 添加新标签组
      updatedGroups.push(formattedGroup);
    }

    // 保存更新后的标签组
    await storage.setGroups(updatedGroups);

    // 更新 Redux 存储
    store.dispatch(setGroups(updatedGroups));

    console.log(`成功处理远程${existingIndex >= 0 ? '更新' : '新增'}标签组: ${groupId}`);
  } catch (error) {
    console.error('处理远程变更失败:', error);
  }
}

/**
 * 设置 Realtime 订阅 - 优化版本
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

    console.log('设置优化的 Realtime 订阅，用户ID:', user.id);

    // 创建单一用户通道
    subscription = supabase
      .channel(`user-${user.id}-changes`)
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

          // 获取变更项的ID
          const changedId = payload.new ? (payload.new as any).id : (payload.old as any)?.id;

          if (!changedId) {
            console.warn('无法获取变更项ID，跳过处理');
            return;
          }

          if (payload.eventType === 'DELETE') {
            // 处理删除 - 从本地存储中移除
            await handleRemoteDelete(changedId);
          } else {
            // 处理插入/更新 - 获取并合并特定项
            await handleRemoteChange(changedId);
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
