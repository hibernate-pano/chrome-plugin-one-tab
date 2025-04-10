import { createClient } from '@supabase/supabase-js';
import { TabGroup, UserSettings, Tab } from '@/types/tab';
import { compressTabGroups, decompressTabGroups, formatCompressionStats } from './compressionUtils';

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
  async uploadTabGroups(groups: TabGroup[], deletedGroups: TabGroup[] = [], deletedTabs: Tab[] = []) {
    const deviceId = await getDeviceId();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    console.log('准备上传标签组，用户ID:', user.id);
    console.log(`要上传的数据: ${groups.length} 个标签组, ${deletedGroups.length} 个已删除标签组, ${deletedTabs.length} 个已删除标签页`);

    // 获取当前的压缩数据
    let currentCompressedData = null;
    let currentTabGroups: TabGroup[] = [];

    try {
      // 获取包含压缩数据的标签组
      const { data: compressedGroups, error: compressedError } = await supabase
        .from('tab_groups')
        .select('compressed_data')
        .eq('user_id', user.id)
        .not('compressed_data', 'is', null)
        .order('last_sync', { ascending: false })
        .limit(1);

      // 如果找到压缩数据，则解压缩数据
      if (!compressedError && compressedGroups && compressedGroups.length > 0 && compressedGroups[0].compressed_data) {
        console.log('找到现有压缩数据，开始解压...');
        currentCompressedData = compressedGroups[0].compressed_data;

        try {
          // 解压数据
          currentTabGroups = decompressTabGroups(currentCompressedData);
          console.log(`成功解压数据，当前云端有 ${currentTabGroups.length} 个标签组`);
        } catch (decompressError) {
          console.error('解压数据失败:', decompressError);
          currentTabGroups = [];
        }
      } else {
        console.log('未找到现有压缩数据，将创建新的压缩数据');
      }
    } catch (error) {
      console.error('获取现有压缩数据失败:', error);
    }

    // 处理已删除的标签组
    if (deletedGroups.length > 0) {
      console.log('开始处理已删除的标签组...');

      // 从当前标签组中移除已删除的标签组
      const deletedGroupIds = new Set(deletedGroups.map(group => group.id));
      currentTabGroups = currentTabGroups.filter(group => !deletedGroupIds.has(group.id));

      console.log(`从压缩数据中移除了 ${deletedGroups.length} 个标签组`);
    }

    // 处理已删除的标签页
    if (deletedTabs.length > 0) {
      console.log('开始处理已删除的标签页...');

      // 从当前标签组中移除已删除的标签页
      const deletedTabIds = new Set(deletedTabs.map(tab => tab.id));

      // 遍历每个标签组，移除已删除的标签页
      currentTabGroups = currentTabGroups.map(group => ({
        ...group,
        tabs: group.tabs.filter(tab => !deletedTabIds.has(tab.id))
      }));

      // 移除空的标签组
      currentTabGroups = currentTabGroups.filter(group => group.tabs.length > 0);

      console.log(`从压缩数据中移除了 ${deletedTabs.length} 个标签页`);
    }

    // 合并本地标签组和云端标签组
    // 将本地标签组添加到当前标签组中，如果有重复，则使用本地的版本
    const mergedTabGroups = [...currentTabGroups];
    const currentGroupIds = new Set(currentTabGroups.map(group => group.id));

    // 添加本地标签组（如果不在云端存在）
    for (const group of groups) {
      if (!currentGroupIds.has(group.id)) {
        mergedTabGroups.push(group);
      } else {
        // 替换现有的标签组
        const index = mergedTabGroups.findIndex(g => g.id === group.id);
        if (index !== -1) {
          mergedTabGroups[index] = group;
        }
      }
    }

    console.log(`合并后的标签组数量: ${mergedTabGroups.length}`);

    // 为每个标签组添加用户ID和设备ID
    const currentTime = new Date().toISOString();

    // 压缩合并后的标签组数据
    const { compressed, stats } = compressTabGroups(mergedTabGroups);
    console.log('数据压缩统计:', formatCompressionStats(stats));

    // 保存压缩统计信息以便返回
    const compressionStats = stats;

    const groupsWithUser = mergedTabGroups.map(group => {
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

    // 上传标签组元数据和压缩数据
    let result: any = null;
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

      // 为第一个标签组添加压缩数据
      // 我们只需要存储一次压缩数据，因为它包含所有标签组
      if (groupsWithUser.length > 0) {
        const firstGroup = { ...groupsWithUser[0], compressed_data: compressed };
        groupsWithUser[0] = firstGroup;
      }

      const { data, error } = await supabase
        .from('tab_groups')
        .upsert(groupsWithUser, { onConflict: 'id' });

      result = data;

      if (error) {
        console.error('上传标签组失败:', error);
        throw error;
      }

      console.log('标签组元数据和压缩数据上传成功');
    } catch (e) {
      console.error('上传标签组时发生异常:', e);
      throw e;
    }

    // 使用压缩数据后，我们不需要再单独上传每个标签
    // 但为了兼容性，我们仍然保留这部分代码
    // 在未来版本中，可以完全移除这部分，只使用压缩数据

    console.log('所有数据上传成功');
    return { result, compressionStats };
  },

  // 下载标签组
  async downloadTabGroups() {
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) throw new Error('用户未登录');

    console.log('开始下载标签组，用户ID:', user.id);

    try {
      // 尝试使用压缩数据方式下载
      // 获取包含压缩数据的标签组
      const { data: compressedGroups, error: compressedError } = await supabase
        .from('tab_groups')
        .select('compressed_data')
        .eq('user_id', user.id)
        .not('compressed_data', 'is', null)
        .order('last_sync', { ascending: false })
        .limit(1);

      // 如果找到压缩数据，则使用压缩数据
      if (!compressedError && compressedGroups && compressedGroups.length > 0 && compressedGroups[0].compressed_data) {
        console.log('找到压缩数据，开始解压...');
        const compressed = compressedGroups[0].compressed_data;

        try {
          // 解压数据
          const tabGroups = decompressTabGroups(compressed);
          console.log(`成功解压数据，共 ${tabGroups.length} 个标签组`);

          // 返回标签组
          return tabGroups;
        } catch (decompressError) {
          console.error('解压数据失败，将使用传统方式下载:', decompressError);
          // 如果解压失败，则回退到传统方式
        }
      } else {
        console.log('未找到压缩数据，将使用传统方式下载');
      }

      // 传统方式下载（如果压缩方式失败）
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
    } catch (error) {
      console.error('下载标签组失败:', error);
      throw error;
    }
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
