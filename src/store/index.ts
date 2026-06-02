import { configureStore, combineReducers } from '@reduxjs/toolkit';
import tabReducer, { initialTabState } from './slices/tabSlice';
import settingsReducer, { initialSettingsState } from './slices/settingsSlice';
import authReducer from './slices/authSlice';
import { autoSyncMiddleware } from './middleware/autoSyncMiddleware';

const rootReducer = combineReducers({
  tabs: tabReducer,
  settings: settingsReducer,
  auth: authReducer,
});

export type RootState = ReturnType<typeof rootReducer>;

export interface PreloadedState {
  tabs?: Partial<typeof initialTabState>;
  settings?: Partial<typeof initialSettingsState>;
}

export function createStore(preloadedState?: PreloadedState) {
  return configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActionPaths: ['payload.tab', 'payload.tabs'],
          ignoredPaths: ['tabs.currentTab'],
        },
      }).concat(autoSyncMiddleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type AppDispatch = AppStore['dispatch'];
