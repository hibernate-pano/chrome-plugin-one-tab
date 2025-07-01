import React, { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadSettings } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';
import { loadGroups, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { ToastProvider } from '@/contexts/ToastContext';
import { ThemeProvider } from '@/contexts/ThemeContext';

// 使用修复的组件
import { SimpleTabDisplay } from '@/components/tabs/SimpleTabDisplay';
import { QuickActionPanel } from '@/components/common/QuickActionPanelFixed';
import { LoadingOverlay } from '@/components/common/LoadingOverlayFixed';
import { Toast } from '@/components/common/ToastFixed';

// 服务
import { IntelligentSyncService, SyncConfig } from '@/services/intelligentSyncServiceFixed';
import { EnhancedSearchService } from '@/services/smartTabAnalyzerFixed';

// 默认同步配置
const defaultSyncConfig: SyncConfig = {
  triggers: {
    onDataChange: true,
    onNetworkRestore: true,
    onAppFocus: false,
    periodic: 300 // 5分钟
  },
  conflictResolution: {
    strategy: 'auto',
    autoMergeRules: {
      preferNewer: true,
      preserveLocal: true,
      preserveRemote: true
    }
  },
  optimization: {
    batchUpdates: true,
    deltaSync: true,
    compression: true,
    maxRetries: 3
  }
};

const EnhancedAppIntegrated: React.FC = () => {
  const dispatch = useAppDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [showQuickActions, setShowQuickActions] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const { groups, isLoading: tabsLoading } = useAppSelector(state => state.tabs);

  // 获取所有标签页
  const allTabs = groups.flatMap(group => group.tabs);

  // 初始化服务
  const [syncService] = useState(() => new IntelligentSyncService(defaultSyncConfig));
  const [analyzerService] = useState(() => new EnhancedSearchService());

  // 初始化应用
  useEffect(() => {
    const initApp = async () => {
      setIsLoading(true);
      setLoadingMessage('正在初始化应用...');
      
      try {
        // 加载设置和数据
        await Promise.all([
          dispatch(loadSettings()).unwrap(),
          dispatch(loadGroups()).unwrap()
        ]);
        
        // 获取当前用户
        if (isAuthenticated) {
          await dispatch(getCurrentUser()).unwrap();
        }
        
        // 初始化同步服务（可选）
        console.log('同步服务已初始化:', syncService);
        
        setToast({ message: '应用初始化完成', type: 'success' });
      } catch (error) {
        console.error('应用初始化失败:', error);
        setToast({ message: '应用初始化失败', type: 'error' });
      } finally {
        setIsLoading(false);
        setLoadingMessage('');
      }
    };

    initApp();
  }, [dispatch, isAuthenticated, syncService]);

  // 快捷键处理
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+K 或 Cmd+K 打开快捷操作面板
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setShowQuickActions(true);
      }
      
      // Escape 关闭快捷操作面板
      if (event.key === 'Escape') {
        setShowQuickActions(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 同步处理
  const handleSync = useCallback(async () => {
    if (!isAuthenticated || !user) {
      setToast({ message: '请先登录', type: 'error' });
      return;
    }

    setIsLoading(true);
    setLoadingMessage('正在同步数据...');
    
    try {
      await dispatch(syncTabsFromCloud()).unwrap();
      setToast({ message: '同步完成', type: 'success' });
    } catch (error) {
      console.error('同步失败:', error);
      setToast({ message: '同步失败', type: 'error' });
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }, [isAuthenticated, user, dispatch]);

  // 搜索处理
  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    
    if (query.trim() && allTabs.length > 0) {
      try {
        const results = await analyzerService.search(allTabs, query);
        console.log('搜索结果:', results);
        // 这里可以更新搜索结果状态，或者传递给标签列表组件
      } catch (error) {
        console.error('搜索失败:', error);
        setToast({ message: '搜索失败', type: 'error' });
      }
    }
  }, [allTabs, analyzerService]);

  // 快捷操作回调（保留用于后续扩展）
  const handleQuickAction = useCallback(async (action: string, params?: any) => {
    console.log('快捷操作:', action, params);
    try {
      switch (action) {
        case 'sync':
          await handleSync();
          break;
        case 'search':
          if (params?.query) {
            await handleSearch(params.query);
          }
          break;
        case 'export':
          // 导出逻辑
          setToast({ message: '导出功能开发中', type: 'info' });
          break;
        case 'import':
          // 导入逻辑
          setToast({ message: '导入功能开发中', type: 'info' });
          break;
        default:
          console.log('未知操作:', action, params);
      }
    } catch (error) {
      console.error('操作失败:', error);
      setToast({ message: '操作失败', type: 'error' });
    }
    
    // 关闭快捷操作面板
    setShowQuickActions(false);
  }, [handleSync, handleSearch]);

  // Toast 关闭处理
  const handleToastClose = useCallback(() => {
    setToast(null);
  }, []);

  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
          {/* 头部 */}
          <Header 
            onSearch={handleSearch}
          />

          {/* 主内容区域 */}
          <div className="container mx-auto px-4 py-6">          {/* 标签页列表 */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm">
            <SimpleTabDisplay
              searchQuery={searchQuery}
              className="h-full"
            />
          </div>
          </div>

          {/* 快捷操作面板 */}
          {showQuickActions && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-gray-800 rounded-lg w-full max-w-2xl max-h-96 overflow-hidden">
                <QuickActionPanel
                  isOpen={showQuickActions}
                  onClose={() => setShowQuickActions(false)}
                />
                
                {/* 临时添加操作按钮演示 */}
                <div className="p-4 border-t">
                  <button
                    onClick={() => handleQuickAction('sync')}
                    className="mr-2 px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
                  >
                    同步
                  </button>
                  <button
                    onClick={() => handleQuickAction('export')}
                    className="px-3 py-1 bg-gray-600 text-white rounded text-sm hover:bg-gray-700"
                  >
                    导出
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 加载覆盖层 */}
          {(isLoading || tabsLoading) && (
            <LoadingOverlay
              isVisible={true}
              message={loadingMessage || '正在加载...'}
            />
          )}

          {/* Toast 通知 */}
          {toast && (
            <Toast
              message={toast.message}
              visible={true}
              type={toast.type}
              onClose={handleToastClose}
            />
          )}

          {/* 快捷键提示 */}
          <div className="fixed bottom-4 right-4 text-xs text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 px-2 py-1 rounded shadow">
            按 Ctrl+K 打开快捷操作
          </div>
        </div>
      </ToastProvider>
    </ThemeProvider>
  );
};

export default EnhancedAppIntegrated;
