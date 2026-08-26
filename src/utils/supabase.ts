import { createClient } from '@supabase/supabase-js';
import { TabGroup, UserSettings, TabData, SupabaseTabGroup } from '@/types/tab';

import { encryptData, decryptData, isEncrypted } from './encryptionUtils';

// 安全的配置管理
function getSecureConfig() {
  // 从环境变量中获取 Supabase 配置
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  // 验证环境变量格式
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }

  // 验证URL格式
  try {
    const url = new URL(SUPABASE_URL);
    if (!url.hostname.includes('supabase.co')) {
      return null;
    }
  } catch (error) {
    return null;
  }

  // 验证匿名密钥格式（JWT格式）
  if (!SUPABASE_ANON_KEY.startsWith('eyJ')) {
    return null;
  }

  // 在生产环境中，不要在控制台输出完整的配置信息
  if (import.meta.env.DEV) {
    console.log('Supabase 配置已加载:', {
      url: SUPABASE_URL,
      keyPrefix: SUPABASE_ANON_KEY.substring(0, 10) + '...'
    });
  }

  return {
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY
  };
}

// 延迟初始化 Supabase 客户端
let supabaseClient: ReturnType<typeof createClient> | null = null;

/**
 * 跨上下文持久化 Supabase session 的 storage adapter。
 *
 * 背景：supabase-js 默认把 session token 存 localStorage，但 MV3
 * service-worker 没有 localStorage（每次唤醒 memory storage 为空），
 * 导致后台轮询无法恢复登录态。统一改用 chrome.storage.local ——
 * popup 与 service-worker 共享同一 session。
 */
const supabaseSharedStorage: {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
} = {
  async getItem(key: string): Promise<string | null> {
    // 非扩展环境（如 node 测试）无 chrome.storage，退化为无 session
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    const result = await chrome.storage.local.get(key);
    return (result[key] as string | undefined) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    await chrome.storage.local.remove(key);
  },
};

/**
 * 迁移旧版 localStorage 中 supabase-js 的 session token 到 chrome.storage.local。
 * 早期版本 supabase-js 默认使用 localStorage 存 session（popup 上下文可用，
 * service-worker 不可用）。升级后统一走 chrome.storage，未登录用户无感；
 * 已登录用户 token 会被搬过去，避免升级后要求重新登录。
 */
async function migrateLegacySupabaseSession(): Promise<void> {
  try {
    if (typeof localStorage === 'undefined') return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const value = localStorage.getItem(key);
        if (value) {
          await chrome.storage.local.set({ [key]: value });
          console.log('[Supabase] 已迁移旧 session 到 chrome.storage.local');
        }
        localStorage.removeItem(key);
      }
    }
  } catch (err) {
    console.warn('[Supabase] 迁移旧 session 失败（可忽略）:', err);
  }
}

function initSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = getSecureConfig();
  if (!config) {
    // 配置缺失时，创建一个占位符客户端
    // 使用占位符 URL 和 key，避免后续调用时出错
    console.warn('Supabase 配置缺失。同步功能将不可用。如需使用同步功能，请在 .env 文件中设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
    supabaseClient = createClient('https://placeholder.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2NDUxOTIwMDAsImV4cCI6MTk2MDc2ODAwMH0.placeholder');
    return supabaseClient;
  }

  supabaseClient = createClient(config.url, config.anonKey, {
    auth: {
      // service-worker 无 localStorage，统一用 chrome.storage.local 持久化 session
      storage: supabaseSharedStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  // 旧 session 迁移（幂等：只搬一次，搬完即删 localStorage 源）
  void migrateLegacySupabaseSession();

  return supabaseClient;
}

// 检查 Supabase 是否已配置
export function isSupabaseConfigured(): boolean {
  const config = getSecureConfig();
  return config !== null;
}

// 检查 Supabase 配置的辅助函数
function checkSupabaseConfig() {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase 配置缺失。请确保在 .env 文件中设置了 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
  }
}

// 导出 supabase 客户端，延迟初始化
export const supabase = initSupabaseClient();

// ── 云端 tombstone（软删）双轨支持 ────────────────────────────────
// 背景：Web 端删除需要跨端一致（扩展端上传不能"复活"已删的云端行）。
// 正确做法是云端 tab_groups 增加 is_deleted 列（软删墓碑），但需要
// Supabase 控制台执行 migration（anon key 无 DDL 权限）：
//   ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;
// 代码侧双轨：探测到列 → 走 tombstone；未探测到 → 回退硬删并给出提示。

let tombstoneSupportCache: boolean | null = null;

/**
 * 探测云端 tab_groups 表是否已有 is_deleted 列（结果缓存）。
 * 探测方式：select 该列 limit 1，列不存在时 Supabase 会返回 PGRST204 错误。
 */
export async function supportsCloudTombstone(): Promise<boolean> {
  if (tombstoneSupportCache !== null) return tombstoneSupportCache;
  if (!isSupabaseConfigured()) {
    tombstoneSupportCache = false;
    return false;
  }
  try {
    const probe = await supabase.from('tab_groups').select('is_deleted').limit(1);
    if (probe.error) {
      if (probe.error.code === 'PGRST204' || /is_deleted/i.test(probe.error.message)) {
        console.warn(
          '[tombstone] 云端 tab_groups 表缺少 is_deleted 列，降级为硬删。\n' +
          '  如需跨端软删一致性，请在 Supabase 控制台 SQL Editor 执行：\n' +
          '  ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;'
        );
        tombstoneSupportCache = false;
      } else {
        // 其他错误（网络等）→ 视为不支持，下次再探
        console.warn('[tombstone] 列探测失败（非 PGRST204）:', probe.error.message);
        tombstoneSupportCache = false;
      }
    } else {
      tombstoneSupportCache = true;
    }
    return tombstoneSupportCache;
  } catch (err) {
    console.warn('[tombstone] 列探测异常，降级为硬删:', (err as Error).message);
    tombstoneSupportCache = false;
    return false;
  }
}

import { secureStorage } from './secureStorage';

// 获取设备ID（使用加密存储）
export const getDeviceId = async (): Promise<string> => {
  try {
    const deviceId = await secureStorage.get<string>('deviceId');
    if (deviceId) return deviceId;

    const newDeviceId = crypto.randomUUID();
    await secureStorage.set('deviceId', newDeviceId);
    return newDeviceId;
  } catch (error) {
    console.error('获取设备ID失败:', error);
    // 降级到普通存储
    const { deviceId } = await chrome.storage.local.get('deviceId');
    if (deviceId) return deviceId;

    const newDeviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: newDeviceId });
    return newDeviceId;
  }
};

// 用户认证相关方法
export const auth = {
  // 使用邮箱注册
  async signUp(email: string, password: string) {
    checkSupabaseConfig();
    return await supabase.auth.signUp({ email, password });
  },

  // 使用邮箱登录
  async signIn(email: string, password: string) {
    checkSupabaseConfig();
    return await supabase.auth.signInWithPassword({ email, password });
  },







  // 退出登录
  async signOut() {
    checkSupabaseConfig();
    return await supabase.auth.signOut();
  },

  // 获取当前用户
  async getCurrentUser() {
    try {
      // 如果配置缺失，直接返回空用户
      if (!isSupabaseConfigured()) {
        return {
          data: { user: null },
          error: null
        };
      }
      // 首先检查是否有活跃会话
      const { data: sessionData } = await supabase.auth.getSession();

      // 如果没有会话，直接返回空用户，不触发错误
      if (!sessionData || !sessionData.session) {
        return {
          data: { user: null },
          error: null
        };
      }

      // 如果有会话，才获取用户信息
      return await supabase.auth.getUser();
    } catch (error) {
      console.error('获取当前用户失败:', error);
      // 返回一个结构化的错误对象
      return {
        data: { user: null },
        error: typeof error === 'string' ? { message: error } : error
      };
    }
  },

  // 获取会话
  async getSession() {
    try {
      // 如果配置缺失，直接返回空会话
      if (!isSupabaseConfigured()) {
        return {
          data: { session: null },
          error: null
        };
      }
      return await supabase.auth.getSession();
    } catch (error) {
      console.error('获取会话失败:', error);
      // 返回一个结构化的错误对象
      return {
        data: { session: null },
        error: typeof error === 'string' ? { message: error } : error
      };
    }
  }
};

