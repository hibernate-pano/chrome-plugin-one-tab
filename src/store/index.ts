import { configureStore } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer from './slices/settingsSlice';
import authReducer from './slices/authSlice';
import { autoSyncMiddleware } from './middleware/autoSyncMiddleware';

export const store = configureStore({
  reducer: {
    tabs: tabReducer,
    settings: settingsReducer,
    auth: authReducer,
  },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActionPaths: ['payload.tab', 'payload.tabs'],
        ignoredPaths: ['tabs.currentTab'],
      },
    }).concat(autoSyncMiddleware),
});

export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;