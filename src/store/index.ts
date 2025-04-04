import { configureStore } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer from './slices/settingsSlice';

export const store = configureStore({
  reducer: {
    tabs: tabReducer,
    settings: settingsReducer,
  },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        // 忽略 chrome.tabs.Tab 类型的序列化检查
        ignoredActionPaths: ['payload.tab', 'payload.tabs'],
        ignoredPaths: ['tabs.currentTab'],
      },
    }),
});

export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>; 