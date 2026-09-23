/**
 * S3 拆分 · auth：邮箱注册/登录/登出与会话读取。
 * （原 src/utils/supabase.ts 对应节逐字搬运；行为零变化。）
 */
import { supabase, checkSupabaseConfig, isSupabaseConfigured } from './client';

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
