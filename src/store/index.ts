import { configureStore, combineReducers } from '@reduxjs/toolkit';
import tabReducer from './slices/tabSlice';
import settingsReducer, { dispatchReloadSettings } from './slices/settingsSlice';
import authReducer from './slices/authSlice';
import { autoSyncMiddleware } from './middleware/autoSyncMiddleware';
import { subscribeSettingsChanged } from '@/storage-kv/settingsChangedBus';

const rootReducer = combineReducers({
  tabs: tabReducer,
  settings: settingsReducer,
  auth: authReducer,
});

export type RootState = ReturnType<typeof rootReducer>;
export type AppStore = ReturnType<typeof buildStore>;
export type AppDispatch = AppStore['dispatch'];

function buildStore(preloadedState?: Partial<RootState>) {
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: preloadedState as RootState | undefined,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        serializableCheck: {
          // 忽略 chrome.tabs.Tab 类型的序列化检查
          ignoredActionPaths: ['payload.tabs', 'payload.tab'],
          ignoredPaths: ['tabs.currentTab'],
        },
      }).concat(autoSyncMiddleware),
  });

  // ── 2026-10-24 审计 GAP1-1：设置变了 ⇒ 本 realm 的设置状态重读 ──────────
  //
  // 【为什么订阅放在 store 这一层，而不是每个页面各写一遍】
  // 设置写方在多个执行上下文里（管理页标签、设置页标签、MV3 SW），每个 realm
  // 各持一份**挂载时的快照**。设置落在 IndexedDB ⇒ `chrome.storage.onChanged`
  // 根本不触发 ⇒ 没有失效通道时，别的 realm 改了设置，本 realm 永远不知道。
  //
  // 放在 store 里 ⇒ **每个 realm 天然都有这条通道**（每个执行上下文各有一份
  // store 实例），而页面层不需要（也不应该）各自订阅一遍：
  // 漏一个页面就漏一次刷新，而漏了不会报错、只会静默显示旧值。
  //
  // 【为什么重读而不是直接用通知里的值】通知是**提示**不是数据（IndexedDB
  // 没有变更通知，跨上下文只有 runtime 消息这一条通道，消息可能丢）。
  // 所以收到通知后走「先失效 60s 缓存、再读盘」——顺序即语义
  // （见 dispatchReloadSettings 的注释）。
  subscribeSettingsChanged(() => {
    void dispatchReloadSettings(store.dispatch);
  });

  return store;
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
