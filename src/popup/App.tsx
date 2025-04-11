import React, { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { DndProvider } from '@/components/dnd/DndProvider';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { syncService } from '@/services/syncService';

const App: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');

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

  useEffect(() => {
    // 加载用户设置
    dispatch(loadSettings());

    // 检查是否有已登录的用户会话，实现自动登录
    dispatch(getCurrentUser())
      .unwrap()
      .then(user => {
        if (user) {
          console.log('用户已自动登录:', user.email);
        }
      })
      .catch(error => {
        console.error('自动登录失败:', error);
      });
  }, [dispatch]);

  return (
    <DndProvider>
      <div className="w-[800px] h-[600px] bg-background transition-material">
        <Header onSearch={setSearchQuery} />
        <main className="p-4">
          <TabList searchQuery={searchQuery} />
        </main>
      </div>
    </DndProvider>
  );
};

export default App;
