/**
 * 认证功能状态管理
 * 处理用户登录、注册、OAuth等认证相关操作
 */
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

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
      
      // 这里应该调用实际的认证服务
      // 暂时模拟异步操作
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 模拟登录验证
      if (email === 'test@example.com' && password === 'password') {
        const user: User = {
          id: 'user_1',
          email,
          name: 'Test User',
          provider: 'email',
          createdAt: new Date().toISOString(),
          lastLoginAt: new Date().toISOString(),
        };
        
        const session: AuthSession = {
          accessToken: 'mock_access_token',
          refreshToken: 'mock_refresh_token',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          user,
        };
        
        logger.success('邮箱登录成功', { userId: user.id, email: user.email });
        
        return { user, session };
      } else {
        throw new Error('邮箱或密码错误');
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
      
      // 模拟注册过程
      await new Promise(resolve => setTimeout(resolve, 1200));
      
      const user: User = {
        id: `user_${Date.now()}`,
        email,
        name: name || email.split('@')[0],
        provider: 'email',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      
      const session: AuthSession = {
        accessToken: 'mock_access_token',
        refreshToken: 'mock_refresh_token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        user,
      };
      
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
      
      // 特殊处理微信登录
      if (provider === 'wechat') {
        // 微信登录会打开新标签页，这里返回特殊状态
        return { provider, requiresTab: true };
      }
      
      // 其他OAuth登录
      await new Promise(resolve => setTimeout(resolve, 800));
      
      const user: User = {
        id: `${provider}_user_${Date.now()}`,
        email: `user@${provider}.com`,
        name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} User`,
        provider,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      
      const session: AuthSession = {
        accessToken: 'mock_oauth_access_token',
        refreshToken: 'mock_oauth_refresh_token',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        user,
      };
      
      logger.success('OAuth登录成功', { provider, userId: user.id });
      
      return { user, session, provider };
      
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
      
      // 解析回调URL
      const urlObj = new URL(url);
      const fragment = urlObj.hash.substring(1);
      const params = new URLSearchParams(fragment);
      
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const _state = params.get('state');
      
      void _state; // OAuth状态验证将在后续版本实现
      
      if (!accessToken || !refreshToken) {
        throw new Error('OAuth回调参数不完整');
      }
      
      // 验证state参数
      // 这里应该验证state与之前存储的值是否匹配
      
      // 模拟用户信息获取
      const user: User = {
        id: `oauth_user_${Date.now()}`,
        email: 'oauth@example.com',
        name: 'OAuth User',
        provider: url.includes('wechat') ? 'wechat' : 'google',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      
      const session: AuthSession = {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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
      
      // 这里应该调用实际的登出服务
      await new Promise(resolve => setTimeout(resolve, 300));
      
      logger.success('用户登出成功', { userId });
      
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

export const restoreSession = createAsyncThunk(
  'auth/restoreSession',
  async (_, { rejectWithValue }) => {
    try {
      logger.debug('恢复用户会话');
      
      // 这里应该从缓存或服务器恢复会话
      // 暂时模拟
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 模拟没有缓存的会话
      return null;
      
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
        state.status = 'authenticated';
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

export default authSlice.reducer;