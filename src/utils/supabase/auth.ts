/**
 * S3 拆分 · auth：邮箱注册/登录/登出与会话读取。
 * （原 src/utils/supabase.ts 对应节逐字搬运；行为零变化。）
 */
import { supabase, checkSupabaseConfig, isSupabaseConfigured } from './client';
import { logError } from '../log';

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
      // ── 2026-10-23（第 50 轮）：读会话**失败**不许被吞成「没登录」──────
      // 原先这里 `const { data: sessionData } = await supabase.auth.getSession();`
      // **只取 data、丢掉 error** ⇒ 刷新失败（断网 / 402 / 刷新令牌被吊销）
      // 时 session 是 null、error 被丢掉 ⇒ 这一层返回 `{user:null, error:null}`
      // ⇒ 上游读成「服务端明确说没有会话」⇒ 界面说「未登录」+ 清掉本机缓存。
      //
      // 现在把 error **原样带出去**：它决定「为什么没有会话」，
      // 而那正是后面该说「请重新登录」还是「现在联系不上云端」的唯一依据
      // （判据见 core/sessionFailure.ts）。
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) {
        logError('读取会话失败:', sessionError);
        return {
          data: { user: null },
          error: sessionError
        };
      }

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
      logError('获取当前用户失败:', error);
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
      logError('获取会话失败:', error);
      // 返回一个结构化的错误对象
      return {
        data: { session: null },
        error: typeof error === 'string' ? { message: error } : error
      };
    }
  }
};
