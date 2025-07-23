import React from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { setError } from '@/features/tabs/store/tabGroupsSlice';

interface SyncWarningBannerProps {
  className?: string;
}

/**
 * 同步警告横幅组件
 * 当操作完成但同步失败时显示警告信息
 */
export const SyncWarningBanner: React.FC<SyncWarningBannerProps> = ({ className = '' }) => {
  const dispatch = useAppDispatch();
  const error = useAppSelector(state => state.tabGroups.error);

  // 只显示同步相关的错误
  const isSyncError = error && error.includes('同步失败');

  if (!isSyncError) {
    return null;
  }

  const handleDismiss = () => {
    dispatch(setError(null));
  };

  const handleManualSync = async () => {
    try {
      // 触发手动同步
      const { pullFirstSyncService } = await import('@/services/PullFirstSyncService');
      await pullFirstSyncService.performManualSync();
      
      // 清除错误信息
      dispatch(setError(null));
      
      // 显示成功提示
      console.log('手动同步完成');
    } catch (error) {
      console.error('手动同步失败:', error);
    }
  };

  return (
    <div className={`bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4 ${className}`}>
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <svg 
            className="h-5 w-5 text-yellow-400" 
            viewBox="0 0 20 20" 
            fill="currentColor"
          >
            <path 
              fillRule="evenodd" 
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" 
              clipRule="evenodd" 
            />
          </svg>
        </div>
        
        <div className="ml-3 flex-1">
          <h3 className="text-sm font-medium text-yellow-800">
            同步警告
          </h3>
          <div className="mt-1 text-sm text-yellow-700">
            <p>{error}</p>
          </div>
          
          <div className="mt-3 flex space-x-3">
            <button
              onClick={handleManualSync}
              className="bg-yellow-100 hover:bg-yellow-200 text-yellow-800 text-xs font-medium px-3 py-1.5 rounded-md transition-colors duration-200"
            >
              立即同步
            </button>
            <button
              onClick={handleDismiss}
              className="text-yellow-700 hover:text-yellow-600 text-xs font-medium transition-colors duration-200"
            >
              忽略
            </button>
          </div>
        </div>
        
        <div className="flex-shrink-0 ml-4">
          <button
            onClick={handleDismiss}
            className="inline-flex text-yellow-400 hover:text-yellow-600 transition-colors duration-200"
          >
            <span className="sr-only">关闭</span>
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path 
                fillRule="evenodd" 
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" 
                clipRule="evenodd" 
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default SyncWarningBanner;
