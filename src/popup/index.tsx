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

async function bootstrap() {
  let preloadedState: PreloadedState | undefined;

  try {
    await initStorage();
    const { groups, settings, groupsReadFailed, groupsReadError } = await storage.hydrateAll();
    const decision = decideTabsHydration({
      groups,
      now: new Date().toISOString(),
      readFailed: groupsReadFailed === true,
    });
    const tabsPreload = buildTabsPreloadedState(decision);

    if (groupsReadFailed) {
      console.warn(
        '[popup] hydration: 读盘失败，不当作真空，交给 loadGroups 重试。错误:',
        groupsReadError instanceof Error ? groupsReadError.message : String(groupsReadError)
      );
    }

    preloadedState = {
      tabs: { ...initialTabState, ...(tabsPreload ?? {}) },
      settings,
    };
  } catch (error) {
    console.warn('[popup] local hydration failed, falling back to empty store', error);
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
