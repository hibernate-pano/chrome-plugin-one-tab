/**
 * S3 拆分 · auth：邮箱注册/登录/登出与会话读取。
 * （原 src/utils/supabase.ts 对应节逐字搬运；行为零变化。）
 */
import { supabase, checkSupabaseConfig, isSupabaseConfigured } from './client';
import { logError } from '../log';
import { readSessionSafely, SESSION_READ_DEADLINE_MS } from './sessionRead';
import { withDeadline } from '../deadline';

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
      //
      // ── 2026-10-23（第 51 轮）：这里必须走**读会话的唯一入口** ──────────
      // 原先这里**裸调** `supabase.auth.getSession()` ⇒ 它绕过了
      // `sessionRead.ts` 的三道闸门（先问「云端在吗」/ 5 秒上限 / 原样带出失败）：
      //   · 云端不可用时它照样去碰 SDK ⇒ 本轮要消灭的那场「会话被删」照样发生；
      //   · 弱网时它能挂到 45 秒（SDK 自带的 fetch 超时）。
      // 而**调用方**（store/slices/authSlice.ts）自己也走了一遍那个入口
      // ⇒ 两次调用之间会话可能已经过期 ⇒ 第二次（这里）会**重新触发一次
      // 没有闸门的刷新** —— 那正是本轮要消灭的动作。
      // ⇒ 现在走同一个入口：闸门在**每一层**都生效。
      const { data: sessionData, error: sessionError } = await readSessionSafely(
        () => supabase.auth.getSession(),
        '读取会话',
      );

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
      //
      // ⚠️ 这一句也必须有上限（2026-10-23，第 51 轮）：`getUser()` 会打
      // `/auth/v1/user`，SDK 自带的 fetch 超时是 45 秒 ⇒ 弱网时整段
      // 「核对登录态」能拖 45 秒（弹窗那 30 秒的协议上界直接被击穿）。
      // ⇒ 与读会话用**同一个**上限（不许另写一个数字）。
      return await withDeadline(
        supabase.auth.getUser(),
        SESSION_READ_DEADLINE_MS,
        '核对用户信息',
      );
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
  //
  // ⚠️ **这个方法是「裸」的**（2026-10-23，第 51 轮）：它**不**自己走
  // 「读会话的唯一入口」（`sessionRead.ts` 的 readSessionSafely）。
  // ⇒ **调用方必须自己包一层**（现存唯一的调用方 `store/slices/authSlice.ts`
  // 就是这么做的：`f.readSessionSafely(() => f.auth.getSession(), '读取会话')`）。
  //
  // 为什么不在这里就包上：这一层包上之后，调用方那层会变成**双层闸门**
  // （两次 5 秒上限、两道探活）⇒ 总等待不再有界。
  // ⇒ 约定：**入口只有一处**，调用方包，底层不包。
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
