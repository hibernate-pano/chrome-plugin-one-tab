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
      }).concat(autoSyncMiddleware),
  });
}

export type AppStore = ReturnType<typeof buildStore>;
export type AppDispatch = AppStore['dispatch'];

// 内部可变 store 引用。模块加载时创建默认空 store。
// 通过 `createStore(preloadedState?)` 可以用 preloadedState 重建并切换。
// popup 入口在 await local 数据后调 createStore(preloadedState)，
// 让 Provider 第一次 mount 时 store 已经包含 local 数据。
let _store: AppStore = buildStore();

/**
 * 共享 store singleton。**通过 Proxy 转发**到内部 `_store`——
 * 这样所有 `import { store }` 的模块（hooks, services, components）
 * 不需要修改，并且 `_store` 可以被 `createStore` 重建而不破坏引用。
 *
 * 注意：React-Redux Provider 在 mount 时通过 useSyncExternalStore 订阅 store。
 * proxy 的引用恒定，所以 React 不会因 `_store` 重建而重新订阅。
 * 实践中 `_store` 只在 popup 入口 mount 之前重建一次（注入 preloadedState），
 * 因此不会触发 UI 脱同步。
 */
export const store = new Proxy({} as AppStore, {
  get(_target, prop: string | symbol) {
    return (_store as any)[prop];
  },
});

/**
 * 用可选的 preloadedState 重建 store，并把内部 `_store` 引用切换到新 store。
 * 所有通过 `store` proxy 访问的代码（hooks, services）自动看到新 store。
 * 必须在 React-Redux Provider mount 之前调用——之后调用会脱同步。
 *
 * @returns 新创建的 store
 */
export function createStore(preloadedState?: PreloadedState): AppStore {
  _store = buildStore(preloadedState);
  return _store;
}
