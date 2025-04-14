import React, { useState, useEffect } from 'react';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';

interface SyncButtonProps { }

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const { syncStatus, lastSyncTime } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const [lastSyncTimeText, setLastSyncTimeText] = useState<string>('');
  const [showUploadModal, setShowUploadModal] = useState(false);

  // 更新上次同步时间的显示文本
  useEffect(() => {
    if (lastSyncTime) {
      try {
        // 简化时间显示，不使用 date-fns
        const date = new Date(lastSyncTime);
        const timeText = date.toLocaleString();
        setLastSyncTimeText(timeText);
      } catch (error) {
        console.error('格式化同步时间失败:', error);
        setLastSyncTimeText('');
      }
    } else {
      setLastSyncTimeText('从未同步');
    }
  }, [lastSyncTime]);

  // 处理上传按钮点击
  const handleUpload = () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      setShowUploadModal(true);
    }
  };

  // 处理下载按钮点击
  const handleDownload = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        console.log('开始从云端下载数据并与本地合并...');
        await syncService.downloadFromCloud(false);
        console.log('下载并合并完成');
      } catch (error) {
        console.error('从云端下载数据失败:', error);
      }
    }
  };

  // 处理上传确认 - 覆盖模式
  const handleUploadOverwrite = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        console.log('开始上传本地数据到云端（覆盖模式）...');
        await syncService.uploadToCloud(false, true); // background=false, overwriteCloud=true
        console.log('上传完成（覆盖模式）');
        setShowUploadModal(false);
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        setShowUploadModal(false);
      }
    }
  };

  // 处理上传确认 - 合并模式
  const handleUploadMerge = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        console.log('开始上传本地数据到云端（合并模式）...');
        await syncService.uploadToCloud(false, false); // background=false, overwriteCloud=false
        console.log('上传完成（合并模式）');
        setShowUploadModal(false);
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        setShowUploadModal(false);
      }
    }
  };

  if (!isAuthenticated) {
    return null; // 未登录时不显示同步按钮
  }

  return (
    <>
      <div className="flex items-center space-x-2">
        {lastSyncTimeText && (
          <span className="text-xs text-gray-500 mr-2">
            上次同步: {lastSyncTimeText}
          </span>
        )}
        <button
          onClick={handleUpload}
          disabled={syncStatus === 'syncing'}
          className={`flex items-center px-3 py-1 rounded-md text-sm ${syncStatus === 'syncing'
            ? 'bg-blue-100 text-blue-600'
            : 'bg-green-100 text-green-600 hover:bg-green-200'
            } transition-colors`}
          title="上传本地数据到云端"
        >
          {syncStatus === 'syncing' ? (
            <>
              <svg className="animate-spin h-4 w-4 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              处理中...
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              上传
            </>
          )}
        </button>

        <button
          onClick={handleDownload}
          disabled={syncStatus === 'syncing'}
          className={`flex items-center px-3 py-1 rounded-md text-sm ${syncStatus === 'syncing'
            ? 'bg-blue-100 text-blue-600'
            : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
            } transition-colors`}
          title="从云端下载数据并与本地合并"
        >
          {syncStatus === 'syncing' ? (
            <>
              <svg className="animate-spin h-4 w-4 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              处理中...
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              下载
            </>
          )}
        </button>
      </div>

      {/* 上传确认模态框 */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium text-gray-900 mb-4">选择上传模式</h3>
            <p className="text-gray-600 mb-6">请选择如何处理云端数据：</p>

            <div className="flex flex-col space-y-3">
              <button
                onClick={handleUploadOverwrite}
                className="w-full px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
              >
                覆盖云端数据
                <span className="block text-xs mt-1 text-red-200">将使用本地数据完全替换云端数据</span>
              </button>

              <button
                onClick={handleUploadMerge}
                className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
              >
                合并到云端数据
                <span className="block text-xs mt-1 text-green-200">将本地数据与云端数据智能合并</span>
              </button>

              <button
                onClick={() => setShowUploadModal(false)}
                className="w-full px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SyncButton;
