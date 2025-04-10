import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import { auth as supabaseAuth } from '@/utils/supabase';

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
};

export const signUp = createAsyncThunk(
  'auth/signUp',
  async ({ email, password }: { email: string; password: string }) => {
    const { data, error } = await supabaseAuth.signUp(email, password);
    if (error) throw new Error(error.message);
    
    if (data.user) {
      return {
        id: data.user.id,
        email: data.user.email!,
        lastLogin: new Date().toISOString(),
      } as User;
    }
    
    throw new Error('注册失败');
  }
);

export const signIn = createAsyncThunk(
  'auth/signIn',
  async ({ email, password }: { email: string; password: string }) => {
    const { data, error } = await supabaseAuth.signIn(email, password);
    if (error) throw new Error(error.message);
    
    if (data.user) {
      return {
        id: data.user.id,
        email: data.user.email!,
        lastLogin: new Date().toISOString(),
      } as User;
    }
    
    throw new Error('登录失败');
  }
);

export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    const { error } = await supabaseAuth.signOut();
    if (error) throw new Error(error.message);
    return null;
  }
);

export const getCurrentUser = createAsyncThunk(
  'auth/getCurrentUser',
  async () => {
    const { data, error } = await supabaseAuth.getCurrentUser();
    if (error) throw new Error(error.message);
    
    if (data.user) {
      return {
        id: data.user.id,
        email: data.user.email!,
        lastLogin: new Date().toISOString(),
      } as User;
    }
    
    return null;
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => {
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
      })
      .addCase(getCurrentUser.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || '获取用户信息失败';
      });
  },
});

export const { clearError } = authSlice.actions;

export default authSlice.reducer;
