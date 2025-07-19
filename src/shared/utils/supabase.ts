import { createClient } from '@supabase/supabase-js';
import { TabGroup, UserSettings, TabData, SupabaseTabGroup } from '@/types/tab';
import { setWechatLoginTimeout, clearWechatLoginTimeout } from './wechatLoginTimeout';
import { encryptData, decryptData, isEncrypted } from './encryptionUtils';
import { logError, createErrorMessage } from './errorUtils';

// 从环境变量中获取 Supabase 配置
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// 检查环境变量是否存在
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('错误: Supabase 配置缺失。请确保在 .env 文件中设置了 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
} else {
  console.log('✅ Supabase 配置已加载:', {
    url: SUPABASE_URL,
    keyLength: SUPABASE_ANON_KEY?.length
  });
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 网络诊断工具
export const networkDiagnostics = {
  async testSupabaseConnection(): Promise<{
    success: boolean;
    error?: string;
    details: any;
  }> {
    try {
      console.log('🔍 开始Supabase网络诊断...');

      // 测试基本连接
      const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });

      const details = {
        url: SUPABASE_URL,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries())
      };

      console.log('🔍 Supabase连接测试结果:', details);

      return {
        success: response.ok,
        details
      };

    } catch (error: any) {
      console.error('🔍 Supabase连接测试失败:', error);
      return {
        success: false,
        error: error.message,
        details: {
          errorType: error.constructor.name,
          message: error.message
        }
      };
    }
  }
};

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
    console.log('🔐 开始Supabase登录:', { email, supabaseUrl: SUPABASE_URL });
    try {
      const result = await supabase.auth.signInWithPassword({ email, password });
      console.log('🔐 Supabase登录结果:', {
        success: !result.error,
        error: result.error?.message,
        hasUser: !!result.data?.user,
        hasSession: !!result.data?.session
      });
      return result;
    } catch (error) {
      console.error('🔐 Supabase登录异常:', error);
      throw error;
    }
  },

  // 使用第三方登录
  async signInWithOAuth(provider: 'google' | 'github' | 'wechat') {
    // 如果是微信登录，使用特殊处理
    if (provider === 'wechat') {
      return await this.signInWithWechat();
    }

    // 其他第三方登录
    return await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: chrome.identity.getRedirectURL(),
        queryParams: provider === 'google' ? {
          access_type: 'offline',
          prompt: 'consent',
        } : undefined
      }
    });
  },

  // 微信扫码登录
  async signInWithWechat() {
    try {
      // 创建一个新标签页显示微信二维码
      const qrCodeUrl = await this.getWechatQrCodeUrl();
      console.log('打开微信扫码登录页面:', qrCodeUrl);
      const qrCodeTab = await chrome.tabs.create({ url: qrCodeUrl });

      // 设置登录超时处理
      if (qrCodeTab.id) {
        // 将超时处理器ID存储到本地
        const timeoutId = setWechatLoginTimeout(qrCodeTab.id);
        await chrome.storage.local.set({ 'wechat_login_timeout_id': timeoutId });
      }

      // 返回一个空的成功结果，实际的登录处理会在回调中完成
      return {
        data: {
          provider: 'wechat',
          tabId: qrCodeTab.id
        },
        error: null
      };
    } catch (error) {
      console.error('微信扫码登录错误:', error);
      return {
        data: null,
        error: {
          message: '创建微信扫码登录页面失败'
        }
      };
    }
  },

  // 获取微信二维码URL
  async getWechatQrCodeUrl() {
    // 在实际应用中，这里应该调用你的后端API获取微信登录二维码URL
    // 实际实现时，应该先在微信开放平台注册应用，获取AppID和AppSecret

    // 生成随机状态码用于验证回调
    const state = this.generateRandomState();

    // 获取重定向URL
    const redirectUrl = encodeURIComponent(chrome.identity.getRedirectURL());

    // 保存state用于验证回调
    await chrome.storage.local.set({ 'wechat_oauth_state': state });

    // 记录开始登录时间，用于计算超时
    await chrome.storage.local.set({ 'wechat_login_start_time': Date.now() });

    // 返回微信登录页面URL
    return chrome.runtime.getURL(`src/pages/wechat-login.html?redirect_uri=${redirectUrl}&state=${state}`);
  },

  // 处理微信登录回调
  async handleWechatCallback(url: string) {
    try {
      // 清除登录超时处理
      const { wechat_login_timeout_id } = await chrome.storage.local.get('wechat_login_timeout_id');
      if (wechat_login_timeout_id) {
        clearWechatLoginTimeout(wechat_login_timeout_id);
        await chrome.storage.local.remove('wechat_login_timeout_id');
      }

      // 从回调URL中提取参数
      // 安全地处理URL分割
      const hashPart = url.includes('#') ? url.split('#')[1] : '';
      const hashParams = new URLSearchParams(hashPart);
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      const state = hashParams.get('state');

      // 获取存储的state进行验证
      const { wechat_oauth_state } = await chrome.storage.local.get('wechat_oauth_state');

      // 验证state是否匹配
      if (state !== wechat_oauth_state) {
        throw new Error('State验证失败，可能存在安全风险');
      }

      // 清除存储的state
      await chrome.storage.local.remove('wechat_oauth_state');
      await chrome.storage.local.remove('wechat_login_start_time');

      // 在实际应用中，这里应该使用获取到的code来请求微信的access_token
      // 然后使用access_token获取用户信息
      // 这里我们模拟这个过程

      if (!accessToken || !refreshToken) {
        throw new Error('未能从回调URL中获取令牌');
      }

      // 模拟设置会话
      // 在实际应用中，这里应该调用Supabase的API来设置会话
      return await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
    } catch (error) {
      console.error('处理微信回调错误:', error);
      throw error;
    }
  },

  // 生成随机state用于防止CSRF攻击
  generateRandomState() {
    // 使用加密安全的随机数生成
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    
    // 转换为十六进制字符串
    const randomHex = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    
    // 添加时间戳
    const timestamp = Date.now().toString(36);
    
    return `${randomHex}${timestamp}`;
  },

  // 处理OAuth回调
  async handleOAuthCallback(url: string) {
    // 检查是否是微信登录回调
    if (url.includes('wechat-login.html')) {
      console.log('检测到微信登录回调');
      return await this.handleWechatCallback(url);
    }

    // 处理其他OAuth回调
    // 从URL中提取token
    // 安全地处理URL分割
    const hashPart = url.includes('#') ? url.split('#')[1] : '';
    const hashParams = new URLSearchParams(hashPart);
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    if (!accessToken || !refreshToken) {
      throw new Error('未能从回调URL中获取令牌');
    }

    // 设置会话
    return await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
  },

  // 退出登录
  async signOut() {
    return await supabase.auth.signOut();
  },

  // 获取当前用户
  async getCurrentUser() {
    try {
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
          console.log(`标签组 ${group.id} 已经有 JSONB 数据，跳过`);
          continue;
        }

        // 从 tabs 表获取标签
        const { data: tabs, error: tabError } = await supabase
          .from('tabs')
          .select('*')
          .eq('group_id', group.id);

        if (tabError) {
          console.error(`获取标签组 ${group.id} 的标签失败:`, tabError);
          continue; // 跳过这个标签组，继续处理下一个
        }

        if (!tabs || tabs.length === 0) {
          console.log(`标签组 ${group.id} 没有标签，跳过`);
          continue;
        }

        console.log(`标签组 ${group.id} 有 ${tabs.length} 个标签需要迁移`);

        // 将标签转换为 TabData 格式
        const tabsData: TabData[] = tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          favicon: tab.favicon,
          created_at: tab.created_at,
          last_accessed: tab.last_accessed
        }));

        // 更新标签组，添加 tabs_data 字段
        const { error: updateError } = await supabase
          .from('tab_groups')
          .update({ tabs_data: tabsData })
          .eq('id', group.id);

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

            console.log('尝试使用会话用户ID重新更新标签组');
            const { error: retryError } = await supabase
              .from('tab_groups')
              .update({
                tabs_data: tabsData,
                user_id: recheckSession.session.user.id // 确保用户ID与会话用户ID匹配
              })
              .eq('id', group.id);

            if (retryError) {
              console.error(`重试更新标签组 ${group.id} 仍然失败:`, retryError);
            } else {
              console.log(`重试成功，标签组 ${group.id} 的数据已成功迁移到 JSONB 格式`);
            }
          }
        } else {
          console.log(`标签组 ${group.id} 的数据已成功迁移到 JSONB 格式`);
        }
      }

      console.log('数据迁移完成');
      return { success: true, migratedGroups: groups.length };
    } catch (error) {
      console.error('数据迁移失败:', error);
      throw error;
    }
  },
  // 上传标签组
  async uploadTabGroups(groups: TabGroup[], overwriteCloud: boolean = false) {
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
        last_accessed: tab.lastAccessed
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

    // 上传标签组元数据和标签数据
    let result: any = null;
    try {
      // 对每个标签组的数据进行加密
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
            // 如果加密失败，保留原始数据
          }
        }
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

      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        console.error('会话已过期，无法上传数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 记录详细的上传信息
      console.log('上传数据详情:', {
        groupCount: groupsWithUser.length,
        userID: groupsWithUser[0]?.user_id,
        sessionUserID: sessionCheck.session.user.id
      });

      // 确保用户ID匹配会话用户ID
      if (groupsWithUser.length > 0 && groupsWithUser[0].user_id !== sessionCheck.session.user.id) {
        console.error('用户ID不匹配:', {
          dataUserID: groupsWithUser[0].user_id,
          sessionUserID: sessionCheck.session.user.id
        });

        // 更新所有组的用户ID为会话用户ID
        groupsWithUser.forEach(group => {
          group.user_id = sessionCheck.session.user.id;
        });

        console.log('已更新所有组的用户ID为会话用户ID');
      }

      let data, error;

      // 覆盖模式：使用 upsert 和 delete 的组合，避免并发问题
      if (overwriteCloud) {
        console.log('使用覆盖模式，同步删除和更新标签组');

        // 获取当前云端所有标签组ID
        const { data: existingGroups, error: fetchError } = await supabase
          .from('tab_groups')
          .select('id')
          .eq('user_id', sessionCheck.session.user.id);

        if (fetchError) {
          console.error('获取现有标签组失败:', fetchError);
          throw fetchError;
        }

        // 当前要同步的标签组ID
        const newGroupIds = groupsWithUser.map(g => g.id);
        
        // 找到需要删除的标签组（云端有但本地没有的）
        const existingGroupIds = existingGroups?.map(g => g.id) || [];
        const groupsToDelete = existingGroupIds.filter(id => !newGroupIds.includes(id));

        // 删除不再存在的标签组
        if (groupsToDelete.length > 0) {
          console.log(`删除 ${groupsToDelete.length} 个已不存在的标签组:`, groupsToDelete);
          
          try {
            const { error: deleteError } = await supabase
              .from('tab_groups')
              .delete()
              .in('id', groupsToDelete);

            if (deleteError) {
              console.error('删除标签组失败:', deleteError);
              throw deleteError;
            }
            
            console.log('✅ 标签组删除成功，应该触发实时通知给其他设备');
          } catch (error) {
            console.error('❌ 删除标签组时发生异常:', error);
            throw error;
          }
        } else {
          console.log('ℹ️ 没有需要删除的标签组');
        }

        // 使用 upsert 更新/插入标签组
        const result = await supabase
          .from('tab_groups')
          .upsert(groupsWithUser, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      } else {
        // 合并模式，使用 upsert
        console.log('使用合并模式，更新现有标签组');
        const result = await supabase
          .from('tab_groups')
          .upsert(groupsWithUser, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      }

      result = data;

      if (error) {
        logError('上传标签组失败', error);
        throw new Error(createErrorMessage('上传标签组失败', error));
      }

      console.log('标签组元数据和标签数据上传成功');
    } catch (e) {
      logError('上传标签组时发生异常', e);
      throw new Error(createErrorMessage('上传标签组时发生异常', e));
    }

    console.log('所有数据上传成功');
    return { result };
  },

  // 下载标签组
  async downloadTabGroups() {
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

    console.log('开始下载标签组，用户ID:', user.id, '设备ID:', deviceId);

    try {
      console.log('使用 JSONB 方式下载所有标签组');

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

      // 获取用户的所有标签组，包含 tabs_data JSONB 字段
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

      console.log(`从云端获取到 ${groups.length} 个标签组`);

      // 将数据转换为应用格式
      const tabGroups: TabGroup[] = [];

      for (const group of groups) {
        // 从 JSONB 字段获取标签数据
        let tabsData: TabData[] = [];

        // 检查是否是加密数据
        if (typeof group.tabs_data === 'string') {
          try {
            // 尝试解密数据
            tabsData = await decryptData<TabData[]>(group.tabs_data as string, user.id);
            console.log(`标签组 ${group.id} 的数据已成功解密`);
          } catch (error) {
            console.error(`解密标签组 ${group.id} 的数据失败:`, error);
            // 如果解密失败，尝试直接解析（可能是旧的未加密数据）
            try {
              if (typeof group.tabs_data === 'string' && !isEncrypted(group.tabs_data)) {
                tabsData = JSON.parse(group.tabs_data);
                console.log(`标签组 ${group.id} 的数据是旧的未加密格式，已成功解析`);
              }
            } catch (jsonError) {
              console.error(`解析标签组 ${group.id} 的JSON数据失败:`, jsonError);
              // 保持空数组
            }
          }
        } else if (Array.isArray(group.tabs_data)) {
          // 如果已经是数组，直接使用
          tabsData = group.tabs_data;
          console.log(`标签组 ${group.id} 的数据已经是解析后的数组格式`);
        }

        // 移除了详细的标签数据日志

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

        tabGroups.push({
          id: group.id,
          name: group.name,
          tabs: formattedTabs,
          createdAt: group.created_at,
          updatedAt: group.updated_at,
          isLocked: group.is_locked
        });
      }

      // 兼容性处理：如果标签组没有 tabs_data，尝试从 tabs 表获取
      for (const group of tabGroups) {
        if (group.tabs.length === 0) {
          console.log(`标签组 ${group.id} 没有 JSONB 标签数据，尝试从 tabs 表获取`);
          try {
            const { data: tabs, error: tabError } = await supabase
              .from('tabs')
              .select('*')
              .eq('group_id', group.id);

            if (!tabError && tabs && tabs.length > 0) {
              group.tabs = tabs.map(tab => ({
                id: tab.id,
                url: tab.url,
                title: tab.title,
                favicon: tab.favicon,
                createdAt: tab.created_at,
                lastAccessed: tab.last_accessed,
                group_id: tab.group_id
              }));
              console.log(`从 tabs 表获取到 ${group.tabs.length} 个标签`);
            }
          } catch (e) {
            console.warn(`从 tabs 表获取标签失败，忽略错误:`, e);
          }
        }
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

    console.log('上传用户设置，用户ID:', user.id, '设备ID:', deviceId);

    // 将驼峰命名法转换为下划线命名法
    const convertedSettings: Record<string, any> = {};
    
    // 定义允许同步的设置字段白名单（仅确认存在的字段）
    const allowedSettingsFields = [
      'syncEnabled',
      'syncInterval',
      'themeMode'
    ];
    
    // 暂时移除 autoSyncEnabled，因为数据库中不存在该字段
    
    for (const [key, value] of Object.entries(settings)) {
      // 只处理白名单中的字段
      if (allowedSettingsFields.includes(key)) {
        // 将驼峰命名转换为下划线命名
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        
        // 数据验证：确保值不是 undefined 或 null
        if (value !== undefined && value !== null) {
          convertedSettings[snakeKey] = value;
        }
      }
    }

    console.log('转换后的设置:', convertedSettings);
    console.log('准备上传的数据:', JSON.stringify({
      user_id: user.id,
      device_id: deviceId,
      last_sync: new Date().toISOString(),
      ...convertedSettings
    }, null, 2));

    const { data, error } = await supabase
      .from('user_settings')
      .upsert({
        user_id: user.id,
        device_id: deviceId, // 添加设备ID，用于过滤自己设备的更新
        last_sync: new Date().toISOString(),
        ...convertedSettings // 使用转换后的设置
      }, { onConflict: 'user_id' });

    if (error) {
      logError('上传用户设置失败', error);
      throw new Error(createErrorMessage('上传用户设置失败', error));
    }

    return data;
  },

  // 下载用户设置
  async downloadSettings() {
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

    console.log('下载用户设置，用户ID:', user.id);

    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      logError('下载用户设置失败', error);
      throw new Error(createErrorMessage('下载用户设置失败', error));
    }

    // 如果有数据，将下划线命名法转换为驼峰命名法
    if (data) {
      const convertedSettings: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        // 跳过非设置字段
        if (['user_id', 'device_id', 'last_sync'].includes(key)) {
          continue;
        }

        // 将下划线命名转换为驼峰命名
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        convertedSettings[camelKey] = value;
      }

      console.log('转换后的设置:', convertedSettings);
      return convertedSettings;
    }

    return data;
  }
};
