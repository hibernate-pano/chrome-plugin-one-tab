import { configureStore, combineReducers } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer from './slices/settingsSlice';
import authReducer from './slices/authSlice';
import type { TabState, UserSettings } from '@/types/tab';

const rootReducer = combineReducers({
  tabs: tabReducer,
  settings: settingsReducer,
  auth: authReducer,
});

export type RootState = ReturnType<typeof rootReducer>;

export interface PreloadedState {
  tabs?: Partial<TabState>;
  settings?: Partial<UserSettings>;
}

function buildStore(preloadedState?: PreloadedState) {
  return configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActionPaths: ['payload.tab', 'payload.tabs'],
          ignoredPaths: ['tabs.currentTab'],
        },
      }),
  });
}

export type AppStore = ReturnType<typeof buildStore>;
export type AppDispatch = AppStore['dispatch'];

let _store: AppStore = buildStore();

/**
 * 共享 store 引用。popup 在 mount 前用 createStore(preloadedState) 重建，
 * 让首屏直接拿到本地数据；业务模块通过 proxy 始终访问当前 store。
 */
export const store = new Proxy({} as AppStore, {
  get(_target, prop: string | symbol) {
    return (_store as any)[prop];
  },
});

export function createStore(preloadedState?: PreloadedState): AppStore {
  _store = buildStore(preloadedState);
  return _store;
}
