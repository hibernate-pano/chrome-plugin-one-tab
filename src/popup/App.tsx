import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import { ImprovedTabList } from '@/components/tabs/ImprovedTabList';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
// 使用新版settings功能
import { loadSettings } from '@/features/settings/store/settingsSlice';
// 使用新版auth功能
import { restoreSession } from '@/features/auth/store/authSlice';
import { auth as supabaseAuth } from '@/utils/supabase';
// 使用新版AuthCache
import { authCache } from '@/shared/utils/authCache';
import { store } from '@/app/store';
import { hasSyncPromptShown, markSyncPromptShown } from '@/utils/syncPromptUtils';
import { checkCloudData } from '@/utils/cloudDataUtils';
import { autoSyncManager } from '@/services/autoSyncManager';
import { simpleSyncService } from '@/services/simpleSyncService';
import { storage } from '@/shared/utils/storage';
// 使用动态导入懒加载同步提示对话框
const SyncPromptModal = lazy(() => import('@/components/sync/SyncPromptModal'));
// 使用动态导入懒加载调试面板
const SyncDebugPanel = lazy(() => import('@/components/sync/SyncDebugPanel'));
// 使用动态导入懒加载数据库迁移提示
const DatabaseMigrationPrompt = lazy(() => import('@/components/sync/DatabaseMigrationPrompt'));
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { ErrorProvider } from '@/shared/contexts/ErrorContext';
import { OnboardingSystem } from '@/features/onboarding/components/OnboardingSystem';

// 导入样式文件
import '@/styles/drag-drop.css';
import '@/styles/animations.css';

// 使用动态导入懒加载性能测试组件
const PerformanceTest = lazy(() => import('@/components/performance/PerformanceTest'));

