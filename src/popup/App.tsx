import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Header } from '@/components/layout/Header';
// 使用动态导入懒加载标签列表
const SimpleTabList = lazy(() => import('@/components/tabs/SimpleTabList').then(module => ({ default: module.SimpleTabList })));
// 使用动态导入懒加载拖放功能
const DndProvider = lazy(() => import('@/components/dnd/DndProvider').then(module => ({ default: module.DndProvider })));
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';
import { store } from '@/store';
import { hasSyncPromptShown, markSyncPromptShown } from '@/utils/syncPromptUtils';
import { checkCloudData } from '@/utils/cloudDataUtils';
// 使用动态导入懒加载同步提示对话框
const SyncPromptModal = lazy(() => import('@/components/sync/SyncPromptModal'));
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';

// 使用动态导入懒加载性能测试组件
const PerformanceTest = lazy(() => import('@/components/performance/PerformanceTest'));

const App: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [initialAuthLoaded, setInitialAuthLoaded] = useState(false);
  const [showSyncPrompt, setShowSyncPrompt] = useState(false);
  const [hasCloudData, setHasCloudData] = useState(false);
  const [showPerformanceTest, setShowPerformanceTest] = useState(false);

  const { isAuthenticated, user } = useAppSelector(state => state.auth);

  // 检查是否需要显示同步提示
  useEffect(() => {
    const checkSyncPrompt = async () => {
      // 只有在用户登录时才检查
      if (isAuthenticated && user && initialAuthLoaded) {
        // 检查是否已经显示过同步提示
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
              isAuthenticated: true
            }
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
        // 使用 getSession 而不是 getCurrentUser 来避免未登录用户的错误
        const { data } = await supabaseAuth.getSession();
        if (data.session) {
          // 只有确认有会话时才调用 getCurrentUser
          dispatch(getCurrentUser())
            .unwrap()
            .then(user => {
              if (user) {
                console.log('用户已自动登录:', user.email);
              }
            })
            .catch(() => {
              console.log('获取用户信息失败，但会话存在');
            });
        } else {
          console.log('没有活跃会话，用户未登录');
        }
      } catch (err) {
        console.log('检查会话状态时出错，假定用户未登录');
      }
    };

    checkSession();
  }, [dispatch, initialAuthLoaded]);

  // 切换性能测试页面
  const togglePerformanceTest = () => {
    setShowPerformanceTest(!showPerformanceTest);
  };

  return (
    <ToastProvider>
      <ThemeProvider>
        <Suspense fallback={<div className="min-h-screen bg-white dark:bg-gray-900 dark:text-gray-100 flex flex-col items-center justify-center">加载拖放功能...</div>}>
          <DndProvider>
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
                      <SimpleTabList searchQuery={searchQuery} />
                    </Suspense>
                  </main>
                  <footer className="py-2 px-2 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
                    <div className="container mx-auto max-w-6xl flex justify-between items-center">
                      <div className="flex items-center space-x-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
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
                          <button
                            onClick={togglePerformanceTest}
                            className="ml-2 px-2 py-1 bg-purple-500 text-white text-xs rounded hover:bg-purple-600"
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

              {/* 同步提示对话框 */}
              {showSyncPrompt && (
                <Suspense fallback={<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">加载中...</div>}>
                  <SyncPromptModal
                    onClose={handleCloseSyncPrompt}
                    hasCloudData={hasCloudData}
                  />
                </Suspense>
              )}
            </div>
          </DndProvider>
        </Suspense>
      </ThemeProvider>
    </ToastProvider>
  );
};

export default App;