// 数据同步相关方法
export const sync = {
  // 迁移数据到 JSONB 格式
  async migrateToJsonb() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    console.log('开始迁移数据到 JSONB 格式，用户ID:', user.id);

    try {
      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        console.error('会话已过期，无法迁移数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 获取用户的所有标签组
      const { data: groups, error } = await supabase
        .from('tab_groups')
        .select('*')
        .eq('user_id', user.id);

      if (error) {
        console.error('获取标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      console.log(`找到 ${groups.length} 个标签组需要迁移`);

      // 对每个标签组进行迁移
      for (const group of groups) {
        // 检查是否已经有 JSONB 数据
        if (group.tabs_data && Array.isArray(group.tabs_data) && group.tabs_data.length > 0) {
          continue;
        }

        // 从 tabs 表获取标签
        const { data: tabs, error: tabError } = await supabase
          .from('tabs')
          .select('*')
          .eq('group_id', group.id as string);

        if (tabError) {
          console.error(`获取标签组 ${group.id} 的标签失败:`, tabError);
          continue; // 跳过这个标签组，继续处理下一个
        }

        if (!tabs || tabs.length === 0) {
          continue;
        }

        // 将标签转换为 TabData 格式
        const tabsData: TabData[] = tabs.map((tab: any) => ({
          id: String(tab.id),
          url: String(tab.url),
          title: String(tab.title),
          favicon: tab.favicon ? String(tab.favicon) : undefined,
          created_at: String(tab.created_at),
          last_accessed: String(tab.last_accessed),
          is_deleted: tab.isDeleted === true ? true : undefined,
        }));

        // 更新标签组，添加 tabs_data 字段
        const { error: updateError } = await supabase
          .from('tab_groups')
          .update({ tabs_data: tabsData })
          .eq('id', group.id as string);

        if (updateError) {
          console.error(`更新标签组 ${group.id} 的 JSONB 数据失败:`, updateError);
          console.error('错误详情:', {
            code: updateError.code,
            message: updateError.message,
            details: updateError.details,
            hint: updateError.hint
          });

          // 检查是否是行级安全策略错误
          if (updateError.message && updateError.message.includes('row-level security policy')) {
            console.error('行级安全策略错误，可能是用户ID不匹配或会话已过期');

            // 重新检查会话和用户信息
            const { data: recheckSession } = await supabase.auth.getSession();
            if (!recheckSession.session) {
              throw new Error('会话已过期，请重新登录');
            }

            const { error: retryError } = await supabase
              .from('tab_groups')
              .update({
                tabs_data: tabsData,
                user_id: recheckSession.session.user.id // 确保用户ID与会话用户ID匹配
              })
              .eq('id', group.id as string);

            if (retryError) {
              console.error(`重试更新标签组 ${group.id} 仍然失败:`, retryError);
            }
          }
        }
      }
      return { success: true, migratedGroups: groups.length };
    } catch (error) {
      console.error('数据迁移失败:', error);
      throw error;
    }
  },
  // 上传标签组
  async uploadTabGroups(groups: TabGroup[], overwriteCloud: boolean = false) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    console.log('准备上传标签组，用户ID:', user.id, '设备ID:', deviceId);
    console.log(`要上传的数据: ${groups.length} 个标签组`);

    // 详细记录每个要上传的标签组
    groups.forEach((group, index) => {
      console.log(`要上传的标签组 ${index + 1}/${groups.length}:`, {
        id: group.id,
        name: group.name,
        tabCount: group.tabs.length,
        updatedAt: group.updatedAt,
        lastSyncedAt: group.lastSyncedAt
      });

      // 记录每个标签组中的标签数量和类型
      const urlTypes = group.tabs.reduce((acc, tab) => {
        const urlType = tab.url.startsWith('http') ? 'http' :
          tab.url.startsWith('loading://') ? 'loading' : 'other';
        acc[urlType] = (acc[urlType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log(`  - 标签类型统计: ${JSON.stringify(urlTypes)}`);
    });

    // 为每个标签组添加用户ID和设备ID
    const currentTime = new Date().toISOString();

    const groupsWithUser = groups.map(group => {
      // 确保必要字段都有值
      const createdAt = group.createdAt || currentTime;
      const updatedAt = group.updatedAt || currentTime;

        // 将标签转换为 TabData 格式
        const tabsData: TabData[] = group.tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          favicon: tab.favicon,
          created_at: tab.createdAt,
          last_accessed: tab.lastAccessed,
          pinned: tab.pinned,
          is_deleted: tab.isDeleted || undefined,
        }));

      // 准备返回对象
      const returnObj = {
        id: group.id,
        name: group.name || 'Unnamed Group',
        created_at: createdAt,
        updated_at: updatedAt,
        is_locked: group.isLocked || false,
        user_id: user.id,
        device_id: deviceId,
        last_sync: currentTime,
        tabs_data: tabsData // 临时存储，稍后会被加密
      };

      return returnObj as SupabaseTabGroup;
    });

    // 检查并去除重复的 ID
    const seenIds = new Set<string>();
    const uniqueGroups = groupsWithUser.filter(group => {
      if (seenIds.has(group.id)) {
        console.warn(`发现重复的标签组 ID: ${group.id}，已跳过`);
        return false;
      }
      seenIds.add(group.id);
      return true;
    });

    if (uniqueGroups.length !== groupsWithUser.length) {
      console.log(`去重后标签组数量: ${uniqueGroups.length}/${groupsWithUser.length}`);
    }

    // 上传标签组元数据和标签数据
    let result: any = null;
    try {
      // 对每个标签组的数据进行加密
      // 安全约束：加密失败的组绝不允许明文上云——宁可本次同步失败重试，
      // 也不能把用户浏览记录以明文写入云端（Web Crypto 不可用等环境会走到这里）
      const encryptionFailedIds: string[] = [];
      for (let i = 0; i < groupsWithUser.length; i++) {
        const group = groupsWithUser[i];
        if (group.tabs_data && Array.isArray(group.tabs_data)) {
          try {
            // 加密标签数据
            const encryptedData = await encryptData(group.tabs_data, user.id);
            // 替换原始数据为加密数据
            groupsWithUser[i].tabs_data = encryptedData as any;
            console.log(`标签组 ${group.id} 的数据已加密`);
          } catch (error) {
            console.error(`加密标签组 ${group.id} 的数据失败:`, error);
            encryptionFailedIds.push(group.id);
          }
        }
      }

      if (encryptionFailedIds.length > 0) {
        throw new Error(
          `${encryptionFailedIds.length} 个标签组加密失败，已中止上传以避免明文上云（组ID: ${encryptionFailedIds.join(', ')}）。请检查浏览器环境是否支持 Web Crypto。`
        );
      }

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

      // 使用 JSONB 存储标签数据
      console.log('将标签数据作为 JSONB 存储到 tab_groups 表中');

      // 记录详细的上传信息
      console.log('上传数据详情:', {
        groupCount: groupsWithUser.length,
        userID: groupsWithUser[0]?.user_id,
        sessionUserID: sessionData.session.user.id,
        sessionValid: !!sessionData.session,
        userValid: !!user
      });

      // 强制确保所有组的用户ID都是会话用户ID
      console.log('强制更新所有组的用户ID为会话用户ID');
      uniqueGroups.forEach((group, index) => {
        const oldUserId = group.user_id;
        group.user_id = sessionData.session.user.id;
        console.log(`标签组 ${index + 1}: ${group.id} 用户ID从 ${oldUserId} 更新为 ${group.user_id}`);
      });

      // 云端有 is_deleted 列时，上传的活跃组显式置 is_deleted=false，
      // 把 Web 端已软删、本地仍活跃（恢复/取消删除）的组复位为活跃
      if (await supportsCloudTombstone()) {
        uniqueGroups.forEach(group => {
          (group as any).is_deleted = false;
        });
      }

      // 验证所有组的用户ID是否正确
      const invalidGroups = uniqueGroups.filter(group => group.user_id !== sessionData.session.user.id);
      if (invalidGroups.length > 0) {
        console.error('仍有标签组的用户ID不正确:', invalidGroups.map(g => ({ id: g.id, user_id: g.user_id })));
        throw new Error('用户ID验证失败，无法上传数据');
      }

      console.log('所有标签组的用户ID验证通过');

      let data, error;

      // 如果是覆盖模式，先删除用户的所有标签组，然后插入新的标签组
      if (overwriteCloud) {
        // 使用覆盖模式

        // 先删除用户的所有标签组
        const { error: deleteError } = await supabase
          .from('tab_groups')
          .delete()
          .eq('user_id', sessionData.session.user.id);

        if (deleteError) {
          console.error('删除用户标签组失败:', deleteError);
          console.error('错误详情:', {
            code: deleteError.code,
            message: deleteError.message,
            details: deleteError.details,
            hint: deleteError.hint
          });
          throw deleteError;
        }

        console.log('用户标签组已删除，准备插入新数据');

        // 等待一小段时间确保删除操作完全完成
        await new Promise(resolve => setTimeout(resolve, 100));

        // 然后插入新的标签组，使用 upsert 而不是 insert 来避免主键冲突
        console.log('准备插入标签组数据，用户ID:', sessionData.session.user.id);
        console.log('要插入的第一个标签组数据样本:', {
          id: uniqueGroups[0]?.id,
          name: uniqueGroups[0]?.name,
          user_id: uniqueGroups[0]?.user_id,
          device_id: uniqueGroups[0]?.device_id,
          tabsDataLength: uniqueGroups[0]?.tabs_data?.length
        });

        const result = await supabase
          .from('tab_groups')
          .upsert(uniqueGroups as any, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      } else {
        // 合并模式，使用 upsert
        // 使用合并模式
        const result = await supabase
          .from('tab_groups')
          .upsert(uniqueGroups as any, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      }

      result = data;

      if (error) {
        console.error('上传标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });

        // 特别处理 RLS 策略错误
        if (error.message && error.message.includes('row-level security policy')) {
          console.error('RLS 策略违规错误，尝试诊断和重试...');

          try {
            const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError) {
              console.error('刷新会话失败:', refreshError);
              throw new Error('会话已过期，请重新登录');
            }

            if (refreshedSession.session && refreshedSession.session.user) {
              // 重新设置用户ID
              uniqueGroups.forEach(group => {
                group.user_id = refreshedSession.session!.user.id;
              });

              // 重试上传
              const retryResult = await supabase
                .from('tab_groups')
                .upsert(uniqueGroups as any, { onConflict: 'id' });

              if (retryResult.error) {
                console.error('重试上传仍然失败:', retryResult.error);
                throw new Error('数据库行级安全策略阻止了数据插入。请联系管理员检查权限配置。');
              }

              data = retryResult.data;
              error = null; // 清除错误
            } else {
              throw new Error('无法获取有效会话，请重新登录');
            }
          } catch (retryError) {
            console.error('重试失败:', retryError);
            throw new Error('数据库行级安全策略阻止了数据插入。请重新登录或联系管理员。');
          }
        }

        throw error;
      }

    } catch (e) {
      console.error('上传标签组时发生异常:', e);
      throw e;
    }
    return { result };
  },

  // 把本地软删的标签组 ID 同步到云端。
  // 双轨：云端有 is_deleted 列 → 置墓碑（保留行，跨端一致性关键）；
  //       无列（未执行 migration）→ 回退硬删，并提示执行 SQL。
  async markCloudGroupsAsDeleted(deletedIds: string[]) {
    if (deletedIds.length === 0) return;

    checkSupabaseConfig();
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      console.warn('[markCloudGroupsAsDeleted] 未登录，跳过');
      return;
    }

    const userId = sessionData.session.user.id;
    console.log(`[markCloudGroupsAsDeleted] 正在标记云端 ${deletedIds.length} 个组为删除`);

    if (await supportsCloudTombstone()) {
      // tombstone：保留行，置 is_deleted=true 并把 updated_at 推新，
      // 让 merge 的版本/时间比较能识别 Web 端的删除意图
      const { error } = await supabase
        .from('tab_groups')
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', deletedIds);

      if (error) {
        console.error('[markCloudGroupsAsDeleted] 标记墓碑失败:', error);
        throw error;
      }

      console.log(`[markCloudGroupsAsDeleted] 已标记 ${deletedIds.length} 个云端组为删除`);
    } else {
      // 降级：硬删云端行（旧的统一做法）
      const { error } = await supabase
        .from('tab_groups')
        .delete()
        .eq('user_id', userId)
        .in('id', deletedIds);

      if (error) {
        console.error('[markCloudGroupsAsDeleted] 删除失败:', error);
        throw error;
      }

      console.log(`[markCloudGroupsAsDeleted] 已删除 ${deletedIds.length} 个云端组`);
    }
  },

  // 下载标签组
  async downloadTabGroups() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    try {

      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        console.error('会话已过期，无法下载数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 记录详细的会话信息
      console.log('会话信息:', {
        userID: user.id,
        sessionUserID: sessionCheck.session.user.id,
        isSessionValid: !!sessionCheck.session
      });

      // 确保用户ID匹配会话用户ID
      if (user.id !== sessionCheck.session.user.id) {
        console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
        user.id = sessionCheck.session.user.id;
      }

      // 获取用户的所有标签组，包含 tabs_data JSONB 字段，按创建时间倒序排列
      const { data: groups, error } = await supabase
        .from('tab_groups')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('获取标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      console.log(`从云端获取到 ${groups.length} 个标签组`);

      // 记录每个云端标签组的基本信息
      groups.forEach((group: any, index) => {
        const tabsData = (group.tabs_data || []) as TabData[];
        console.log(`云端标签组 ${index + 1}/${groups.length}:`, {
          id: group.id,
          name: group.name,
          tabCount: tabsData.length,
          deviceId: group.device_id,
          updatedAt: group.updated_at,
          lastSync: group.last_sync
        });
      });

      // 将数据转换为应用格式
      const tabGroups: TabGroup[] = [];

      for (const group of groups) {
        // 从 JSONB 字段获取标签数据
        let tabsData: TabData[] = [];
        const groupAny = group as any;

        // 检查是否是加密数据
        if (typeof groupAny.tabs_data === 'string') {
          try {
            // 尝试解密数据
            tabsData = await decryptData<TabData[]>(groupAny.tabs_data as string, user.id);
            console.log(`标签组 ${groupAny.id} 的数据已成功解密`);
          } catch (error) {
            console.error(`解密标签组 ${groupAny.id} 的数据失败:`, error);
            // 如果解密失败，尝试直接解析（可能是旧的未加密数据）
            try {
              if (typeof groupAny.tabs_data === 'string' && !isEncrypted(groupAny.tabs_data)) {
                tabsData = JSON.parse(groupAny.tabs_data);
                console.log(`标签组 ${groupAny.id} 的数据是旧的未加密格式，已成功解析`);
              }
            } catch (jsonError) {
              console.error(`解析标签组 ${groupAny.id} 的JSON数据失败:`, jsonError);
              // 保持空数组
            }
          }
        } else if (Array.isArray(groupAny.tabs_data)) {
          // 如果已经是数组，直接使用
          tabsData = groupAny.tabs_data as TabData[];
          // 数据已是数组格式
        }

        // 处理标签组数据

        // 将 TabData 转换为 Tab 格式
        const formattedTabs = tabsData.map((tab: TabData) => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          favicon: tab.favicon,
          createdAt: tab.created_at,
          lastAccessed: tab.last_accessed,
          group_id: String(groupAny.id),
          pinned: tab.pinned ?? false,
          isDeleted: tab.is_deleted === true ? true : undefined,
        }));

        tabGroups.push({
          id: String(groupAny.id),
          name: String(groupAny.name),
          tabs: formattedTabs,
          createdAt: String(groupAny.created_at),
          updatedAt: String(groupAny.updated_at),
          isLocked: Boolean(groupAny.is_locked),
          // 云端 tombstone：is_deleted 列存在时才有值；无列时 undefined → 视为未删除
          isDeleted: Boolean(groupAny.is_deleted),
        });
      }

      // 兼容性处理：如果标签组没有 tabs_data，尝试从 tabs 表获取
      for (const group of tabGroups) {
        if (group.tabs.length === 0) {
          try {
            const { data: tabs, error: tabError } = await supabase
              .from('tabs')
              .select('*')
              .eq('group_id', group.id as string);

            if (!tabError && tabs && tabs.length > 0) {
              group.tabs = tabs.map((tab: any) => ({
                id: String(tab.id),
                url: String(tab.url),
                title: String(tab.title),
                favicon: tab.favicon ? String(tab.favicon) : undefined,
                createdAt: String(tab.created_at),
                lastAccessed: String(tab.last_accessed),
                group_id: tab.group_id ? String(tab.group_id) : undefined,
                pinned: tab.pinned ?? false,
              }));
            }
          } catch (e) {
            console.warn(`从 tabs 表获取标签失败，忽略错误:`, e);
          }
        }
      }

      return tabGroups;
    } catch (error) {
      console.error('下载标签组失败:', error);
      throw error;
    }
  },

  // 上传用户设置
  async uploadSettings(settings: UserSettings) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    // 上传用户设置

    // 定义允许的设置字段，避免上传不存在的字段
    // 这些字段名对应数据库中的实际列名（驼峰命名，稍后会转换为下划线命名）
    const allowedFields = [
      // 'autoSave',              // -> auto_save (UserSettings中不存在，已注释)
      // 'autoSaveInterval',      // -> auto_save_interval (UserSettings中不存在，已注释)
      'groupNameTemplate',     // -> group_name_template
      'showFavicons',          // -> show_favicons
      'showTabCount',          // -> show_tab_count
      // 'autoCloseTabs',         // -> auto_close_tabs (UserSettings中不存在，已注释)
      'confirmBeforeDelete',   // -> confirm_before_delete
      'allowDuplicateTabs',    // -> allow_duplicate_tabs
      // 'syncInterval',          // -> sync_interval (UserSettings中不存在，已注释)
      'syncEnabled',           // -> sync_enabled
      'layoutMode',            // -> layout_mode
      'showNotifications',     // -> show_notifications
      'syncStrategy',          // -> sync_strategy
      'deleteStrategy',        // -> delete_strategy
      'themeMode',             // -> theme_mode
      'themeStyle',            // -> theme_style
      'collectPinnedTabs',     // -> collect_pinned_tabs
      'reorderMode'            // -> reorder_mode
    ];

    // 将驼峰命名法转换为下划线命名法，并过滤掉不允许的字段
    const convertedSettings: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
      // 只处理允许的字段
      if (allowedFields.includes(key)) {
        // 将驼峰命名转换为下划线命名
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        convertedSettings[snakeKey] = value;
      } else {
        console.warn(`跳过未知的设置字段: ${key}`);
      }
    }

    console.log('转换后的设置:', convertedSettings);

    const payload = {
      user_id: user.id,
      device_id: deviceId, // 添加设备ID，用于过滤自己设备的更新
      last_sync: new Date().toISOString(),
      ...convertedSettings, // 使用转换后的设置
    };

    const doUpsert = async (body: Record<string, any>) => {
      return await supabase
        .from('user_settings')
        .upsert(body, { onConflict: 'user_id' });
    };

    let { data, error } = await doUpsert(payload);

    // 兼容：云端尚未加列 collect_pinned_tabs 时，不阻塞其他设置同步
    if (error) {
      // 检查是否是 PostgreSQL 的 undefined_column 错误（错误码 42703）
      const errorCode = (error as any)?.code;
      const message = (error as any)?.message || '';
      const details = (error as any)?.details || '';
      const hint = (error as any)?.hint || '';
      const combined = `${message} ${details} ${hint}`.toLowerCase();

      // 更精确的列不存在检查
      const isUndefinedColumn = errorCode === '42703';
      const mentionsCollectPinned = combined.includes('collect_pinned_tabs');

      if (isUndefinedColumn && mentionsCollectPinned) {
        console.warn('[Supabase] user_settings 缺少 collect_pinned_tabs 列，已降级重试（忽略该字段）');
        const { collect_pinned_tabs: unusedCollectPinnedTabs, ...fallback } = payload as any;
        void unusedCollectPinnedTabs;
        ({ data, error } = await doUpsert(fallback));
      }
    }

    if (error) {
      console.error('上传用户设置失败:', error);
      console.error('错误详情:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }

    return data;
  },

  // 下载用户设置
  async downloadSettings() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    // 下载用户设置

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('下载用户设置失败:', error);
      console.error('错误详情:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }

    // 如果有数据，将下划线命名法转换为驼峰命名法
    if (data) {
      // 定义允许的数据库字段到设置字段的映射
      const fieldMapping: Record<string, string> = {
        'group_name_template': 'groupNameTemplate',
        'show_favicons': 'showFavicons',
        'show_tab_count': 'showTabCount',
        'confirm_before_delete': 'confirmBeforeDelete',
        'allow_duplicate_tabs': 'allowDuplicateTabs',
        'sync_enabled': 'syncEnabled',
        'layout_mode': 'layoutMode',
        'show_notifications': 'showNotifications',
        'sync_strategy': 'syncStrategy',
        'delete_strategy': 'deleteStrategy',
        'theme_mode': 'themeMode',
        'theme_style': 'themeStyle',
        'collect_pinned_tabs': 'collectPinnedTabs',
        'reorder_mode': 'reorderMode',
        // 向后兼容性：如果云端还有旧的字段，也要处理
        'use_double_column_layout': 'useDoubleColumnLayout'
      };

      const convertedSettings: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        // 跳过非设置字段
        if (['user_id', 'device_id', 'last_sync'].includes(key)) {
          continue;
        }

        // 使用映射表转换字段名
        if (fieldMapping[key]) {
          convertedSettings[fieldMapping[key]] = value;
        } else {
          console.warn(`跳过未知的数据库字段: ${key}`);
        }
      }

      return convertedSettings;
    }

    return data;
  }
};
