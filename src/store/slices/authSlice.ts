import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';
import { realtimeService } from '@/services/realtimeService';

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  wechatLoginStatus: 'idle',
  wechatLoginTabId: undefined,
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

export const signInWithOAuth = createAsyncThunk(
  'auth/signInWithOAuth',
  async (provider: 'google' | 'github' | 'wechat') => {
    try {
      // 如果是微信登录，记录日志
      if (provider === 'wechat') {
        console.log('开始微信扫码登录流程');
      }

      const { error, data } = await supabaseAuth.signInWithOAuth(provider);
      if (error) {
        console.error('第三方登录错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '第三方登录失败');
      }

      // 第三方登录是重定向流程，这里不会直接返回用户信息
      // 实际的用户信息会在回调处理中获取

      // 如果是微信登录，返回一些额外信息
      if (provider === 'wechat' && data && 'tabId' in data) {
        return {
          provider: 'wechat',
          tabId: data.tabId,
          timestamp: Date.now()
        };
      }

      return null;
    } catch (err) {
      console.error('第三方登录异常:', err);
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('第三方登录失败');
      }
    }
  }
);

export const handleOAuthCallback = createAsyncThunk(
  'auth/handleOAuthCallback',
  async (url: string) => {
    try {
      // 检查是否是微信登录回调
      const isWechatCallback = url.includes('wechat-login.html');

      if (isWechatCallback) {
        console.log('处理微信登录回调');
      } else {
        console.log('处理标准OAuth回调');
      }

      const { data, error } = await supabaseAuth.handleOAuthCallback(url);
      if (error) {
        console.error('处理OAuth回调错误:', error);
        throw new Error(typeof error === 'object' && error !== null && 'message' in error ?
          (error as { message: string }).message : '处理OAuth回调失败');
      }

      if (data.user) {
        // 构造用户对象
        const user: User = {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        };

        // 如果是微信登录，添加微信用户信息
        if (isWechatCallback) {
          // 设置登录方式
          user.loginProvider = 'wechat';

          // 在实际应用中，这里应该从微信API获取用户信息
          // 这里我们模拟一些微信用户信息
          user.wechatInfo = {
            nickname: `WeChatUser_${user.id.substring(0, 6)}`,
            avatar: 'https://placeholder.com/150',
            openid: `wx_openid_${Math.random().toString(36).substring(2, 10)}`,
            unionid: `wx_unionid_${Math.random().toString(36).substring(2, 10)}`
          };

          console.log('微信登录成功，用户ID:', user.id, '昵称:', user.wechatInfo.nickname);
        } else if (url.includes('accounts.google.com')) {
          user.loginProvider = 'google';
        } else if (url.includes('github.com')) {
          user.loginProvider = 'github';
        }

        return user;
      }

      throw new Error('处理OAuth回调失败');
    } catch (err) {
      console.error('处理OAuth回调异常:', err);
      if (err instanceof Error) {
        throw new Error(err.message);
      } else {
        throw new Error('处理OAuth回调失败');
      }
    }
  }
);