const App: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [initialAuthLoaded, setInitialAuthLoaded] = useState(false);
  const [showSyncPrompt, setShowSyncPrompt] = useState(false);
  const [hasCloudData, setHasCloudData] = useState(false);
  const [showPerformanceTest, setShowPerformanceTest] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [showMigrationPrompt, setShowMigrationPrompt] = useState(false);

  const { status, user } = useAppSelector(state => state.auth);
  const isAuthenticated = status === 'authenticated';

  // 检查是否需要显示同步提示
  useEffect(() => {
    const checkSyncPrompt = async () => {
      // 只有在用户登录时才检查
      if (isAuthenticated && user && initialAuthLoaded) {
        // 检查本地是否有数据
        const localGroups = await storage.getGroups();
        const hasLocalData = localGroups.length > 0;

        // 如果本地没有数据，检查云端是否有数据
        if (!hasLocalData) {
          console.log('本地没有数据，检查云端数据');
          // 检查云端是否有数据
          const cloudHasData = await checkCloudData();

          // 设置云端数据状态
          setHasCloudData(cloudHasData);

          // 如果云端有数据，显示同步提示（忽略之前的显示记录）
          if (cloudHasData) {
            console.log('检测到云端有数据，显示同步提示');
            setShowSyncPrompt(true);
          } else {
            console.log('云端没有数据，不显示同步提示');
          }
        } else {
          // 本地有数据，检查是否已经显示过同步提示
          if (!hasSyncPromptShown(user.id)) {
            // 检查云端是否有数据
            const cloudHasData = await checkCloudData();

            // 设置云端数据状态
            setHasCloudData(cloudHasData);

            // 如果云端有数据，显示同步提示
            if (cloudHasData) {
              console.log('检测到云端有数据，显示同步提示');
              setShowSyncPrompt(true);
            } else {
              console.log('云端没有数据，不显示同步提示');
              // 标记已经显示过同步提示，避免再次检查
              markSyncPromptShown(user.id);
            }
          } else {
            console.log('已经显示过同步提示，不再显示');
          }
        }
      }
    };

    checkSyncPrompt();
  }, [isAuthenticated, user, initialAuthLoaded]);

  // 处理关闭同步提示
  const handleCloseSyncPrompt = () => {
    if (user) {
      // 标记已经显示过同步提示
      markSyncPromptShown(user.id);
    }
    setShowSyncPrompt(false);
  };

  // 首先从缓存加载认证状态，避免闪烁
  useEffect(() => {
    const loadCachedAuth = async () => {
      try {
        // 从缓存加载认证状态
        const cachedAuth = await authCache.getAuthState();

        if (cachedAuth && cachedAuth.isAuthenticated && cachedAuth.user) {
          // 如果有缓存的认证状态，先将其设置到 Redux 状态
          store.dispatch({
            type: 'auth/setFromCache',
            payload: {
              user: cachedAuth.user,
            },
          });
          console.log('从缓存加载用户认证状态:', cachedAuth.user.email);
        }

        setInitialAuthLoaded(true);
      } catch (error) {
        console.error('加载缓存认证状态失败:', error);
        setInitialAuthLoaded(true);
      }
    };

    loadCachedAuth();
  }, []);

  // 然后加载设置并检查实际的登录状态
  useEffect(() => {
    if (!initialAuthLoaded) return;

    // 加载用户设置
    dispatch(loadSettings());

    // 检查是否有已登录的用户会话，实现自动登录
    // 使用 supabase 直接检查会话，避免触发错误
    const checkSession = async () => {
      try {
        // 首先执行数据迁移
        try {
          const { dataMigration } = await import('@/services/dataMigration');
          await dataMigration.createBackup(); // 创建备份
          await dataMigration.checkAndMigrate(); // 执行迁移
          const isValid = await dataMigration.validateMigration(); // 验证迁移

          if (!isValid) {
            console.warn('数据迁移验证失败，但继续启动应用');
          } else {
            console.log('✅ 数据迁移完成');
          }
        } catch (error) {
          console.error('数据迁移失败:', error);
          // 不阻止应用启动，但记录错误
        }

        // 使用 getSession 而不是 getCurrentUser 来避免未登录用户的错误
        const { data } = await supabaseAuth.getSession();
        if (data.session) {
          // 只有确认有会话时才调用 restoreSession
          const result = await dispatch(restoreSession()).unwrap();
          if (result && result.user) {
            console.log('用户已自动登录:', result.user.email);
            // 更新认证缓存
            await authCache.saveAuthState(result.user, true);

            // 认证恢复完成后，检查数据库迁移和触发同步
            setTimeout(async () => {
              console.log('🔄 认证恢复完成，检查数据库迁移状态');

              // 检查是否需要数据库迁移
              try {
                const { databaseSchemaManager } = await import('@/services/databaseSchemaManager');
                const needsMigration = await databaseSchemaManager.shouldShowMigrationPrompt();

                if (needsMigration) {
                  console.log('⚠️ 需要数据库迁移，显示迁移提示');
                  setShowMigrationPrompt(true);
                  return; // 暂停同步，等待迁移完成
                }
              } catch (error) {
                console.warn('检查数据库迁移状态失败:', error);
              }

              // 触发乐观锁同步
              console.log('🔄 触发乐观锁同步');
              try {
                const { optimisticSyncService } = await import('@/services/optimisticSyncService');
                optimisticSyncService.scheduleSync();
              } catch (error) {
                console.error('触发乐观锁同步失败:', error);
                // 降级到简化同步
                simpleSyncService.scheduleUpload();
              }
            }, 1000);
          } else {
            console.log('会话恢复失败，清除认证状态');
            await authCache.clearAuthState();
            store.dispatch({ type: 'auth/resetAuthState' });
          }
        } else {
          console.log('没有活跃会话，用户未登录');
          // 重要：如果没有有效会话，清除认证状态和缓存
          console.log('清除无效的认证缓存');
          await authCache.clearAuthState();
          store.dispatch({ type: 'auth/resetAuthState' });
        }
      } catch (err) {
        console.log('检查会话状态时出错，假定用户未登录');
        // 同样清除认证状态和缓存
        await authCache.clearAuthState();
        store.dispatch({ type: 'auth/resetAuthState' });
      }
    };

    checkSession();
  }, [dispatch, initialAuthLoaded]);

  // 初始化自动同步管理器
  useEffect(() => {
    if (initialAuthLoaded) {
      autoSyncManager.initialize().catch(error => {
        console.error('自动同步管理器初始化失败:', error);
      });

      // 组件卸载时清理
      return () => {
        autoSyncManager.destroy();
      };
    }
  }, [initialAuthLoaded]);

  // 切换性能测试页面
  const togglePerformanceTest = () => {
    setShowPerformanceTest(!showPerformanceTest);
  };

  // 切换调试面板
  const toggleDebugPanel = () => {
    setShowDebugPanel(!showDebugPanel);
  };

  // 处理数据库迁移完成
  const handleMigrationComplete = async () => {
    console.log('✅ 数据库迁移完成，重新启动同步');

    // 触发乐观锁同步
    try {
      const { optimisticSyncService } = await import('@/services/optimisticSyncService');
      optimisticSyncService.scheduleSync();
    } catch (error) {
      console.error('迁移后触发同步失败:', error);
      // 降级到简化同步
      simpleSyncService.scheduleUpload();
    }
  };

  return (
    <ErrorProvider>
      <ToastProvider>
        <ThemeProvider>
          <OnboardingSystem autoStart={true} storageKey="onetab-onboarding-state">
            <Suspense
              fallback={
                <div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col items-center justify-center">
                  加载拖放功能...
                </div>
              }
            >
              <div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col">
                {showPerformanceTest ? (
                  <>
                    <div className="bg-primary-600 text-white p-2">
                      <div className="container mx-auto flex items-center justify-between max-w-6xl">
                        <h1 className="text-lg font-bold">性能测试</h1>
                        <button
                          onClick={togglePerformanceTest}
                          className="px-3 py-1 bg-white text-primary-600 rounded hover:bg-gray-100"
                        >
                          返回主页
                        </button>
                      </div>
                    </div>
                    <main className="flex-1 container mx-auto py-2 px-2 max-w-6xl">
                      <Suspense fallback={<div className="p-4 text-center">加载性能测试组件...</div>}>
                        <PerformanceTest />
                      </Suspense>
                    </main>
                  </>
                ) : (
                  <>
                    <Header onSearch={setSearchQuery} />
                    <main className="flex-1 container mx-auto py-2 px-2 max-w-6xl">
                      <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                        <ImprovedTabList searchQuery={searchQuery} />
                      </Suspense>
                    </main>
                    <footer className="py-2 px-2 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
                      <div className="container mx-auto max-w-6xl flex justify-between items-center">
                        <div className="flex items-center space-x-2">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4 text-primary-600"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                            />
                          </svg>
                          <span className="text-xs">OneTabPlus v1.5.8</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          {isAuthenticated ? (
                            <span className="flex items-center bg-green-50 text-green-700 px-3 py-1 rounded-full text-xs font-medium">
                              <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
                              已同步
                            </span>
                          ) : (
                            <span className="flex items-center bg-gray-100 text-gray-600 px-3 py-1 rounded-full text-xs font-medium">
                              <span className="inline-block w-2 h-2 rounded-full bg-gray-400 mr-2"></span>
                              未登录
                            </span>
                          )}
                          {process.env.NODE_ENV === 'development' && (
                            <>
                              <button
                                onClick={togglePerformanceTest}
                                className="ml-2 px-2 py-1 bg-purple-500 text-white text-xs rounded hover:bg-purple-600"
                                title="仅在开发环境可见"
                              >
                                性能测试
                              </button>
                              <button
                                onClick={toggleDebugPanel}
                                className="ml-2 px-2 py-1 bg-orange-500 text-white text-xs rounded hover:bg-orange-600"
                                title="同步调试面板"
                              >
                                调试
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </footer>
                  </>
                )}

                {/* 同步提示对话框 */}
                {showSyncPrompt && (
                  <Suspense
                    fallback={
                      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                        加载中...
                      </div>
                    }
                  >
                    <SyncPromptModal onClose={handleCloseSyncPrompt} hasCloudData={hasCloudData} />
                  </Suspense>
                )}

                {/* 调试面板 */}
                {showDebugPanel && (
                  <Suspense
                    fallback={
                      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                        加载调试面板...
                      </div>
                    }
                  >
                    <SyncDebugPanel isOpen={showDebugPanel} onClose={() => setShowDebugPanel(false)} />
                  </Suspense>
                )}

                {/* 数据库迁移提示 */}
                {showMigrationPrompt && (
                  <Suspense
                    fallback={
                      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                        加载迁移提示...
                      </div>
                    }
                  >
                    <DatabaseMigrationPrompt
                      isOpen={showMigrationPrompt}
                      onClose={() => setShowMigrationPrompt(false)}
                      onMigrationComplete={handleMigrationComplete}
                    />
                  </Suspense>
                )}
              </div>
            </Suspense>
          </OnboardingSystem>
        </ThemeProvider>
      </ToastProvider>
    </ErrorProvider>
  );
};

export default App;
