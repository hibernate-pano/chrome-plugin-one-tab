import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { createStore, store, type PreloadedState } from '../store';
import App from './App';
import '../styles/global.css';
import { initStorage } from '@/storage/storageAdapter';
import { storage } from '@/utils/storage';
import { benchmarkStorageRoundtrip, seedLargeDataset } from '@/utils/performanceTest';

/**
 * 在 createRoot 之前先 await 把 local 数据塞进 preloadedState，
 * 让首屏 render 直接显示已保存的标签组，避免 EmptyState 闪烁。
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
