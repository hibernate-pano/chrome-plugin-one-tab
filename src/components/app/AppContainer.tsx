import React from 'react';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { AuthProvider } from './AuthProvider';
import { SyncPromptManager } from './SyncPromptManager';
import { MainApp } from './MainApp';

/**
 * 应用容器组件
 * 负责提供所有必要的上下文和错误边界
 */
export const AppContainer: React.FC = () => {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <ThemeProvider>
          <AuthProvider>
            <SyncPromptManager>
              <MainApp />
            </SyncPromptManager>
          </AuthProvider>
        </ThemeProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
};
