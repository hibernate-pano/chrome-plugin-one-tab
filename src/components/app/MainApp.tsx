import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Header } from '@/components/layout/Header';
import { TabList } from '@/components/tabs/TabList';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';

// 使用动态导入懒加载拖放功能
const DndProvider = lazy(() =>
  import('@/components/dnd/DndProvider').then(module => ({ default: module.DndProvider }))
);

// 使用动态导入懒加载性能测试组件
const PerformanceTest = lazy(() => import('@/components/performance/PerformanceTest'));

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
  const [showPerformanceTest, setShowPerformanceTest] = useState(false);
  const layoutMode = useAppSelector(state => state.settings.layoutMode);

  // 加载用户设置
  useEffect(() => {
    dispatch(loadSettings());
  }, [dispatch]);

  // 切换性能测试页面
  const togglePerformanceTest = () => {
    setShowPerformanceTest(!showPerformanceTest);
  };

  // 根据布局模式和搜索状态确定容器宽度类
  const getContainerWidthClass = () => {
    // 搜索模式下使用单栏宽度
    if (searchQuery) {
      return 'layout-single-width';
    }
    // 根据布局模式选择宽度
    return layoutMode === 'double' ? 'layout-double-width' : 'layout-single-width';
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
          {showPerformanceTest ? (
            <>
              <div className="bg-primary-600 text-white p-2">
                <div className="w-full px-3 sm:px-4 md:px-6 lg:px-8 flex items-center justify-between">
                  <h1 className="text-lg font-bold">性能测试</h1>
                  <button
                    onClick={togglePerformanceTest}
                    className="px-3 py-1 bg-white text-primary-600 rounded hover:bg-gray-100 transition-colors"
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
              <Header onSearch={setSearchQuery} searchQuery={searchQuery} />
              <main className={`flex-1 w-full py-2 ${getContainerWidthClass()}`}>
                <Suspense fallback={<div className="p-4 text-center">加载标签列表...</div>}>
                  <TabList searchQuery={searchQuery} />
                </Suspense>
              </main>
              <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
                <div className={`w-full py-2 ${getContainerWidthClass()} flex justify-between items-center`}>
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
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>TabVault Pro v1.5.12</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span>高效的标签页管理工具</span>
                    {process.env.NODE_ENV === 'development' && (
                      <button
                        onClick={togglePerformanceTest}
                        className="ml-2 px-2 py-1 bg-purple-500 text-white text-xs rounded hover:bg-purple-600 transition-colors"
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
    </Suspense>
  );
};
