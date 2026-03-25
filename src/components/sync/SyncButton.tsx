import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';

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
        const hasLocalData = await syncService.hasLocalData();

        if (!hasLocalData) {
          void trackProductEvent('sync_download_started', {
            mode: 'overwrite',
            directRestore: true,
          });
          const result = await syncService.downloadAndRefresh(true);
          if (result.success) {
            showToast('本地没有会话，已直接从云端恢复', 'success');
            void trackProductEvent('sync_download_completed', {
              mode: 'overwrite',
              directRestore: true,
            });
          } else {
            showToast(result.error || '下载失败，请重试', 'error');
          }
        } else {
          setModalAnimation('animate-fadeIn');
          setShowDownloadModal(true);
        }
      } catch (error) {
        console.error('检查本地数据状态失败:', error);
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
        closeModals();
        void trackProductEvent('sync_upload_started', {
          mode: 'overwrite',
        });
        const result = await syncService.uploadToCloud(false, true);

        if (result.success) {
          showToast('已用本地会话覆盖云端数据', 'success');
          void trackProductEvent('sync_upload_completed', {
            mode: 'overwrite',
          });
        } else {
          showToast(result.error || '上传失败，请重试', 'error');
        }
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        showToast('上传失败，请重试', 'error');
      }
    }
  };

  // 处理上传确认 - 合并模式
  const handleUploadMerge = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        closeModals();
        void trackProductEvent('sync_upload_started', {
          mode: 'merge',
        });
        const result = await syncService.uploadToCloud(false, false);

        if (result.success) {
          showToast('已把本地会话合并上传到云端', 'success');
          void trackProductEvent('sync_upload_completed', {
            mode: 'merge',
          });
        } else {
          showToast(result.error || '上传失败，请重试', 'error');
        }
      } catch (error) {
        console.error('上传数据到云端失败:', error);
        showToast('上传失败，请重试', 'error');
      }
    }
  };

  // 处理下载确认 - 覆盖模式
  const handleDownloadOverwrite = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        closeModals();
        void trackProductEvent('sync_download_started', {
          mode: 'overwrite',
          directRestore: false,
        });
        const result = await syncService.downloadAndRefresh(true);

        if (result.success) {
          showToast('已用云端数据覆盖本地会话', 'success');
          void trackProductEvent('sync_download_completed', {
            mode: 'overwrite',
            directRestore: false,
          });
        } else {
          showToast(result.error || '下载失败，请重试', 'error');
        }
      } catch (error) {
        console.error('从云端下载数据失败:', error);
        showToast('下载失败，请重试', 'error');
      }
    }
  };

  // 处理下载确认 - 合并模式
  const handleDownloadMerge = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      try {
        closeModals();
        void trackProductEvent('sync_download_started', {
          mode: 'merge',
          directRestore: false,
        });
        const result = await syncService.downloadAndRefresh(false);

        if (result.success) {
          showToast('已把云端数据合并到本地会话', 'success');
          void trackProductEvent('sync_download_completed', {
            mode: 'merge',
            directRestore: false,
          });
        } else {
          showToast(result.error || '下载失败，请重试', 'error');
        }
      } catch (error) {
        console.error('从云端下载数据失败:', error);
        showToast('下载失败，请重试', 'error');
      }
    }
  };

  if (!isAuthenticated) {
    return null; // 未登录时不显示同步按钮
  }

  return (
    <>
      <div className="sync-button flex items-center gap-2">
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
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm flat-interaction ${
              syncStatus === 'syncing'
                ? 'bg-green-100 text-green-600'
                : 'bg-green-100 text-green-600 hover:bg-green-200'
              } transition-colors`}
            title="手动上传本地会话到云端"
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
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm flat-interaction ${
              syncStatus === 'syncing'
                ? 'bg-blue-100 text-blue-600'
                : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
              } transition-colors`}
            title="手动从云端下载会话到本地"
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
                <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#ffffff', margin: 0 }}>上传到云端</h3>
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>选择这次上传是覆盖云端，还是与云端现有数据合并</p>
              </div>

              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
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
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>用当前本地会话完全替换云端数据，适合把这台设备作为最新来源</p>
                  </div>
                </div>

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
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>把本地新增内容合并到云端，尽量保留两边已有的会话状态</p>
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
                <h3 style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#ffffff', margin: 0 }}>下载到本地</h3>
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>选择这次下载是覆盖本地，还是与本地现有数据合并</p>
              </div>

              <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
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
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>用云端数据完全替换本地会话，适合在新设备上直接接着工作</p>
                  </div>
                </div>

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
                    <p style={{ color: '#4b5563', fontSize: '0.8rem', margin: 0, lineHeight: '1.4' }}>把云端数据合并进本地，尽量保留当前设备已有的会话和设置</p>
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
