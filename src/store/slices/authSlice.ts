import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import { auth as supabaseAuth } from '@/utils/supabaseFacade';
import { authCache } from '@/utils/authCache';
import { logError, logInfo } from '../../utils/log';

/* ── 认证错误的中文化（2026-10-20 审计 C-07）───────────────────────────────
 *
 * 缺陷：登录 / 注册失败时，界面直接把 Supabase 的英文原文弹给用户
 * （`Invalid login credentials` / `User already registered` / `Email not confirmed`）。
 * 全中文界面里冒出英文机器串：用户看不懂，也分不清是自己输错了还是服务出问题了。
 *
 * 口径（**原始英文只进 console 日志，不进 UI**）：
 *   1. 命中已知模式 ⇒ 对应的中文说明；
 *   2. 原文本来就是中文 ⇒ 原样透传（别把已经翻译好的说明再翻一遍）；
 *   3. 都不命中 ⇒ 通用中文兜底，**绝不**把英文原文透给用户。
 *
 * 之所以放在 slice 这一层而不是 LoginForm / RegisterForm：那两个组件是纯展示层，
 * 错误文案的真源应该与「错误从哪来」同处一地；组件拿到的已经是中文。
 */

/** 是否含中日韩统一表意文字（用来判断「原文已经是中文」）。 */
const HAS_CJK = /[一-鿿]/;

/**
 * 已知错误模式 → 中文文案。
 *
 * 用模式匹配而不是精确等值：Supabase 的文案随版本微调（大小写、标点、
 * 前缀），精确等值等于赌它永远不变——赌输了就把英文原文漏进界面。
 */
const AUTH_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid login credentials/i, '邮箱或密码不正确'],
  [/user already registered/i, '该邮箱已注册，请直接登录'],
  [/email not confirmed/i, '邮箱尚未完成验证，请先到邮箱点击验证链接后再登录'],
  [/password should be at least\s*(\d+)/i, '密码至少需要 $1 位'],
  [/unable to validate email address/i, '邮箱地址无法通过校验，请检查后重试'],
  [/invalid email|email address .* invalid/i, '邮箱地址格式不正确'],
  [/email rate limit exceeded|too many requests|rate limit/i, '操作太频繁，请稍后再试'],
  [/signups? not allowed|signup is disabled/i, '当前未开放注册，请直接登录已有账号'],
  [/failed to fetch|network\s*error|networkerror|load failed/i, '网络连接失败，请检查网络后重试'],
];

/**
 * 原始错误消息 → 用户可读的中文文案。
 *
 * 纯函数（不打日志）：原始消息的落盘由调用方负责，本函数只负责翻译。
 *
 * @param raw 原始错误消息（Supabase 英文原文或已翻译的中文）
 * @param fallback 无法识别时的中文兜底
 */
export const authErrorCopy = (
  raw: string | undefined | null,
  fallback = '操作失败，请稍后重试'
): string => {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  // 已经是中文 → 原样透传（幂等：重复调用不会二次翻译）
  if (HAS_CJK.test(text)) return text;
  for (const [pattern, copy] of AUTH_ERROR_PATTERNS) {
    const matched = text.match(pattern);
    if (matched) {
      return copy.replace(/\$(\d+)/g, (_, n: string) => matched[Number(n)] ?? n);
    }
  }
  // 未识别的英文 ⇒ 兜底，**不**把原文透给用户
  return fallback;
};

/** 从 Supabase 的 error 对象里取出 message（形状不稳定，取不到就返回 undefined）。 */
const supabaseErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
};

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
};

export const signUp = createAsyncThunk(
  'auth/signUp',
  async ({ email, password }: { email: string; password: string }) => {
    try {
      const { data, error } = await supabaseAuth.signUp(email, password);
      if (error) {
        logError('注册错误:', error);
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '注册失败，请稍后重试'));
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('注册失败，请稍后重试');
    } catch (err) {
      logError('注册异常:', err);
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '注册失败，请稍后重试'));
      } else {
        throw new Error('注册失败，请稍后重试');
      }
    }
  }
);

export const signIn = createAsyncThunk(
  'auth/signIn',
  async ({ email, password }: { email: string; password: string }) => {
    try {
      const { data, error } = await supabaseAuth.signIn(email, password);
      if (error) {
        logError('登录错误:', error);
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '登录失败，请稍后重试'));
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('登录失败，请稍后重试');
    } catch (err) {
      logError('登录异常:', err);
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '登录失败，请稍后重试'));
      } else {
        throw new Error('登录失败，请稍后重试');
      }
    }
  }
);





