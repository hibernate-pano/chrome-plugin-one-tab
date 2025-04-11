import React, { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { DndProvider } from '@/components/dnd/DndProvider';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { syncService } from '@/services/syncService';
import { auth as supabaseAuth } from '@/utils/supabase';
import { authCache } from '@/utils/authCache';
import { store } from '@/store';

const App: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [initialAuthLoaded, setInitialAuthLoaded] = useState(false);

  const { isAuthenticated } = useAppSelector(state => state.auth);

  // 页面可见性变化检测
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated) {
        console.log('页面变为可见状态，检查云端数据更新...');
        // 当页面变为可见时，从云端获取最新数据
        syncService.syncFromCloud().catch(err => {
          console.error('检查云端数据更新失败:', err);
        });
      }
    };

    // 添加可见性变化事件监听
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 页面加载时也检查一次
    if (isAuthenticated) {
      syncService.syncFromCloud().catch(err => {
        console.error('初始检查云端数据失败:', err);
      });
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isAuthenticated]);

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

  return (
    <DndProvider>
      <div className="min-h-screen bg-white flex flex-col">
        <Header onSearch={setSearchQuery} />
        <main className="flex-1 container mx-auto py-2 px-2 max-w-6xl">
          <TabList searchQuery={searchQuery} />
        </main>
        <footer className="py-2 px-2 bg-white border-t border-gray-200 text-xs text-gray-600">
          <div className="container mx-auto max-w-6xl flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              <span className="text-xs">OneTabPlus v1.4.3</span>
            </div>
            <div>
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
            </div>
          </div>
        </footer>
      </div>
    </DndProvider>
  );
};

export default App;
