import React, { useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';
import { useToast } from '@/contexts/ToastContext';

interface SyncButtonProps { }

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const { syncStatus, syncProgress, syncOperation } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [modalAnimation, setModalAnimation] = useState('');
  const { showToast } = useToast();

  // 处理上传按钮点击
  const handleUpload = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      // 直接显示选择对话框，不再检查云端是否有数据
      setModalAnimation('animate-fadeIn');
      setShowUploadModal(true);
    }
  };

  // 处理下载按钮点击
  const handleDownload = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 检查本地是否有数据
        const hasLocalData = await syncService.hasLocalData();

        if (!hasLocalData) {
          // 本地没有数据，直接下载（相当于覆盖模式）
          console.log('本地没有数据，直接下载...');
          await syncService.downloadAndRefresh(true); // overwriteLocal=true
        } else {
          // 本地有数据，显示选择对话框
          setModalAnimation('animate-fadeIn');
          setShowDownloadModal(true);
        }
      } catch (error) {
        console.error('检查本地数据状态失败:', error);
        // 出错时显示选择对话框，以确保用户可以选择
        setModalAnimation('animate-fadeIn');
        setShowDownloadModal(true);
      }
    }
  };

  // 关闭模态框
  const closeModals = () => {
    setModalAnimation('animate-fadeOut');
    setTimeout(() => {
      setShowUploadModal(false);
      setShowDownloadModal(false);
      setModalAnimation('');
    }, 200);
  };

  // 处理上传确认 - 覆盖模式
  const handleUploadOverwrite = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 先关闭模态框，然后开始上传
        closeModals();
        console.log('开始上传本地数据到云端（覆盖模式）...');
        const result = await syncService.uploadToCloud(false, true); // background=false, overwriteCloud=true
        console.log('上传完成（覆盖模式）');

        // 根据结果显示提示
        if (result.success) {
          showToast('数据上传成功', 'success');
        } else {
          showToast(result.error || '上传失败，请重试', 'error');
        }
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        // 显示错误提示
        showToast('上传失败，请重试', 'error');
      }
    }
  };

  // 处理上传确认 - 合并模式
  const handleUploadMerge = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 先关闭模态框，然后开始上传
        closeModals();
        console.log('开始上传本地数据到云端（合并模式）...');
        const result = await syncService.uploadToCloud(false, false); // background=false, overwriteCloud=false
        console.log('上传完成（合并模式）');

        // 根据结果显示提示
        if (result.success) {
          showToast('数据上传成功', 'success');
        } else {
          showToast(result.error || '上传失败，请重试', 'error');
        }
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        // 显示错误提示
        showToast('上传失败，请重试', 'error');
      }
    }
  };

  // 处理下载确认 - 覆盖模式
  const handleDownloadOverwrite = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 先关闭模态框，然后开始下载
        closeModals();
        console.log('开始下载数据（覆盖模式）...');
        // 使用下载并刷新方法，显示进度条，下载完成后延迟刷新页面
        const result = await syncService.downloadAndRefresh(true); // overwriteLocal=true

        if (result.success) {
          // 显示成功提示
          showToast('数据下载成功', 'success');
          // 执行刷新回调，延迟刷新页面，给提示显示的时间
          if (result.refreshCallback) {
            result.refreshCallback();
          }
        } else {
          // 显示错误提示
          showToast(result.error || '下载失败，请重试', 'error');
        }
      } catch (error) {
        console.error('从云端下载数据失败:', error);
        // 显示错误提示
        showToast('下载失败，请重试', 'error');
      }
    }
  };

  // 处理下载确认 - 合并模式
  const handleDownloadMerge = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        // 先关闭模态框，然后开始下载
        closeModals();
        console.log('开始下载数据（合并模式）...');
        // 使用下载并刷新方法，显示进度条，下载完成后延迟刷新页面
        const result = await syncService.downloadAndRefresh(false); // overwriteLocal=false

        if (result.success) {
          // 显示成功提示
          showToast('数据下载成功', 'success');
          // 执行刷新回调，延迟刷新页面，给提示显示的时间
          if (result.refreshCallback) {
            result.refreshCallback();
          }
        } else {
          // 显示错误提示
          showToast(result.error || '下载失败，请重试', 'error');
        }
      } catch (error) {
        console.error('从云端下载数据失败:', error);
        // 显示错误提示
        showToast('下载失败，请重试', 'error');
      }
    }
  };

  if (!isAuthenticated) {
    return null; // 未登录时不显示同步按钮
  }

  return (
    <>
      <div className="flex flex-col items-center space-y-2">
        {/* 进度条 */}
        {syncOperation !== 'none' && syncStatus === 'syncing' && (
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-2">
            <div
              className={`h-2.5 rounded-full ${syncOperation === 'upload' ? 'bg-green-600' : 'bg-blue-600'}`}
              style={{ width: `${syncProgress}%` }}
            ></div>
          </div>
        )}

        <div className="flex items-center space-x-2 w-full">
          <button
            onClick={handleUpload}
            disabled={syncStatus === 'syncing'}
            className={`flex items-center px-3 py-1 rounded-md text-sm ${
              // 上传按钮始终保持绿色，只是在同步中禁用悬停效果
              syncStatus === 'syncing'
                ? 'bg-green-100 text-green-600'
                : 'bg-green-100 text-green-600 hover:bg-green-200'
              } transition-colors`}
            title="上传本地数据到云端"
          >
            {syncStatus === 'syncing' && syncOperation === 'upload' ? (
              <>
                <svg className="animate-spin h-4 w-4 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                上传中...
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
            className={`flex items-center px-3 py-1 rounded-md text-sm ${
              // 下载按钮始终保持蓝色，只是在同步中禁用悬停效果
              syncStatus === 'syncing'
                ? 'bg-blue-100 text-blue-600'
                : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
              } transition-colors`}
            title="从云端下载数据并与本地合并"
          >
            {syncStatus === 'syncing' && syncOperation === 'download' ? (
              <>
                <svg className="animate-spin h-4 w-4 mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                下载中...
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
      </div>

      {/* 模态框背景遮罩 */}
      {(showUploadModal || showDownloadModal) && (
        <div
          className={`fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 ${modalAnimation}`}
          onClick={closeModals}
        >
          {/* 上传模态框 */}
          {showUploadModal && (
            <div
              className={`relative max-w-md w-full mx-auto ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center mb-4">
                <h3 className="text-xl font-bold text-white">选择上传模式</h3>
                <p className="text-gray-300">请选择如何处理云端数据</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 覆盖模式卡片 */}
                <div
                  onClick={handleUploadOverwrite}
                  className="bg-white rounded-xl overflow-hidden shadow-lg transform transition-all hover:scale-105 cursor-pointer"
                >
                  <div className="bg-red-600 p-4 flex justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <div className="p-4">
                    <h4 className="text-lg font-semibold text-gray-800 mb-2">覆盖模式</h4>
                    <p className="text-gray-600 text-sm mb-4">将使用本地数据完全替换云端数据，云端现有数据将被删除</p>
                  </div>
                </div>

                {/* 合并模式卡片 */}
                <div
                  onClick={handleUploadMerge}
                  className="bg-white rounded-xl overflow-hidden shadow-lg transform transition-all hover:scale-105 cursor-pointer"
                >
                  <div className="bg-green-600 p-4 flex justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div className="p-4">
                    <h4 className="text-lg font-semibold text-gray-800 mb-2">合并模式</h4>
                    <p className="text-gray-600 text-sm mb-4">将本地数据与云端数据智能合并，保留两者的状态</p>
                  </div>
                </div>
              </div>

              <div className="text-center mt-4">
                <button
                  onClick={closeModals}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 transition-colors inline-flex items-center"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 下载模态框 */}
          {showDownloadModal && (
            <div
              className={`relative max-w-md w-full mx-auto ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center mb-4">
                <h3 className="text-xl font-bold text-white">选择下载模式</h3>
                <p className="text-gray-300">请选择如何处理本地数据</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 覆盖模式卡片 */}
                <div
                  onClick={handleDownloadOverwrite}
                  className="bg-white rounded-xl overflow-hidden shadow-lg transform transition-all hover:scale-105 cursor-pointer"
                >
                  <div className="bg-red-600 p-4 flex justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <div className="p-4">
                    <h4 className="text-lg font-semibold text-gray-800 mb-2">覆盖模式</h4>
                    <p className="text-gray-600 text-sm mb-4">将使用云端数据完全替换本地数据，本地状态将被覆盖</p>
                  </div>
                </div>

                {/* 合并模式卡片 */}
                <div
                  onClick={handleDownloadMerge}
                  className="bg-white rounded-xl overflow-hidden shadow-lg transform transition-all hover:scale-105 cursor-pointer"
                >
                  <div className="bg-blue-600 p-4 flex justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div className="p-4">
                    <h4 className="text-lg font-semibold text-gray-800 mb-2">合并模式</h4>
                    <p className="text-gray-600 text-sm mb-4">将云端数据与本地数据智能合并，保留两者的状态</p>
                  </div>
                </div>
              </div>

              <div className="text-center mt-4">
                <button
                  onClick={closeModals}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 transition-colors inline-flex items-center"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default SyncButton;
