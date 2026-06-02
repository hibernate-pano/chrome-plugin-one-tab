# 标签管理器首屏水合 local 数据

**日期**：2026-06-02
**作者**：Claude（Co-Founder）
**状态**：设计中

## 背景 / 痛点

Jasper 报告：刷新标签管理器 popup 页面时，列表看上去被"清空"了——先闪一下"先保存一个工作会话"空状态，然后才出现真实数据。即使本地数据一直在 IndexedDB 里，也会被误判为"清空"。

## 根因

`src/store/slices/tabSlice.ts:16-29` 初始 state 是 `groups: []`, `isLoading: false`, `lastLoadedAt: null`。

`src/components/tabs/TabList.tsx:51-121` 渲染分支：

```
isLoading=true  → <LoadingSpinner />
isLoading=false, groups=[]  → <EmptyState title="先保存一个工作会话" />
```

第一次 render 时 `isLoading=false` + `groups=[]` → **走 EmptyState 分支**，正是 Jasper 看到的"被清空"。

之后 `useEffect` 触发 `dispatch(loadGroups())`：
1. `pending` → `isLoading=true` → 切到 LoadingSpinner
2. 异步从 IndexedDB 读 + V2 PBKDF2(100K) 解密（约 100–200 ms 首次）
3. `fulfilled` → `state.groups = payload` → 真实数据

数据本身从未清空；只是渲染时机错位，EmptyState 闪一下再被 LoadingSpinner 替换再被真实数据替换。

## 目标

- **首屏直接显示 local 数据**，不闪 EmptyState，不闪 LoadingSpinner（除非真的没数据且仍在加载中）
- popup 打开时后台继续异步拉云端做增量更新（已有 `syncTabsFromCloud` 流程，不动）
- 失败时降级到原行为，不阻塞 popup

## 非目标

- 不动 `syncTabsFromCloud` 异步流程
- 不动 `settingsSlice` / `authSlice` 加载
- 不动 storage 适配器底层
- 不解决 storage 缓存命中以外的其它性能问题

## 设计

### 架构

```
popup/index.html 加载
   ↓
src/popup/index.tsx bootstrap() (async)
   ↓
initStorage()                          // 打开 IndexedDB / 迁移 chrome.storage / localStorage
   ↓
Promise.all([                          // 并行读 local 数据
  storage.getGroups(),
  storage.getSettings()
])
   ↓ (首次 ~100-200ms；后续命中 cachedAsyncFn 缓存几乎瞬时)
   ↓
构造 preloadedState = {                // 注入 configureStore
  tabs: { ...initialTabState, groups: activeGroups, lastLoadedAt: ISO, lastSyncStatus: 'local' },
  settings: mergedSettings
}
   ↓
configureStore({ reducer, middleware, preloadedState })
   ↓
createRoot(...)
   ↓
首次 render：state.groups 已是 local 数据
   ↓
AppContainer / MainApp / TabList 渲染
   ↓
TabList useEffect：
  - 若 state.tabs.lastLoadedAt !== null（已水合）→ 跳过 dispatch(loadGroups())
  - 保留 chrome.runtime.onMessage 监听 REFRESH_TAB_LIST → 仍派发 loadGroups()
```

### 改动点

#### 1. `src/store/index.ts`

改造为工厂模式：

```ts
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
    preloadedState: preloadedState as any,
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
```

并把 `initialTabState` / `initialSettingsState` 从各自 slice 导出。

#### 2. `src/store/slices/tabSlice.ts`

- 把 `initialState` 重命名为 `initialTabState` 并 `export`
- 新增 `lastSyncStatus: 'local' | 'cloud' | null` 字段（默认 null）
- `loadGroups.fulfilled` 时 `lastSyncStatus = 'local'`
- `syncTabsFromCloud.fulfilled` 时 `lastSyncStatus = 'cloud'`
- `initialState` 中 `lastSyncStatus: null` 表示尚未水合

#### 3. `src/store/slices/settingsSlice.ts`

- 把 `initialState` 重命名为 `initialSettingsState` 并 `export`

#### 4. `src/popup/index.tsx`

改写为 async bootstrap：

```ts
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { createStore, type PreloadedState } from '../store';
import App from './App';
import '../styles/global.css';
import { initStorage } from '@/storage/storageAdapter';
import { storage } from '@/utils/storage';
import { benchmarkStorageRoundtrip, seedLargeDataset } from '@/utils/performanceTest';

async function bootstrap() {
  let preloadedState: PreloadedState | undefined;
  try {
    await initStorage();
    const [groups, settings] = await Promise.all([
      storage.getGroups(),
      storage.getSettings(),
    ]);
    const activeGroups = groups.filter(g => !g.isDeleted);
    preloadedState = {
      tabs: {
        groups: activeGroups,
        lastLoadedAt: new Date().toISOString(),
        lastSyncStatus: 'local',
      },
      settings,
    };
  } catch (err) {
    console.warn('[popup] local hydration failed, falling back to empty store', err);
  }

  const store = createStore(preloadedState);

  const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
  );

  root.render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as any).__TV_BENCH__ = { benchmarkStorageRoundtrip, seedLargeDataset };
    console.log('[bench] helpers attached to window.__TV_BENCH__');
  }
}

bootstrap();
```