export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    try {
      // 清除 Realtime 订阅
      console.log('清除 Realtime 订阅...');
      realtimeService.clearRealtimeSubscription();

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
    // 更新微信登录状态
    updateWechatLoginStatus: (state, action) => {
      state.wechatLoginStatus = action.payload.status;

      // 如果提供了标签页ID，则更新标签页ID
      if (action.payload.tabId !== undefined) {
        state.wechatLoginTabId = action.payload.tabId;
      }

      // 如果状态是失败或过期，清除错误信息
      if (action.payload.status === 'failed' || action.payload.status === 'expired') {
        state.error = action.payload.error || '微信登录失败';
      }
    },
    // 从缓存设置认证状态
    setFromCache: (state, action) => {
      state.user = action.payload.user;
      state.isAuthenticated = action.payload.isAuthenticated;
      state.isLoading = false;
      state.error = null;

      // 如果用户已登录且是微信登录，设置微信登录状态为成功
      if (action.payload.user && action.payload.user.loginProvider === 'wechat') {
        state.wechatLoginStatus = 'success';
      } else {
        // 否则重置微信登录状态
        state.wechatLoginStatus = 'idle';
        state.wechatLoginTabId = undefined;
      }
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

          // 设置 Realtime 订阅
          setTimeout(() => {
            realtimeService.setupRealtimeSubscription()
              .then(subscription => {
                if (subscription) {
                  console.log('登录后设置 Realtime 订阅成功');
                } else {
                  console.warn('登录后设置 Realtime 订阅失败');
                }
              })
              .catch(error => {
                console.error('登录后设置 Realtime 订阅异常:', error);
              });
          }, 1000); // 延迟1秒设置，确保登录已完成
        }
      })
      .addCase(signIn.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '登录失败';
      })

      // 第三方登录
      .addCase(signInWithOAuth.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(signInWithOAuth.fulfilled, (state, action) => {
        state.isLoading = false;
        // 不在这里设置用户信息，因为这只是重定向的开始

        // 如果是微信登录，设置微信登录状态
        if (action.payload && action.payload.provider === 'wechat') {
          // 设置微信登录状态
          state.wechatLoginStatus = 'pending';
          state.wechatLoginTabId = action.payload.tabId;
          console.log('微信登录流程已启动，等待用户扫码，标签页ID:', action.payload.tabId);
        }
      })
      .addCase(signInWithOAuth.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '第三方登录失败';

        // 如果是微信登录失败，重置微信登录状态
        state.wechatLoginStatus = 'failed';
      })

      // 处理OAuth回调
      .addCase(handleOAuthCallback.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(handleOAuthCallback.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        state.isAuthenticated = !!action.payload;

        // 登录成功后缓存认证状态
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);

          // 如果是微信登录成功，更新微信登录状态
          if (action.payload.loginProvider === 'wechat') {
            state.wechatLoginStatus = 'success';
            // 清除微信登录标签页ID
            state.wechatLoginTabId = undefined;
          }

          // 设置 Realtime 订阅
          setTimeout(() => {
            realtimeService.setupRealtimeSubscription()
              .then(subscription => {
                if (subscription) {
                  console.log('第三方登录后设置 Realtime 订阅成功');
                } else {
                  console.warn('第三方登录后设置 Realtime 订阅失败');
                }
              })
              .catch(error => {
                console.error('第三方登录后设置 Realtime 订阅异常:', error);
              });
          }, 1000); // 延迟1秒设置，确保登录已完成
        }
      })
      .addCase(handleOAuthCallback.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '处理OAuth回调失败';

        // 如果当前有微信登录进行中，则设置微信登录状态为失败
        if (state.wechatLoginStatus === 'pending' || state.wechatLoginStatus === 'scanning' || state.wechatLoginStatus === 'confirming') {
          state.wechatLoginStatus = 'failed';
        }
      })

      // 退出登录
      .addCase(signOut.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(signOut.fulfilled, (state) => {
        state.isLoading = false;
        state.user = null;
        state.isAuthenticated = false;
        // 重置微信登录状态
        state.wechatLoginStatus = 'idle';
        state.wechatLoginTabId = undefined;

        // 退出登录后清除认证缓存
        authCache.clearAuthState();
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

          // 设置 Realtime 订阅
          setTimeout(() => {
            realtimeService.setupRealtimeSubscription()
              .then(subscription => {
                if (subscription) {
                  console.log('自动登录后设置 Realtime 订阅成功');
                } else {
                  console.warn('自动登录后设置 Realtime 订阅失败');
                }
              })
              .catch(error => {
                console.error('自动登录后设置 Realtime 订阅异常:', error);
              });
          }, 1000); // 延迟1秒设置，确保登录已完成
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

export const { clearError, setFromCache, updateWechatLoginStatus } = authSlice.actions;

export default authSlice.reducer;
