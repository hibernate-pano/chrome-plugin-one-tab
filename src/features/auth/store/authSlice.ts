/**
 * 认证功能状态管理
 * 处理用户登录、注册、OAuth等认证相关操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';
import { auth as supabaseAuth } from '@/shared/utils/supabase';
import { authCache } from '@/shared/utils/authCache';

export interface User {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  provider: 'email' | 'google' | 'github' | 'wechat';
  createdAt: string;
  lastLoginAt: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: User;
}

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated' | 'error';
export type AuthProvider = 'email' | 'google' | 'github' | 'wechat';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: AuthSession | null;
  isLoading: boolean;
  error: string | null;
  loginProvider: AuthProvider | null;
  isSessionRestored: boolean;
  wechatLoginStatus: 'idle' | 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
  wechatLoginError: string | null;
  wechatLoginTabId: number | null;
}

const initialState: AuthState = {
  status: 'idle',
  user: null,
  session: null,
  isLoading: false,
  error: null,
  loginProvider: null,
  isSessionRestored: false,
  wechatLoginStatus: 'idle',
  wechatLoginError: null,
  wechatLoginTabId: null,
};

// 异步操作
export const signInWithEmail = createAsyncThunk(
  'auth/signInWithEmail',
  async (
    { email, password }: { email: string; password: string },
    { rejectWithValue }
  ) => {
    try {
      logger.debug('邮箱登录', { email });

      // 首先尝试真实的Supabase认证服务
      try {
        const { data, error } = await supabaseAuth.signIn(email, password);

        if (error) {
          logger.error('Supabase登录失败', error);
          throw new Error(error.message || '邮箱或密码错误');
        }

        if (!data.user || !data.session) {
          throw new Error('登录失败：未获取到用户信息');
        }

        // 转换Supabase用户数据为应用格式
        const user: User = {
          id: data.user.id,
          email: data.user.email || email,
          name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
          avatar: data.user.user_metadata?.avatar_url,
          provider: 'email',
          createdAt: data.user.created_at || new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        };

        const session: AuthSession = {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt: new Date(data.session.expires_at! * 1000).toISOString(),
          user,
        };

        logger.success('邮箱登录成功', { userId: user.id, email: user.email });

        return { user, session };

      } catch (networkError: any) {
        // 移除临时本地认证模式，所有登录都必须通过真实的Supabase认证
        logger.error('Supabase登录失败', networkError);
        throw networkError;
      }

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'signInWithEmail',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const signUpWithEmail = createAsyncThunk(
  'auth/signUpWithEmail',
  async (
    { email, _password, name }: { email: string; _password: string; name?: string },
    { rejectWithValue }
  ) => {
    void _password; // 标记为故意未使用
    try {
      logger.debug('邮箱注册', { email, name });

      // 调用真实的Supabase注册服务
      const { data, error } = await supabaseAuth.signUp(email, _password);

      if (error) {
        logger.error('Supabase注册失败', error);
        throw new Error(error.message || '注册失败');
      }

      if (!data.user) {
        throw new Error('注册失败：未获取到用户信息');
      }

      // 转换Supabase用户数据为应用格式
      const user: User = {
        id: data.user.id,
        email: data.user.email || email,
        name: name || data.user.user_metadata?.name || email.split('@')[0],
        avatar: data.user.user_metadata?.avatar_url,
        provider: 'email',
        createdAt: data.user.created_at || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };

      // 注册后可能需要邮箱验证，session可能为null
      const session: AuthSession | null = data.session ? {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: new Date(data.session.expires_at! * 1000).toISOString(),
        user,
      } : null;

      logger.success('邮箱注册成功', { userId: user.id, email: user.email });

      return { user, session };

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'signUpWithEmail',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const signInWithOAuth = createAsyncThunk(
  'auth/signInWithOAuth',
  async (
    { provider }: { provider: Exclude<AuthProvider, 'email'> },
    { rejectWithValue }
  ) => {
    try {
      logger.debug('OAuth登录', { provider });

      // 暂时禁用OAuth登录，直到正确配置Supabase OAuth提供商
      throw new Error(`${provider} 登录功能暂未开放，请使用邮箱登录`);

      // TODO: 启用真实的OAuth登录需要：
      // 1. 在Supabase项目中配置OAuth提供商
      // 2. 获取正确的客户端ID和密钥
      // 3. 配置重定向URL

      // 真实的OAuth登录实现（需要配置后启用）：
      // const { data, error } = await supabaseAuth.signInWithOAuth(provider);
      // if (error) throw new Error(error.message);
      // return convertSupabaseUserToAppUser(data);

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'signInWithOAuth',
        extra: { provider },
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const handleOAuthCallback = createAsyncThunk(
  'auth/handleOAuthCallback',
  async (
    { url }: { url: string },
    { rejectWithValue }
  ) => {
    try {
      logger.debug('处理OAuth回调', { url });

      // 调用真实的Supabase OAuth回调处理
      const { data, error } = await supabaseAuth.handleOAuthCallback(url);

      if (error) {
        logger.error('OAuth回调处理失败', error);
        throw new Error(error.message || 'OAuth回调处理失败');
      }

      if (!data.user || !data.session) {
        throw new Error('OAuth回调处理失败：未获取到用户信息');
      }

      // 转换Supabase用户数据为应用格式
      const user: User = {
        id: data.user.id,
        email: data.user.email || 'oauth@unknown.com',
        name: data.user.user_metadata?.name ||
          data.user.user_metadata?.full_name ||
          data.user.email?.split('@')[0] ||
          'OAuth User',
        avatar: data.user.user_metadata?.avatar_url,
        provider: (data.user.app_metadata?.provider as AuthProvider) || 'email',
        createdAt: data.user.created_at || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };

      const session: AuthSession = {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: new Date(data.session.expires_at! * 1000).toISOString(),
        user,
      };

      logger.success('OAuth回调处理成功', { userId: user.id, provider: user.provider });

      return { user, session };

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'handleOAuthCallback',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const signOut = createAsyncThunk(
  'auth/signOut',
  async (_, { getState, rejectWithValue }) => {
    try {
      const state = getState() as { auth: AuthState };
      const userId = state.auth.user?.id;

      logger.debug('用户登出', { userId });

      try {
        // 尝试调用Supabase登出API
        const { error } = await supabaseAuth.signOut();

        if (error) {
          logger.warn('Supabase登出失败，但继续本地登出', error);
        } else {
          logger.success('Supabase登出成功', { userId });
        }
      } catch (networkError) {
        // 网络错误时，仍然执行本地登出
        logger.warn('网络错误，执行本地登出', { error: networkError });
      }

      // 无论Supabase登出是否成功，都执行本地登出
      logger.success('用户登出成功（本地）', { userId });

      return true;

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'signOut',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

// 添加一个新的action用于强制本地登出
export const forceLocalSignOut = createAsyncThunk(
  'auth/forceLocalSignOut',
  async (_, { getState }) => {
    const state = getState() as { auth: AuthState };
    const userId = state.auth.user?.id;

    logger.debug('强制本地登出', { userId });

    // 清除认证缓存
    try {
      await authCache.clearAuthState();
      logger.debug('认证缓存已清除');
    } catch (error) {
      logger.error('清除认证缓存失败', error);
    }

    logger.success('强制本地登出成功', { userId });
    return true;
  }
);

export const restoreSession = createAsyncThunk(
  'auth/restoreSession',
  async (_, { rejectWithValue }) => {
    try {
      logger.debug('恢复用户会话');

      // 从Supabase获取当前会话
      const { data, error } = await supabaseAuth.getSession();

      if (error) {
        logger.error('获取Supabase会话失败', error);
        throw new Error((error as any).message || '获取会话失败');
      }

      if (!data.session || !data.session.user) {
        logger.debug('没有有效的Supabase会话');
        return null;
      }

      // 转换Supabase用户数据为应用格式
      const user: User = {
        id: data.session.user.id,
        email: data.session.user.email || 'unknown@example.com',
        name: data.session.user.user_metadata?.name ||
          data.session.user.user_metadata?.full_name ||
          data.session.user.email?.split('@')[0] ||
          'User',
        avatar: data.session.user.user_metadata?.avatar_url,
        provider: (data.session.user.app_metadata?.provider as AuthProvider) || 'email',
        createdAt: data.session.user.created_at || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };

      const session: AuthSession = {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: new Date(data.session.expires_at! * 1000).toISOString(),
        user,
      };

      logger.success('会话恢复成功', { userId: user.id, email: user.email });

      return { user, session };

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'restoreSession',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

export const refreshSession = createAsyncThunk(
  'auth/refreshSession',
  async (_, { getState, rejectWithValue }) => {
    try {
      const state = getState() as { auth: AuthState };
      const refreshToken = state.auth.session?.refreshToken;

      if (!refreshToken) {
        throw new Error('没有可用的刷新令牌');
      }

      logger.debug('刷新用户会话');

      // 这里应该调用实际的刷新服务
      await new Promise(resolve => setTimeout(resolve, 400));

      const newSession: AuthSession = {
        ...state.auth.session!,
        accessToken: 'new_access_token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };

      logger.success('会话刷新成功');

      return newSession;

    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, {
        component: 'AuthSlice',
        action: 'refreshSession',
      });

      return rejectWithValue(friendlyError.message);
    }
  }
);

// Slice定义
const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setAuthStatus: (state, action: PayloadAction<AuthStatus>) => {
      state.status = action.payload;
      if (action.payload !== 'error') {
        state.error = null;
      }
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      if (action.payload) {
        state.status = 'error';
      }
    },

    clearError: (state) => {
      state.error = null;
      if (state.status === 'error') {
        state.status = state.user ? 'authenticated' : 'unauthenticated';
      }
    },

    updateWechatLoginStatus: (state, action: PayloadAction<{
      status: AuthState['wechatLoginStatus'];
      error?: string;
      tabId?: number;
    }>) => {
      const { status, error, tabId } = action.payload;
      state.wechatLoginStatus = status;
      state.wechatLoginError = error || null;

      if (tabId !== undefined) {
        state.wechatLoginTabId = tabId;
      }

      logger.debug('微信登录状态更新', { status, error, tabId });
    },

    resetWechatLogin: (state) => {
      state.wechatLoginStatus = 'idle';
      state.wechatLoginError = null;
      state.wechatLoginTabId = null;
    },

    setFromCache: (state, action: PayloadAction<{ user: User; session?: AuthSession }>) => {
      const { user, session } = action.payload;
      state.user = user;
      state.session = session || null;
      state.status = 'authenticated';
      state.isSessionRestored = true;

      logger.debug('从缓存恢复认证状态', { userId: user.id });
    },

    updateUser: (state, action: PayloadAction<Partial<User>>) => {
      if (state.user) {
        state.user = { ...state.user, ...action.payload };
        logger.debug('用户信息已更新', action.payload);
      }
    },

    resetAuthState: (state) => {
      state.status = 'unauthenticated';
      state.user = null;
      state.session = null;
      state.error = null;
      state.loginProvider = null;
      state.isSessionRestored = false;
      state.wechatLoginStatus = 'idle';
      state.wechatLoginError = null;
      state.wechatLoginTabId = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // signInWithEmail
      .addCase(signInWithEmail.pending, (state) => {
        state.isLoading = true;
        state.error = null;
        state.status = 'loading';
      })
      .addCase(signInWithEmail.fulfilled, (state, action) => {
        const { user, session } = action.payload;
        state.isLoading = false;
        state.user = user;
        state.session = session;
        state.status = 'authenticated';
        state.loginProvider = 'email';
      })
      .addCase(signInWithEmail.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
        state.status = 'error';
      })

      // signUpWithEmail
      .addCase(signUpWithEmail.pending, (state) => {
        state.isLoading = true;
        state.error = null;
        state.status = 'loading';
      })
      .addCase(signUpWithEmail.fulfilled, (state, action) => {
        const { user, session } = action.payload;
        state.isLoading = false;
        state.user = user;
        state.session = session;
        // 如果没有session（需要邮箱验证），状态为unauthenticated
        state.status = session ? 'authenticated' : 'unauthenticated';
        state.loginProvider = 'email';
      })
      .addCase(signUpWithEmail.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
        state.status = 'error';
      })

      // signInWithOAuth
      .addCase(signInWithOAuth.pending, (state) => {
        state.isLoading = true;
        state.error = null;
        state.status = 'loading';
      })
      .addCase(signInWithOAuth.fulfilled, (state, action) => {
        const payload = action.payload;

        // 微信登录需要打开新标签页
        if ('requiresTab' in payload) {
          state.isLoading = false;
          state.wechatLoginStatus = 'pending';
          state.status = 'idle';
          return;
        }

        const { user, session, provider } = payload;
        state.isLoading = false;
        state.user = user;
        state.session = session;
        state.status = 'authenticated';
        state.loginProvider = provider;
      })
      .addCase(signInWithOAuth.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
        state.status = 'error';
      })

      // handleOAuthCallback
      .addCase(handleOAuthCallback.fulfilled, (state, action) => {
        const { user, session } = action.payload;
        state.user = user;
        state.session = session;
        state.status = 'authenticated';
        state.loginProvider = user.provider;

        // 重置微信登录状态
        if (user.provider === 'wechat') {
          state.wechatLoginStatus = 'confirmed';
        }
      })
      .addCase(handleOAuthCallback.rejected, (state, action) => {
        state.error = action.payload as string;
        state.status = 'error';
        state.wechatLoginStatus = 'error';
        state.wechatLoginError = action.payload as string;
      })

      // signOut
      .addCase(signOut.fulfilled, (state) => {
        state.user = null;
        state.session = null;
        state.status = 'unauthenticated';
        state.loginProvider = null;
        state.error = null;
        state.wechatLoginStatus = 'idle';
        state.wechatLoginError = null;
        state.wechatLoginTabId = null;

        // 清除认证缓存
        authCache.clearAuthState().catch(error => {
          logger.error('清除认证缓存失败', error);
        });
      })
      .addCase(signOut.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })
      // forceLocalSignOut
      .addCase(forceLocalSignOut.fulfilled, (state) => {
        state.user = null;
        state.session = null;
        state.status = 'unauthenticated';
        state.loginProvider = null;
        state.error = null;
        state.wechatLoginStatus = 'idle';
        state.wechatLoginError = null;
        state.wechatLoginTabId = null;
      })

      // restoreSession
      .addCase(restoreSession.fulfilled, (state, action) => {
        state.isSessionRestored = true;
        if (action.payload) {
          // 有缓存的会话
          const { user, session } = action.payload;
          state.user = user;
          state.session = session;
          state.status = 'authenticated';
        } else {
          // 没有缓存的会话
          state.status = 'unauthenticated';
        }
      })

      // refreshSession
      .addCase(refreshSession.fulfilled, (state, action) => {
        state.session = action.payload;
      })
      .addCase(refreshSession.rejected, (state) => {
        // 刷新失败，清除会话
        state.user = null;
        state.session = null;
        state.status = 'unauthenticated';
        state.loginProvider = null;
      });
  },
});

export const {
  setAuthStatus,
  setError,
  clearError,
  updateWechatLoginStatus,
  resetWechatLogin,
  setFromCache,
  updateUser,
  resetAuthState,
} = authSlice.actions;

// 选择器：确保认证状态检查的一致性
export const selectIsAuthenticated = (state: { auth: AuthState }) => {
  return state.auth.status === 'authenticated' && state.auth.user !== null;
};

export const selectAuthUser = (state: { auth: AuthState }) => {
  return state.auth.user;
};

export const selectAuthStatus = (state: { auth: AuthState }) => {
  return state.auth.status;
};

export default authSlice.reducer;