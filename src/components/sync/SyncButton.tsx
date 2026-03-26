import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';
import { downloadTabGroups } from '@/services/tabGroupSyncService';
import { useToast } from '@/contexts/ToastContext';
import { trackProductEvent } from '@/utils/productEvents';
import { storage } from '@/utils/storage';
import {
  buildDownloadPreviewSummary,
  buildUploadPreviewSummary,
  SyncPreviewSummary,
} from '@/utils/syncPreview';

interface SyncButtonProps { }

type ModePreviewMap = {
  overwrite: SyncPreviewSummary;
  merge: SyncPreviewSummary;
};

const getSyncStrategyLabel = (strategy: string) => {
  switch (strategy) {
    case 'local':
      return '本地优先';
    case 'remote':
      return '云端优先';
    case 'ask':
      return '检测冲突后询问';
    case 'newest':
    default:
      return '较新版本优先';
  }
};

const renderPreviewNames = (label: string, names: string[], color: string) => {
  if (names.length === 0) {
    return null;
  }

  return (
    <div style={{ fontSize: '0.72rem', color, lineHeight: '1.5', marginTop: '6px' }}>
      {label}：{names.join('、')}
    </div>
  );
};

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const { syncStatus, syncProgress, syncOperation } = useAppSelector(state => state.tabs);
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const settings = useAppSelector(state => state.settings);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [modalAnimation, setModalAnimation] = useState('');
  const [isUploadPreviewLoading, setIsUploadPreviewLoading] = useState(false);
  const [isDownloadPreviewLoading, setIsDownloadPreviewLoading] = useState(false);
  const [uploadPreviewError, setUploadPreviewError] = useState<string | null>(null);
  const [downloadPreviewError, setDownloadPreviewError] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<ModePreviewMap | null>(null);
  const [downloadPreview, setDownloadPreview] = useState<ModePreviewMap | null>(null);
  const { showToast } = useToast();

  const loadUploadPreview = async () => {
    setIsUploadPreviewLoading(true);
    setUploadPreviewError(null);

    try {
      const [localGroups, remoteGroups] = await Promise.all([
        storage.getGroups(),
        downloadTabGroups(),
      ]);

      setUploadPreview({
        overwrite: buildUploadPreviewSummary(localGroups, remoteGroups, 'overwrite'),
        merge: buildUploadPreviewSummary(localGroups, remoteGroups, 'merge'),
      });
    } catch (error) {
      console.error('加载上传预览失败:', error);
      setUploadPreviewError('暂时无法读取云端会话预览，仍可继续手动上传。');
      setUploadPreview(null);
    } finally {
      setIsUploadPreviewLoading(false);
    }
  };

  const loadDownloadPreview = async () => {
    setIsDownloadPreviewLoading(true);
    setDownloadPreviewError(null);

    try {
      const [localGroups, remoteGroups] = await Promise.all([
        storage.getGroups(),
        downloadTabGroups(),
      ]);

      setDownloadPreview({
        overwrite: buildDownloadPreviewSummary(localGroups, remoteGroups, 'overwrite', settings.syncStrategy),
        merge: buildDownloadPreviewSummary(localGroups, remoteGroups, 'merge', settings.syncStrategy),
      });
    } catch (error) {
      console.error('加载下载预览失败:', error);
      setDownloadPreviewError('暂时无法读取云端会话预览，仍可继续手动下载。');
      setDownloadPreview(null);
    } finally {
      setIsDownloadPreviewLoading(false);
    }
  };

  // 处理上传按钮点击
  const handleUpload = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      setModalAnimation('animate-fadeIn');
      setShowUploadModal(true);
      void loadUploadPreview();
    }
  };

  // 处理下载按钮点击
  const handleDownload = async () => {
    if (syncStatus !== 'syncing' && isAuthenticated) {
      setModalAnimation('animate-fadeIn');
      setShowDownloadModal(true);
      void loadDownloadPreview();
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

  const renderPreviewSummary = (
    summary: SyncPreviewSummary | null,
    targetLabel: '云端' | '本地',
    modeDescription: string,
    colorPalette: {
      added: string;
      updated: string;
      deleted: string;
      muted: string;
    }
  ) => {
    if (!summary) {
      return (
        <div style={{ fontSize: '0.78rem', color: colorPalette.muted, lineHeight: '1.5', marginTop: '10px' }}>
          暂无预览数据
        </div>
      );
    }

    return (
      <div style={{ marginTop: '10px' }}>
        <div style={{ fontSize: '0.78rem', color: '#374151', lineHeight: '1.5' }}>
          {modeDescription}
        </div>
        <div
          style={{
            marginTop: '10px',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '8px',
          }}
        >
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.added }}>新增</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.additions}</div>
          </div>
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.updated }}>覆盖</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.updates}</div>
          </div>
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.deleted }}>删除</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.deletions}</div>
          </div>
        </div>
        <div style={{ fontSize: '0.72rem', color: '#6b7280', lineHeight: '1.5', marginTop: '8px' }}>
          操作前 {targetLabel} {summary.beforeCount} 个会话，操作后预计 {summary.afterCount} 个会话。
          {summary.unchanged > 0 ? ` 另有 ${summary.unchanged} 个会话保持不变。` : ''}
        </div>
        {renderPreviewNames('新增示例', summary.addedNames, colorPalette.added)}
        {renderPreviewNames('覆盖示例', summary.updatedNames, colorPalette.updated)}
        {renderPreviewNames('删除示例', summary.deletedNames, colorPalette.deleted)}
      </div>
    );
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
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>先看这次会怎么改动云端会话，再决定覆盖还是合并</p>
              </div>

              {isUploadPreviewLoading && (
                <div style={{ textAlign: 'center', color: '#d1d5db', marginBottom: '16px', fontSize: '0.875rem' }}>
                  正在计算上传预览...
                </div>
              )}

              {uploadPreviewError && (
                <div style={{ textAlign: 'center', color: '#fef3c7', marginBottom: '16px', fontSize: '0.8rem' }}>
                  {uploadPreviewError}
                </div>
              )}

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
                    {renderPreviewSummary(
                      uploadPreview?.overwrite ?? null,
                      '云端',
                      '用当前本地会话直接替换云端现状。',
                      {
                        added: '#16a34a',
                        updated: '#dc2626',
                        deleted: '#b91c1c',
                        muted: '#6b7280',
                      }
                    )}
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
                    {renderPreviewSummary(
                      uploadPreview?.merge ?? null,
                      '云端',
                      '把本地会话按 ID 合并进云端，未命中的云端会话会保留。',
                      {
                        added: '#16a34a',
                        updated: '#2563eb',
                        deleted: '#b91c1c',
                        muted: '#6b7280',
                      }
                    )}
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
                <p style={{ color: '#d1d5db', margin: '8px 0 0 0' }}>先看这次会怎么改动本地会话，再决定覆盖还是合并</p>
                <p style={{ color: '#93c5fd', margin: '6px 0 0 0', fontSize: '0.78rem' }}>
                  当前合并策略：{getSyncStrategyLabel(settings.syncStrategy)}
                </p>
              </div>

              {isDownloadPreviewLoading && (
                <div style={{ textAlign: 'center', color: '#d1d5db', marginBottom: '16px', fontSize: '0.875rem' }}>
                  正在计算下载预览...
                </div>
              )}

              {downloadPreviewError && (
                <div style={{ textAlign: 'center', color: '#fef3c7', marginBottom: '16px', fontSize: '0.8rem' }}>
                  {downloadPreviewError}
                </div>
              )}

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
                    {renderPreviewSummary(
                      downloadPreview?.overwrite ?? null,
                      '本地',
                      '用云端会话直接替换本地现状。',
                      {
                        added: '#16a34a',
                        updated: '#dc2626',
                        deleted: '#b91c1c',
                        muted: '#6b7280',
                      }
                    )}
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
                    {renderPreviewSummary(
                      downloadPreview?.merge ?? null,
                      '本地',
                      '按当前同步策略把云端会话合并进本地。',
                      {
                        added: '#16a34a',
                        updated: '#2563eb',
                        deleted: '#b91c1c',
                        muted: '#6b7280',
                      }
                    )}
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
