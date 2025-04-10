import React, { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { DndProvider } from '@/components/dnd/DndProvider';
import { useAppDispatch } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';

const App: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');

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
