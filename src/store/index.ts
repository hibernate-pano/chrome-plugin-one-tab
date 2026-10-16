import { configureStore, combineReducers } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer from './slices/settingsSlice';
import { autoSyncMiddleware } from './middleware/autoSyncMiddleware';

// 2026-10-16：`auth` 分片随账号体系删除。同步不可用的唯一形态（自带存储
// 未配置/未解锁）不再走 Redux，而是由 sync-backend 的锁定占位后端抛出。
const rootReducer = combineReducers({
  tabs: tabReducer,
  settings: settingsReducer,
});

export type RootState = ReturnType<typeof rootReducer>;
export type AppStore = ReturnType<typeof buildStore>;
export type AppDispatch = AppStore['dispatch'];

function buildStore(preloadedState?: Partial<RootState>) {
  return configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        serializableCheck: {
          // 忽略 chrome.tabs.Tab 类型的序列化检查
          ignoredActionPaths: ['payload.tab', 'payload.tabs'],
          ignoredPaths: ['tabs.currentTab'],
        },
      }).concat(autoSyncMiddleware),
  });
}

// 默认单例（现有代码直接 `import { store }` 不破坏）
export const store: AppStore = buildStore();

/**
 * 用可选 preloadedState 重建 store，供测试注入与 popup 首屏 hydration。
 * 仅在 React-Redux Provider mount 之前调用。返回新 store 实例。
 */
export function createStore(preloadedState?: Partial<RootState>): AppStore {
  return buildStore(preloadedState);
}
