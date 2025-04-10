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

    console.log('准备上传标签组，用户ID:', user.id);
    console.log('要上传的标签组数量:', groups.length);

    // 为每个标签组添加用户ID和设备ID
    const currentTime = new Date().toISOString();

    const groupsWithUser = groups.map(group => {
      // 确保必要字段都有值
      const createdAt = group.createdAt || currentTime;
      const updatedAt = group.updatedAt || currentTime;

      return {
        id: group.id,
        name: group.name || 'Unnamed Group',
        created_at: createdAt,
        updated_at: updatedAt,
        is_locked: group.isLocked || false,
        user_id: user.id,
        device_id: deviceId,
        last_sync: currentTime
      };
    });

    console.log('格式化后的标签组:', groupsWithUser);

    // 上传标签组
    let result;
    try {
      // 验证数据
      for (const group of groupsWithUser) {
        if (!group.id) {
          console.error('标签组缺少ID:', group);
          throw new Error('标签组缺少ID');
        }
        if (!group.created_at) {
          console.error('标签组缺少created_at:', group);
          throw new Error('标签组缺少created_at');
        }
        if (!group.updated_at) {
          console.error('标签组缺少updated_at:', group);
          throw new Error('标签组缺少updated_at');
        }
      }

      const { data, error } = await supabase
        .from('tab_groups')
        .upsert(groupsWithUser, { onConflict: 'id' });

      result = data;

      if (error) {
        console.error('上传标签组失败:', error);
        throw error;
      }
    } catch (e) {
      console.error('上传标签组时发生异常:', e);
      throw e;
    }

    console.log('标签组上传成功，开始上传标签');

    // 上传每个标签组中的标签
    for (const group of groups) {
      const currentTime = new Date().toISOString();

      const tabsWithGroupId = group.tabs.map(tab => ({
        id: tab.id,
        url: tab.url || '',
        title: tab.title || 'Unnamed Tab',
        favicon: tab.favicon || '',
        created_at: tab.createdAt || currentTime,
        last_accessed: tab.lastAccessed || currentTime,
        group_id: group.id
      }));

      console.log(`为标签组 ${group.id} 上传 ${tabsWithGroupId.length} 个标签`);

      try {
        // 验证标签数据
        for (const tab of tabsWithGroupId) {
          if (!tab.id) {
            console.error('标签缺少ID:', tab);
            throw new Error('标签缺少ID');
          }
          if (!tab.created_at) {
            console.error('标签缺少created_at:', tab);
            throw new Error('标签缺少created_at');
          }
          if (!tab.last_accessed) {
            console.error('标签缺少last_accessed:', tab);
            throw new Error('标签缺少last_accessed');
          }
          if (!tab.group_id) {
            console.error('标签缺少group_id:', tab);
            throw new Error('标签缺少group_id');
          }
        }

        const { error: tabError } = await supabase
          .from('tabs')
          .upsert(tabsWithGroupId, { onConflict: 'id' });

        if (tabError) {
          console.error('上传标签失败:', tabError);
          throw tabError;
        }
      } catch (e) {
        console.error(`为标签组 ${group.id} 上传标签时发生异常:`, e);
        throw e;
      }
    }

    console.log('所有数据上传成功');
    return result;
  },

  // 下载标签组
  async downloadTabGroups() {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    console.log('开始下载标签组，用户ID:', user.id);

    // 获取用户的所有标签组
    const { data: groups, error } = await supabase
      .from('tab_groups')
      .select('*')
      .eq('user_id', user.id);

    if (error) {
      console.error('获取标签组失败:', error);
      throw error;
    }

    console.log(`从云端获取到 ${groups.length} 个标签组`);

    // 获取每个标签组的标签
    const tabGroups: TabGroup[] = [];

    for (const group of groups) {
      const { data: tabs, error: tabError } = await supabase
        .from('tabs')
        .select('*')
        .eq('group_id', group.id);

      if (tabError) {
        console.error(`获取标签组 ${group.id} 的标签失败:`, tabError);
        throw tabError;
      }

      console.log(`标签组 ${group.id} 有 ${tabs.length} 个标签`);

      const formattedTabs = tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        favicon: tab.favicon,
        createdAt: tab.created_at,
        lastAccessed: tab.last_accessed,
        group_id: tab.group_id
      }));

      tabGroups.push({
        id: group.id,
        name: group.name,
        tabs: formattedTabs,
        createdAt: group.created_at,
        updatedAt: group.updated_at,
        isLocked: group.is_locked
      });
    }

    console.log('标签组下载完成');
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
