import React, { useEffect } from 'react';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { MainApp } from './MainApp';
import { initStorage, getActiveBackend } from '@/storage/storageAdapter';
import { logError, logInfo } from '../../utils/log';

/**
 * 应用容器组件
 * 负责提供所有必要的上下文和错误边界
 */
export const AppContainer: React.FC = () => {
  useEffect(() => {
    // 预热存储，触发 localStorage -> IndexedDB 迁移
    initStorage()
      .then(() => {
        const backend = getActiveBackend();
        if (backend) {
          logInfo(`[storage] active backend: ${backend}`);
        }
      })
      .catch(err => {
        logError('[storage] init failed', err);
      });
  }, []);

  // 2026-10-16：原先这里包了一层 <AuthProvider>，它在挂载后会**立刻**
  // 向云端查会话，命中就自动触发一次整库下载。账号体系已删除，该层没了；
  // 同步现在完全由用户点「同步」或后台 alarm 驱动，不会因为打开 popup
  // 就产生出站流量。
  return (
    <ErrorBoundary>
      <ToastProvider>
        <ThemeProvider>
          <MainApp />
        </ThemeProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
};
