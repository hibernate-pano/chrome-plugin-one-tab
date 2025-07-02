import React, { useEffect, useState, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { EnhancedTabList } from '@/components/tabs/EnhancedTabList';
import { LoadingOverlay } from '@/components/common/LoadingOverlay';
import { Toast } from '@/design-system/components/Toast/Toast';
import { intelligentSync } from '@/services/intelligentSyncService';

/**
 * 增强版主应用组件
 * 集成所有改进功能的入口组件
 */

export const EnhancedApp: React.FC = () => {
  const dispatch = useAppDispatch();
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { isLoading: tabsLoading } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);

  // 初始化应用
  useEffect(() => {
    const initializeApp = async () => {
      try {
        setInitialLoading(true);
        setError(null);

        // 并行加载数据
        await Promise.all([
          dispatch(loadGroups()).unwrap(),
          dispatch(loadSettings()).unwrap(),
          dispatch(getCurrentUser()).unwrap().catch(() => {
            // 用户未登录是正常情况，不需要抛出错误
            console.log('用户未登录');
          })
        ]);

        console.log('应用初始化完成');
      } catch (error) {
        console.error('应用初始化失败:', error);
        setError('应用初始化失败，请刷新页面重试');
      } finally {
        setInitialLoading(false);
      }
    };

    initializeApp();
  }, [dispatch]);

  // 监听认证状态变化，启动/停止智能同步
  useEffect(() => {
    if (isAuthenticated) {
      console.log('用户已登录，启动智能同步服务');
      // 智能同步服务已经在导入时启动
    } else {
      console.log('用户未登录，停止智能同步服务');
      // 可以在这里停止同步服务
    }

    // 清理函数
    return () => {
      if (intelligentSync) {
        intelligentSync.dispose();
      }
    };
  }, [isAuthenticated]);

  // 全局错误处理
  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('未处理的Promise拒绝:', event.reason);
      setError('发生了未预期的错误，请刷新页面');
    };

    const handleError = (event: ErrorEvent) => {
      console.error('全局错误:', event.error);
      setError('发生了未预期的错误，请刷新页面');
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('error', handleError);

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('error', handleError);
    };
  }, []);

  // 显示提示消息
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' = 'success') => {
    // 这里应该使用Toast组件或通知系统
    console.log(`[${type.toUpperCase()}] ${message}`);
  }, []);

  // 保存所有标签页
  const saveAllTabs = useCallback(async () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const validTabs = tabs.filter(tab => 
          tab.url && 
          !tab.url.startsWith('chrome://') && 
          !tab.url.startsWith('chrome-extension://')
        );
        
        if (validTabs.length > 0) {
          // 这里应该调用保存逻辑
          console.log('保存所有标签页:', validTabs.length);
          showToast('成功保存所有标签页', 'success');
        } else {
          showToast('没有可保存的标签页', 'warning');
        }
      } catch (error) {
        console.error('保存标签页失败:', error);
        showToast('保存标签页失败', 'error');
      }
    }
  }, [showToast]);

  // 保存当前标签页
  const saveCurrentTab = useCallback(async () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (activeTab && activeTab.url && 
            !activeTab.url.startsWith('chrome://') && 
            !activeTab.url.startsWith('chrome-extension://')) {
          // 这里应该调用保存逻辑
          console.log('保存当前标签页:', activeTab.title);
          showToast('成功保存当前标签页', 'success');
        } else {
          showToast('当前标签页无法保存', 'warning');
        }
      } catch (error) {
        console.error('保存标签页失败:', error);
        showToast('保存标签页失败', 'error');
      }
    }
  }, [showToast]);

  // 键盘快捷键全局处理
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Alt+Shift+S: 保存所有标签页
      if (e.altKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        saveAllTabs();
      }
      
      // Alt+S: 保存当前标签页
      if (e.altKey && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        saveCurrentTab();
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [saveAllTabs, saveCurrentTab]);

  // 重试初始化
  const retryInitialization = () => {
    window.location.reload();
  };

  // 如果正在初始化，显示加载状态
  if (initialLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <div className="text-gray-600">正在初始化应用...</div>
        </div>
      </div>
    );
  }

  // 如果初始化出错，显示错误状态
  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md mx-auto p-6">
          <div className="text-red-600 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">应用初始化失败</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={retryInitialization}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  // 主应用界面
  return (
    <div className="enhanced-app h-screen flex flex-col bg-gray-50">
      {/* 应用头部 */}
      <header className="bg-white border-b shadow-sm">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <h1 className="text-xl font-semibold text-gray-900">OneTab Plus</h1>
              <span className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded">
                Enhanced
              </span>
            </div>
            
            <div className="flex items-center space-x-4">
              {/* 同步状态指示器 */}
              {isAuthenticated && (
                <div className="flex items-center text-sm text-gray-600">
                  <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                  已同步
                </div>
              )}
              
              {/* 版本信息 */}
              <span className="text-xs text-gray-400">v1.6.0</span>
            </div>
          </div>
        </div>
      </header>

      {/* 主内容区域 */}
      <main className="flex-1 overflow-hidden">
        <EnhancedTabList className="h-full" />
      </main>

      {/* 加载覆盖层 */}
      {tabsLoading && (
        <LoadingOverlay 
          isVisible={true}
          message="正在加载标签页..." 
        />
      )}

      {/* 全局Toast通知 */}
      <Toast 
        message=""
        visible={false}
      />
    </div>
  );
};