**降级策略**：initStorage 或 getGroups 失败时 `preloadedState` 保持 undefined，store 走原始 `initialState.groups = []` + `isLoading = false`，TabList 走原有 useEffect loadGroups 路径（保持原行为）。

#### 5. `src/components/tabs/TabList.tsx`

useEffect 内增加水合判断：

```ts
useEffect(() => {
  const initializeData = async () => {
    try {
      // 只有未水合时才需要从 storage 加载
      const { tabs } = store.getState();
      if (!tabs.lastLoadedAt) {
        await runMigrations();
        dispatch(loadGroups());
      }
    } catch (migrationError) {
      console.error('初始化数据失败:', migrationError);
      dispatch(loadGroups());
    }
  };

  initializeData();

  const messageListener = (message: { type?: string }) => {
    if (message.type === 'REFRESH_TAB_LIST') {
      invalidateGroupsCache();
      dispatch(loadGroups());
    }
    return true;
  };

  chrome.runtime.onMessage.addListener(messageListener);

  return () => {
    chrome.runtime.onMessage.removeListener(messageListener);
  };
}, [dispatch]);
```

或者更简洁：读 `useAppSelector` 里的 `lastLoadedAt`：

```ts
const { groups, isLoading, error, lastLoadedAt } = useAppSelector(state => state.tabs);

useEffect(() => {
  if (lastLoadedAt) return; // 已水合，不重复 load
  ...
}, [dispatch, lastLoadedAt]);
```

### 关键交互场景

| 场景 | 行为 |
|---|---|
| 首次打开（local 有数据） | 首屏直显数据；后台正常 syncTabsFromCloud |
| 首次打开（local 空，未登录） | 首屏 EmptyState（因为确实没数据） |
| 首次打开（local 空，已登录） | 首屏 EmptyState，后台 sync 后自动填充 |
| 关闭后重开（30s 内） | storage cachedAsyncFn 命中，几乎瞬时；首屏直显 |
| 关闭后重开（30s+） | 重新走 indexedDB+解密 ~100-200ms；首屏直显 |
| 关闭后重开（几小时+） | 同上，无差别 |
| service worker 推送 REFRESH_TAB_LIST | 仍然 invalidateGroupsCache + loadGroups |
| initStorage 失败 | 降级走原 useEffect 路径 |
| getGroups 失败 | 降级同上 |
| 已有数据后用户删完所有 | EmptyState 正常显示（因为确实是空） |
| 用户登录后第一次开 popup | authSlice 已就绪；preloadedState 不含 auth 也不影响 |

### 错误处理

- initStorage reject → log warn + preloadedState=undefined
- getGroups / getSettings reject → 同上
- preloadedState 注入失败（如类型不匹配）→ Redux Toolkit 会抛错 → try/catch 整体兜底
- 整体 try/catch 失败时降级到原 `createStore()` 行为
- 不弹错误 toast，不阻塞 popup

### 性能

- **首次**（冷缓存）：~100-200ms（IndexedDB open + PBKDF2 100K + AES-GCM 解密 + React 渲染）
- **30s 内重开**：~几 ms（cachedAsyncFn 命中内存缓存）
- **30s+ 重开**：~100-200ms（IndexedDB hit 但要重新 PBKDF2 解密）
- 对比当前：~50-100ms（不闪 EmptyState 的版本）但要等 useEffect 链
- 净影响：每次打开多 50-100ms，但用户感知不到"清空"，且没有 Loading 闪烁

### 测试

- **手动验证**：
  1. 浏览器加载 unpacked 扩展
  2. 打开 popup → 检查开发者工具 Performance 录制
  3. 关闭 popup → 重新打开 → 再次录制
  4. 对比：当前 EmptyState 闪 0-50ms；新版本应该无 EmptyState 闪烁
  5. 验证 service worker REFRESH_TAB_LIST 消息仍能触发刷新
- **自动化测试**：
  - 已存在 `tests/syncAutoDownloadRace.test.ts` 等
  - 新增 `tests/storeHydration.test.ts`：验证当 preloadedState 传入时，store 初始 state 正确；`loadGroups` 不会被自动 dispatch
- **回归**：
  - `pnpm type-check` 必须通过
  - `pnpm lint` 必须通过
  - `pnpm test` 必须通过
  - `pnpm build` 必须通过
  - `pnpm validate` 必须通过

## 风险

1. **popup 打开延迟 ~100-200ms**：可接受，因为当前也要等 useEffect 链
2. **storage 缓存失效时再次 await 解密**：已在 `cachedAsyncFn` 30s TTL 内避免重复 PBKDF2
3. **preloadedState 与 reducer 不一致**：用 `Partial<>` 类型 + Redux Toolkit 浅合并，避免结构问题
4. **StrictMode 双重执行 effect**：仅在未水合时 dispatch loadGroups；水合后 effect 重跑也是 no-op
5. **未来 slice 增加时需要更新 preloadedState 类型**：用 `Partial<>` + combineReducers 联合类型引导

## 后续可选增强（不在本次范围）

- 把 `cachedAsyncFn` 的 groups 缓存 TTL 从 30s 延长到 5min，进一步降低 popup 重开延迟
- 用 `chrome.storage.session` 缓存最近一次解析后的 groups，跳过 PBKDF2
- 用 Web Worker 解密，避免主线程阻塞
- 在 AppContainer 加 Skeleton 占位（如果 IndexedDB 真的慢）
