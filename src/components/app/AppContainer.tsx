import React, { useEffect } from 'react';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { AuthProvider } from './AuthProvider';
import { MainApp } from './MainApp';
import { initStorage, getActiveBackend } from '@/storage/storageAdapter';

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
          console.log(`[storage] active backend: ${backend}`);
        }
      })
      .catch(err => {
        console.error('[storage] init failed', err);
      });
  }, []);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <ThemeProvider>
          <AuthProvider>
            <MainApp />
          </AuthProvider>
        </ThemeProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
};
