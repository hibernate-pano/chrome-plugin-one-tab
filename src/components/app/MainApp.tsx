import React, { useState, useEffect, Suspense, useDeferredValue } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { useAppDispatch } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { OnboardingGuide } from '@/components/onboarding/OnboardingGuide';
import { shouldShowOnboarding } from '@/utils/onboardingStorage';
import { getAppVersionLabel } from '@/utils/runtimeInfo';

// 导入样式文件
import '@/styles/drag-drop.css';
import '@/styles/animations.css';

/**
 * 主应用组件
 * 负责应用的主要布局和功能
 */
export const MainApp: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // 加载用户设置
  useEffect(() => {
    dispatch(loadSettings());
  }, [dispatch]);

  // 检查是否需要显示用户引导
  useEffect(() => {
    shouldShowOnboarding().then(should => {
      if (should) {
        setShowOnboarding(true);
      }
    });
  }, []);

  // 统一使用相同宽度，单栏和双栏布局保持一致
  const getContainerWidthClass = () => {
    return 'layout-double-width';
  };

  return (
    <Suspense
      fallback={
        <div className="app-shell theme-shell min-h-screen dark:text-gray-100 flex flex-col items-center justify-center">
          加载中...
        </div>
      }
    >
      <div className="app-shell theme-shell min-h-screen dark:text-gray-100 flex flex-col">
          <>
            <a href="#tapstack-main" className="skip-to-content">
              跳到会话列表
            </a>
            <Header onSearch={setSearchQuery} />
            <main id="tapstack-main" className={`flex-1 w-full py-3 sm:py-4 ${getContainerWidthClass()}`} tabIndex={-1}>
              <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                <TabList searchQuery={deferredSearchQuery} />
              </Suspense>
            </main>
              <footer className="app-shell theme-shell border-t theme-border-default text-xs text-gray-600 dark:text-gray-400">
                {/* 弱信息收进右下小字：版本号低优先级，不占整行居中 */}
                <div className={`w-full py-1.5 ${getContainerWidthClass()} flex justify-end items-center`}>
                  <span className="tab-group-time" title="TapStack 版本">TapStack {getAppVersionLabel()}</span>
                </div>
              </footer>
            </>
        </div>

      {/* 用户引导弹窗 */}
      {showOnboarding && (
        <OnboardingGuide onComplete={() => setShowOnboarding(false)} />
      )}
    </Suspense>
  );
};
