import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { createStore, store, type PreloadedState } from '../store';
import App from './App';
import '../styles/global.css';
import { initStorage } from '@/storage/storageAdapter';
import { storage } from '@/utils/storage';
import { initialTabState } from '@/store/slices/tabSlice';
import { decideTabsHydration, buildTabsPreloadedState } from '@/utils/hydrationDecision';
import { benchmarkStorageRoundtrip, seedLargeDataset } from '@/utils/performanceTest';

/**
 * 在 createRoot 之前先 await 把 local 数据塞进 preloadedState，
 * 让首屏 render 直接显示已保存的标签组，避免 EmptyState 闪烁。
 *
 * ⚠️ 刷新后数据丢失防护（见 utils/hydrationDecision.ts）：
 * storage.getGroups() 在冷启动 race / 解密失败时会**静默返回 []**。如果
 * 把这种「瞬时空读」固化成 lastLoadedAt 非空，TabList 会永久跳过 loadGroups
 * 重试，用户看到 EmptyState——表现为「刷新后数据没了」。因此只有真正读到
 * 非空数据时才 hydrate tabs + 固化 lastLoadedAt；读到空时不 hydrate tabs，
 * 交给 TabList 走带 isLoading 状态的 loadGroups 路径。
 *
 * 失败时降级为不带 preloadedState（走原 useEffect loadGroups 路径）。
 */
async function bootstrap() {
  let preloadedState: PreloadedState | undefined;
  try {
    await initStorage();
    const [groups, settings] = await Promise.all([
      storage.getGroups(),
      storage.getSettings(),
    ]);

    const decision = decideTabsHydration({ groups, now: new Date().toISOString() });
    const tabsPreload = buildTabsPreloadedState(decision);

    console.log(
      `[popup] hydration: 本地读到 ${decision.activeGroups.length} 个活跃组, ` +
        `treatAsLoaded=${decision.treatAsLoaded}` +
        (decision.treatAsLoaded ? '' : '（空读，不固化 lastLoadedAt，交给 loadGroups 重试）')
    );

    preloadedState = {
      // ⚠️ preloadedState 是整体替换 slice，必须用 initialTabState 合并补全
      // isLoading/error/searchQuery/activeGroupId 等字段，否则它们会变 undefined。
      // tabsPreload 为 null（空读）时只注入 initialTabState（lastLoadedAt=null）。
      tabs: { ...initialTabState, ...(tabsPreload ?? {}) },
      settings,
    };
  } catch (err) {
    console.warn('[popup] local hydration failed, falling back to empty store', err);
  }

  createStore(preloadedState);

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

  // 开发环境便捷基准工具
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as any).__TV_BENCH__ = {
      benchmarkStorageRoundtrip,
      seedLargeDataset
    };
    console.log('[bench] helpers attached to window.__TV_BENCH__');
  }
}

bootstrap();
