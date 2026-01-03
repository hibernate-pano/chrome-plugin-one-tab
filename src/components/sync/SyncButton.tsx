import React, { useState } from 'react';
import { createPortal } from 'react-dom';
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
        // 上传完成

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
        const result = await syncService.uploadToCloud(false, false); // background=false, overwriteCloud=false

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
        // 使用下载方法，显示进度条
        const result = await syncService.downloadAndRefresh(true); // overwriteLocal=true

        if (result.success) {
          // 显示成功提示
          showToast('数据下载成功', 'success');
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
        // 使用下载方法，显示进度条
        const result = await syncService.downloadAndRefresh(false); // overwriteLocal=false

        if (result.success) {
          // 显示成功提示
          showToast('数据下载成功', 'success');
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
      <div className="flex items-center gap-2">
        {/* 进度条 - 同步时显示在按钮旁边 */}
        {syncOperation !== 'none' && syncStatus === 'syncing' && (
          <div className="w-16 bg-gray-200 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full ${syncOperation === 'upload' ? 'bg-green-600' : 'bg-blue-600'}`}
              style={{ width: `${syncProgress}%` }}
            ></div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={handleUpload}
            disabled={syncStatus === 'syncing'}
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm ${
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
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm ${
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

      {/* 模态框 - 使用 Portal 渲染到 body，避免主题样式影响 */}
      {(showUploadModal || showDownloadModal) && createPortal(
        <div
          className={modalAnimation}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
            margin: 0,
            padding: 0
          }}
          onClick={closeModals}
        >
          {/* 上传模态框 */}
          {showUploadModal && (
            <div
              className={modalAnimation}
              style={{
                maxWidth: '28rem',
                width: '90%',
                backgroundColor: 'transparent'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#ffffff', margin: 0 }}>选择上传模式</h3>
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>请选择如何处理云端数据</p>
              </div>

              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                {/* 覆盖模式卡片 */}
                <div
                  onClick={handleUploadOverwrite}
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                    cursor: 'pointer',
                    transition: 'transform 0.2s',
                    width: '200px',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <div style={{ backgroundColor: '#dc2626', padding: '16px', display: 'flex', justifyContent: 'center' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '48px', width: '48px' }} fill="none" viewBox="0 0 24 24" stroke="#ffffff">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <div style={{ padding: '12px' }}>
                    <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#1f2937', marginBottom: '6px', margin: '0 0 6px 0' }}>覆盖模式</h4>
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>将使用本地数据完全替换云端数据，云端现有数据将被删除</p>
                  </div>
                </div>

                {/* 合并模式卡片 */}
                <div
                  onClick={handleUploadMerge}
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                    cursor: 'pointer',
                    transition: 'transform 0.2s',
                    width: '200px',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <div style={{ backgroundColor: '#16a34a', padding: '16px', display: 'flex', justifyContent: 'center' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '48px', width: '48px' }} fill="none" viewBox="0 0 24 24" stroke="#ffffff">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div style={{ padding: '12px' }}>
                    <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#1f2937', marginBottom: '6px', margin: '0 0 6px 0' }}>合并模式</h4>
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>将本地数据与云端数据智能合并，保留两者的状态</p>
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'center', marginTop: '16px' }}>
                <button
                  onClick={closeModals}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#ffffff',
                    color: '#1f2937',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: '0.875rem',
                    fontWeight: '500'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f3f4f6'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ffffff'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '16px', width: '16px', marginRight: '4px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              className={modalAnimation}
              style={{
                maxWidth: '28rem',
                width: '90%',
                backgroundColor: 'transparent'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#ffffff', margin: 0 }}>选择下载模式</h3>
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>请选择如何处理本地数据</p>
              </div>

              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
                {/* 覆盖模式卡片 */}
                <div
                  onClick={handleDownloadOverwrite}
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                    cursor: 'pointer',
                    transition: 'transform 0.2s',
                    width: '200px',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <div style={{ backgroundColor: '#dc2626', padding: '16px', display: 'flex', justifyContent: 'center' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '48px', width: '48px' }} fill="none" viewBox="0 0 24 24" stroke="#ffffff">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </div>
                  <div style={{ padding: '12px' }}>
                    <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#1f2937', marginBottom: '6px', margin: '0 0 6px 0' }}>覆盖模式</h4>
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>将使用云端数据完全替换本地数据，本地状态将被覆盖</p>
                  </div>
                </div>

                {/* 合并模式卡片 */}
                <div
                  onClick={handleDownloadMerge}
                  style={{
                    backgroundColor: '#ffffff',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',
                    cursor: 'pointer',
                    transition: 'transform 0.2s',
                    width: '200px',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <div style={{ backgroundColor: '#2563eb', padding: '16px', display: 'flex', justifyContent: 'center' }}>
                    <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '48px', width: '48px' }} fill="none" viewBox="0 0 24 24" stroke="#ffffff">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </div>
                  <div style={{ padding: '12px' }}>
                    <h4 style={{ fontSize: '1rem', fontWeight: '600', color: '#1f2937', marginBottom: '6px', margin: '0 0 6px 0' }}>合并模式</h4>
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>将云端数据与本地数据智能合并，保留两者的状态</p>
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'center', marginTop: '16px' }}>
                <button
                  onClick={closeModals}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#ffffff',
                    color: '#1f2937',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: '0.875rem',
                    fontWeight: '500'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f3f4f6'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ffffff'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" style={{ height: '16px', width: '16px', marginRight: '4px' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  取消
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
};

export default SyncButton;
