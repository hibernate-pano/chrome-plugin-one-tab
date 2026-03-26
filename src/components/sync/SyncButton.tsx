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
          style={{ zIndex: 99999 }}
          className={`fixed inset-0 z-[105] flex items-center justify-center p-4 ${modalAnimation}`}
          onClick={closeModals}
        >
          <div className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm" />
          {showUploadModal && (
            <div
              className={`relative w-full max-w-5xl overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <h3 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">上传到云端</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">先看这次会怎么改动云端会话，再决定覆盖还是合并</p>
                </div>

                {isUploadPreviewLoading && (
                  <div className="mb-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    正在计算上传预览...
                  </div>
                )}

                {uploadPreviewError && (
                  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                    {uploadPreviewError}
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div
                    onClick={handleUploadOverwrite}
                    className="cursor-pointer overflow-hidden rounded-[24px] border border-rose-200/70 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-rose-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-rose-600 px-5 py-5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">覆盖模式</h4>
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
                    className="cursor-pointer overflow-hidden rounded-[24px] border border-emerald-200/70 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-emerald-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-emerald-600 px-5 py-5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">合并模式</h4>
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

                <div className="mt-6 text-center">
                  <button
                    onClick={closeModals}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {showDownloadModal && (
            <div
              className={`relative w-full max-w-5xl overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <h3 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">下载到本地</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">先看这次会怎么改动本地会话，再决定覆盖还是合并</p>
                  <p className="mt-2 text-xs font-medium text-sky-600 dark:text-sky-300">
                    当前合并策略：{getSyncStrategyLabel(settings.syncStrategy)}
                  </p>
                </div>

                {isDownloadPreviewLoading && (
                  <div className="mb-4 text-center text-sm text-slate-500 dark:text-slate-400">
                    正在计算下载预览...
                  </div>
                )}

                {downloadPreviewError && (
                  <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                    {downloadPreviewError}
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div
                    onClick={handleDownloadOverwrite}
                    className="cursor-pointer overflow-hidden rounded-[24px] border border-rose-200/70 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-rose-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-rose-600 px-5 py-5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">覆盖模式</h4>
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
                    className="cursor-pointer overflow-hidden rounded-[24px] border border-sky-200/70 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-sky-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-sky-600 px-5 py-5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">合并模式</h4>
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

                <div className="mt-6 text-center">
                  <button
                    onClick={closeModals}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    取消
                  </button>
                </div>
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
