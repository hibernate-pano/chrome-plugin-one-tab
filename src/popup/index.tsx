import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../store';
import App from './App';
import '../styles/global.css';
import { benchmarkStorageRoundtrip, seedLargeDataset } from '@/utils/performanceTest';
import { logInfo } from '../utils/log';

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
  logInfo('[bench] helpers attached to window.__TV_BENCH__');
}