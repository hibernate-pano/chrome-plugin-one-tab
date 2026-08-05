import React from 'react';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { AuthProvider } from './AuthProvider';
import { MainApp } from './MainApp';

/**
 * 应用容器组件
 * 负责提供所有必要的上下文和错误边界。
 *
 * S2 P1 Task 1.3: 此处不再调用 initStorage()。原因是 popup 入口
 * (src/popup/index.tsx::bootstrap) 已经在 createRoot 之前 await
 * initStorage() 完成迁移 / KV 初始化；这里的 useEffect 是「同一进程
 * 内的二次调用」，但 ensureInitialized 是幂等的，并不会真的节省时间，
 * 反而在测试里产生「storage 初始化完成」事件被多次触发的假象。
 */
export const AppContainer: React.FC = () => {
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
