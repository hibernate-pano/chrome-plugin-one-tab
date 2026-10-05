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
            <Header onSearch={setSearchQuery} />
            <main className={`flex-1 w-full py-2 ${getContainerWidthClass()}`}>
              <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                <TabList searchQuery={deferredSearchQuery} />
              </Suspense>
            </main>
              <footer className="app-shell theme-shell border-t theme-border-default text-xs text-gray-600 dark:text-gray-400">
                {/* 版本 + slogan 一行居中：原左右分挂两头，弱信息占满整行宽 */}
                <div className={`w-full py-2 ${getContainerWidthClass()} flex justify-center items-center gap-2`}>
                  <span className="flex items-center gap-1.5">
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
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    TapStack {getAppVersionLabel()}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Save the session. Find it later.</span>
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