export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    try {
      // 移除实时同步功能，简化逻辑
      logInfo('已简化同步逻辑，只保留手动同步功能');

      // 退出登录
      const { error } = await supabaseAuth.signOut();
      if (error) {
        logError('退出登录错误:', error);
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '退出登录失败，请稍后重试'));
      }

      logInfo('退出登录成功');
      return null;
    } catch (err) {
      logError('退出登录异常:', err);
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '退出登录失败，请稍后重试'));
      } else {
        throw new Error('退出登录失败，请稍后重试');
      }
    }
  }
);

export const getCurrentUser = createAsyncThunk(
  'auth/getCurrentUser',
  async () => {
    try {
      // 首先检查是否有活跃会话，避免未登录用户触发错误
      const { data: sessionData } = await supabaseAuth.getSession();

      // 如果没有会话，直接返回 null，不触发错误
      if (!sessionData || !sessionData.session) {
        logInfo('没有活跃会话，用户未登录');
        return null;
      }

      // 如果有会话，才获取用户信息
      const { data, error } = await supabaseAuth.getCurrentUser();
      if (error) {
        logError('获取用户信息错误:', error);
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '获取用户信息失败，请稍后重试'));
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      return null;
    } catch (err) {
      logError('获取用户信息异常:', err);
      // 确保返回一个字符串错误消息，而不是对象
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '获取用户信息失败，请稍后重试'));
      } else {
        throw new Error('获取用户信息失败，请稍后重试');
      }
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },

    // 从缓存设置认证状态
    setFromCache: (state, action) => {
      state.user = action.payload.user;
      state.isAuthenticated = action.payload.isAuthenticated;
      state.isLoading = false;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // 注册
      .addCase(signUp.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(signUp.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        // ⚠️ **注册不等于登录**：signUp 只回一个账号记录（data.user），本机并没有会话。
        // 原先这里把 isAuthenticated 一起置真 ⇒ 邮箱待确认（或自动登录失败）时，顶栏立刻
        // 显示「退出登录」、同步按钮解锁，而注册表单那边正说「自动登录失败，请手动登录」——
        // 同一屏两种事实。登录态只由 signIn.fulfilled 建立（它还会写 authCache；
        // signUp 这条路径从来没写过缓存，所以那个假的「已登录」刷新后又会自己消失）。
      })
      .addCase(signUp.rejected, (state, action) => {
        state.isLoading = false;
        // 原始英文只留在 thunk 里的 console 日志；进 UI 的一律是中文
        state.error = authErrorCopy(action.error.message, '注册失败，请稍后重试');
      })

      // 登录
      .addCase(signIn.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(signIn.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        state.isAuthenticated = !!action.payload;

        // 登录成功后缓存认证状态
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);
          logInfo('登录成功 - 手动同步模式');
        }
      })
      .addCase(signIn.rejected, (state, action) => {
        state.isLoading = false;
        // 原始英文只留在 thunk 里的 console 日志；进 UI 的一律是中文
        state.error = authErrorCopy(action.error.message, '登录失败，请稍后重试');
      })



      // 退出登录
      .addCase(signOut.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(signOut.fulfilled, (state) => {
        state.isLoading = false;
        state.user = null;
        state.isAuthenticated = false;

        // 退出登录后清除认证缓存
        authCache.clearAuthState();
      })
      .addCase(signOut.rejected, (state, action) => {
        state.isLoading = false;
        state.error = authErrorCopy(action.error.message, '退出登录失败，请稍后重试');
      })

      // 获取当前用户
      .addCase(getCurrentUser.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(getCurrentUser.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        state.isAuthenticated = !!action.payload;

        // 更新认证缓存
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);

          // 移除实时同步功能，简化逻辑
        } else {
          authCache.clearAuthState();
        }
      })
      .addCase(getCurrentUser.rejected, (state, action) => {
        state.isLoading = false;
        // 确保错误消息是字符串而不是对象；且进 UI 的必须是中文
        state.error = authErrorCopy(action.error.message, '获取用户信息失败，请稍后重试');
        logInfo('自动登录失败，但这是正常的，用户可能未登录');
      });
  },
});

export const { clearError, setFromCache } = authSlice.actions;

export default authSlice.reducer;
