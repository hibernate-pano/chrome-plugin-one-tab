import { createClient } from '@supabase/supabase-js';
import { TabGroup, UserSettings } from '@/types/tab';

const SUPABASE_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlY2NjbG5heGFkYnVjY3Nyd21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQyOTExODYsImV4cCI6MjA1OTg2NzE4Nn0.nHkOtkUtkzEUnF9ajUipD37SbAGH9znkVekI8N6hvdo';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 获取设备ID
export const getDeviceId = async (): Promise<string> => {
  const { deviceId } = await chrome.storage.local.get('deviceId');
  if (deviceId) return deviceId;

  const newDeviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: newDeviceId });
  return newDeviceId;
};

// 用户认证相关方法
export const auth = {
  // 使用邮箱注册
  async signUp(email: string, password: string) {
    return await supabase.auth.signUp({ email, password });
  },

  // 使用邮箱登录
  async signIn(email: string, password: string) {
    return await supabase.auth.signInWithPassword({ email, password });
  },

  // 退出登录
  async signOut() {
    return await supabase.auth.signOut();
  },

  // 获取当前用户
  async getCurrentUser() {
    return await supabase.auth.getUser();
  },

  // 获取会话
  async getSession() {
    return await supabase.auth.getSession();
  }
};

// 数据同步相关方法
export const sync = {
  // 上传标签组
  async uploadTabGroups(groups: TabGroup[]) {
    const deviceId = await getDeviceId();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    // 为每个标签组添加用户ID和设备ID
    const groupsWithUser = groups.map(group => ({
      ...group,
      user_id: user.id,
      device_id: deviceId,
      last_sync: new Date().toISOString()
    }));

    // 上传标签组
    const { data, error } = await supabase
      .from('tab_groups')
      .upsert(groupsWithUser, { onConflict: 'id' });

    if (error) throw error;

    // 上传每个标签组中的标签
    for (const group of groups) {
      const tabsWithGroupId = group.tabs.map(tab => ({
        ...tab,
        group_id: group.id
      }));

      const { error: tabError } = await supabase
        .from('tabs')
        .upsert(tabsWithGroupId, { onConflict: 'id' });

      if (tabError) throw tabError;
    }

    return data;
  },

  // 下载标签组
  async downloadTabGroups() {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    // 获取用户的所有标签组
    const { data: groups, error } = await supabase
      .from('tab_groups')
      .select('*')
      .eq('user_id', user.id);

    if (error) throw error;

    // 获取每个标签组的标签
    const tabGroups: TabGroup[] = [];

    for (const group of groups) {
      const { data: tabs, error: tabError } = await supabase
        .from('tabs')
        .select('*')
        .eq('group_id', group.id);

      if (tabError) throw tabError;

      tabGroups.push({
        id: group.id,
        name: group.name,
        tabs: tabs,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        isLocked: group.is_locked
      });
    }

    return tabGroups;
  },

  // 上传用户设置
  async uploadSettings(settings: UserSettings) {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    const { data, error } = await supabase
      .from('user_settings')
      .upsert({
        user_id: user.id,
        ...settings
      }, { onConflict: 'user_id' });

    if (error) throw error;

    return data;
  },

  // 下载用户设置
  async downloadSettings() {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    return data;
  }
};
