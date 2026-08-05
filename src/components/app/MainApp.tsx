import React, { useState, useEffect, lazy, Suspense, useDeferredValue } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { OnboardingGuide } from '@/components/onboarding/OnboardingGuide';
import { shouldShowOnboarding } from '@/utils/onboardingStorage';
import { getAppVersionLabel } from '@/utils/runtimeInfo';
import { useAppSelector } from '@/store/hooks';
import { formatLastSync } from '@/utils/sessionPresentation';
import { storage, type LastSyncStatus } from '@/utils/storage';
import { NetworkBanner } from '@/components/common/NetworkBanner';

// 使用动态导入懒加载拖放功能
const DndProvider = lazy(() =>
  import('@/components/dnd/DndProvider').then(module => ({ default: module.DndProvider }))
);

const PerformanceTest = lazy(() => import('@/components/performance/PerformanceTest'));

// Settings 全屏面板（懒加载 —— Task 4.3 路由入口；Task 4.4 将替换为完整 6 tab 实现；统计面板已作为 7th tab 挂载于 SettingsTabs 内）
const SettingsTabs = lazy(() =>
  import('@/components/settings/SettingsTabs').then(m => ({ default: m.SettingsTabs }))
);

// 导入样式文件
import '@/styles/drag-drop.css';
import '@/styles/animations.css';

/**
 * Footer 中的紧凑云同步状态读数（S2 F8，S1 §5.3 增强）。
 * 仅在已登录时渲染：状态点（emerald=空闲/成功，amber=同步中，rose=失败）
 * + 「已同步 · X前」/「同步中…」/「同步失败」。未登录返回 null（footer 保持原样）。
 * 非交互只读 —— 只依赖纯工具函数 formatLastSync，不引入 syncService 到主 chunk。
 *
 * S1：新增持久化状态兜底。`persistedLastSyncAt` / `persistedLastSyncError` 来自
 * storage.getLastSyncStatus()（IndexedDB，popup 重开后仍有值）。本次会话有
 * 更新的内存态（tabSlice.lastSyncTime / syncStatus）时优先，持久化错误只在
 * 「本次会话还没同步成功过」时显示（避免成功后残留 rose dot）。
 */
const SyncStatusIndicator: React.FC<{
  persistedLastSyncAt?: string | null;
  persistedLastSyncError?: string | null;
}> = ({ persistedLastSyncAt, persistedLastSyncError }) => {
  const isAuthenticated = useAppSelector((state) => state.auth.isAuthenticated);
  const syncStatus = useAppSelector((state) => state.tabs.syncStatus);
  const lastSyncTime = useAppSelector((state) => state.tabs.lastSyncTime);

  if (!isAuthenticated) return null;

  // 持久化错误仅在没有更新的会话内信号时展示（lastSyncTime 非空 = 本会话已同步成功）
  const showPersistedError = !!persistedLastSyncError && !lastSyncTime;
  const showError = syncStatus === 'error' || (syncStatus !== 'syncing' && showPersistedError);
  const effectiveLastSyncTime = lastSyncTime ?? persistedLastSyncAt ?? null;

  const dotClass =
    showError
      ? 'bg-rose-500'
      : syncStatus === 'syncing'
        ? 'bg-amber-500 animate-pulse'
        : 'bg-emerald-500';

  let label: string;
  if (syncStatus === 'syncing') {
    label = '同步中…';
  } else if (showError) {
    label = '同步失败';
  } else {
    const rel = formatLastSync(effectiveLastSyncTime);
    label = rel === '尚未同步' ? '尚未同步' : `已同步 · ${rel}`;
  }

  return (
    <span className="flex items-center gap-1.5 truncate" title="云同步状态">
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
};

/**
 * 主应用组件
 * 负责应用的主要布局和功能
 */
export const MainApp: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showPerformanceTest, setShowPerformanceTest] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [persistedSyncStatus, setPersistedSyncStatus] = useState<LastSyncStatus>({
    lastSyncAt: null,
    lastSyncError: null,
  });
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // 检查是否需要显示用户引导
  useEffect(() => {
    shouldShowOnboarding().then(should => {
      if (should) {
        setShowOnboarding(true);
      }
    });
  }, []);

  // S1 §5.3：popup 打开时读取持久化同步状态（IndexedDB），
  // footer 跨 popup 重开仍显示「上次同步 x 小时前」/ 最近失败
  useEffect(() => {
    let cancelled = false;
    storage.getLastSyncStatus().then(status => {
      if (!cancelled) setPersistedSyncStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const isAuthenticated = useAppSelector(state => state.auth.isAuthenticated);

  // 切换性能测试页面
  const togglePerformanceTest = () => {
    setShowPerformanceTest(!showPerformanceTest);
  };

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col items-center justify-center">
          加载拖放功能...
        </div>
      }
    >
      <DndProvider>
        <div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col">
          {/* S1 §4.2：离线提示条（仅登录后显示，Header 上方） */}
          {isAuthenticated && <NetworkBanner />}
          {showSettings ? (
            <Suspense fallback={<div className="p-4 text-center">加载设置...</div>}>
              <SettingsTabs onClose={() => setShowSettings(false)} />
            </Suspense>
          ) : showPerformanceTest ? (
            <>
              <div className="bg-primary-600 text-white p-2">
                <div className="w-full px-3 sm:px-4 md:px-6 lg:px-8 flex items-center justify-between">
                  <h1 className="text-lg font-bold">性能测试</h1>
                  <button
                    onClick={togglePerformanceTest}
                    className="px-3 py-1 bg-white text-primary-600 rounded hover:bg-gray-100 transition-colors flat-interaction"
                  >
                    返回主页
                  </button>
                </div>
              </div>
              <main className="flex-1 w-full py-2 px-3 sm:px-4 md:px-6 lg:px-8">
                <Suspense fallback={<div className="p-4 text-center">加载性能测试组件...</div>}>
                  <PerformanceTest />
                </Suspense>
              </main>
            </>
          ) : (
            <>
              <Header onSearch={setSearchQuery} onOpenSettings={() => setShowSettings(true)} />
              <main className={`flex-1 w-full py-2 layout-double-width`}>
                <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                  <TabList searchQuery={deferredSearchQuery} />
                </Suspense>
              </main>
              <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
                <div className="w-full py-2 layout-double-width flex justify-between items-center gap-2">
                  <div className="flex items-center space-x-2 min-w-0">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4 text-primary-600 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span className="truncate">TabStack {getAppVersionLabel()}</span>
                  </div>
                  <div className="flex items-center space-x-2 min-w-0">
                    <SyncStatusIndicator
                      persistedLastSyncAt={persistedSyncStatus.lastSyncAt}
                      persistedLastSyncError={persistedSyncStatus.lastSyncError}
                    />
                    <span className="truncate">Save the session. Find it later.</span>
                    {process.env.NODE_ENV === 'development' && (
                      <button
                        onClick={togglePerformanceTest}
                        className="ml-2 px-2 py-1 bg-purple-500 text-white text-xs rounded hover:bg-purple-600 transition-colors flat-interaction"
                        title="仅在开发环境可见"
                      >
                        性能测试
                      </button>
                    )}
                  </div>
                </div>
              </footer>
            </>
          )}
        </div>
      </DndProvider>

      {/* 用户引导弹窗 */}
      {showOnboarding && (
        <OnboardingGuide onComplete={() => setShowOnboarding(false)} />
      )}
    </Suspense>
  );
};
