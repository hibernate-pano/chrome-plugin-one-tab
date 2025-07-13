import { configureStore } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer from './slices/settingsSlice';
import authReducer from './slices/authSlice';

export const store = configureStore({
  reducer: {
    tabs: tabReducer,
    settings: settingsReducer,
    auth: authReducer, // 新增：认证reducer
  },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: false, // 暂时完全禁用序列化检查来排查问题
    }),
});

export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;