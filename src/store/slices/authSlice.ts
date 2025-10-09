import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';
import { syncService } from '@/services/syncService';

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
        console.error('注册错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '注册失败');
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('注册失败');
    } catch (err) {
      console.error('注册异常:', err);
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('注册失败');
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
        console.error('登录错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '登录失败');
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('登录失败');
    } catch (err) {
      console.error('登录异常:', err);
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('登录失败');
      }
    }
  }
);





export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    try {
      // 移除实时同步功能，简化逻辑
      console.log('已简化同步逻辑，只保留手动同步功能');

      // 退出登录
      const { error } = await supabaseAuth.signOut();
      if (error) {
        console.error('退出登录错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '退出登录失败');
      }

      console.log('退出登录成功');
      return null;
    } catch (err) {
      console.error('退出登录异常:', err);
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('退出登录失败');
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
        console.log('没有活跃会话，用户未登录');
        return null;
      }

      // 如果有会话，才获取用户信息
      const { data, error } = await supabaseAuth.getCurrentUser();
      if (error) {
        console.error('获取用户信息错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '获取用户信息失败');
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
      console.error('获取用户信息异常:', err);
      // 确保返回一个字符串错误消息，而不是对象
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('获取用户信息失败');
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
        state.isAuthenticated = !!action.payload;
      })
      .addCase(signUp.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '注册失败';
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

          // 初始化智能同步服务
          syncService.initialize().then(() => {
            console.log('登录成功，同步服务已初始化');
          }).catch(error => {
            console.error('初始化同步服务失败:', error);
          });
        }
      })
      .addCase(signIn.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '登录失败';
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
        
        // 清理同步服务
        import('@/services/smartSyncService').then(({ smartSyncService }) => {
          smartSyncService.cleanup();
          console.log('退出登录，同步服务已清理');
        });
      })
      .addCase(signOut.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '退出登录失败';
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
        // 确保错误消息是字符串而不是对象
        state.error = typeof action.error.message === 'string' ? action.error.message : '获取用户信息失败';
        console.log('自动登录失败，但这是正常的，用户可能未登录');
      });
  },
});

export const { clearError, setFromCache } = authSlice.actions;

export default authSlice.reducer;
