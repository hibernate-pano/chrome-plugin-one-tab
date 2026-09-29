import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { downloadTabGroups } from '@/services/tabGroupSyncService';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { createSimulatedProgress, getSyncStrategyLabel, renderPreviewSummary } from './syncPreviewView';

// 与 syncEngine.SyncOperation 同语义（仅 UI 进度条用），本文件不再 import syncEngine。
type SyncOperation = 'upload' | 'download' | 'none';
import { useToast } from '@/contexts/ToastContext';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';
import { trackProductEvent } from '@/utils/productEvents';
import { storage } from '@/utils/storage';
import {
  buildDownloadPreviewSummary,
  buildUploadPreviewSummary,
  SyncPreviewSummary,
} from '@/utils/syncPreview';
import { logError, logWarn } from '../../utils/log';

interface SyncButtonProps { }

type ModePreviewMap = {
  overwrite: SyncPreviewSummary;
  merge: SyncPreviewSummary;
};

/**
 * 手动同步的四个动作（上传/下载 × 覆盖/合并）的行为描述表。
 *
 * 根因：原来四个 handler 是整段复制粘贴的同一段逻辑，只有 (方向, 模式) 不同。
 * 复制粘贴的直接后果是「改一条漏三条」——四个错误文案、日志前缀、
 * 下发给引擎的参数组合散落在四个函数体里，彼此没有任何约束关系。
 * 收成数据表后，四者的差异被显式摆在一处，一眼可核对。
 */
const SYNC_ACTIONS = {
  'upload.overwrite': {
    command: { overwriteCloud: true, syncSettings: true },
    failureMessage: '上传失败，请重试',
    failureLogLabel: '上传数据到云端失败:',
    // 上传不改动本地会话，成功后无需重载。
    refreshLocal: false,
    // 空本地保护：覆盖上传被跳过时不能当成「上传成功」上报/提示。
    reportSkippedOverwrite: true,
  },
  'upload.merge': {
    command: { overwriteCloud: false, syncSettings: true },
    failureMessage: '上传失败，请重试',
    failureLogLabel: '上传数据到云端失败:',
    refreshLocal: false,
    reportSkippedOverwrite: false,
  },
  'download.overwrite': {
    command: { forceRemote: true, syncSettings: true },
    failureMessage: '下载失败，请重试',
    failureLogLabel: '从云端下载数据失败:',
    // 下载会改写本地会话，必须重载。
    refreshLocal: true,
    reportSkippedOverwrite: false,
  },
  'download.merge': {
    command: { forceRemote: false, syncSettings: false },
    failureMessage: '下载失败，请重试',
    failureLogLabel: '从云端下载数据失败:',
    refreshLocal: true,
    reportSkippedOverwrite: false,
  },
} as const;

type SyncActionKey = keyof typeof SYNC_ACTIONS;

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const dispatch = useAppDispatch();
  const { isAuthenticated } = useAppSelector(state => state.auth);
  const settings = useAppSelector(state => state.settings);
  const [isWorking, setIsWorking] = useState(false);
  const [workingOperation, setWorkingOperation] = useState<SyncOperation>('none');
  const [workingProgress, setWorkingProgress] = useState(0);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [modalAnimation, setModalAnimation] = useState('');
  const [isUploadPreviewLoading, setIsUploadPreviewLoading] = useState(false);
  const [isDownloadPreviewLoading, setIsDownloadPreviewLoading] = useState(false);
  const [uploadPreviewError, setUploadPreviewError] = useState<string | null>(null);
  const [downloadPreviewError, setDownloadPreviewError] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<ModePreviewMap | null>(null);
  const [downloadPreview, setDownloadPreview] = useState<ModePreviewMap | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const uploadTitleId = useId();
  const uploadDescriptionId = useId();
  const downloadTitleId = useId();
  const downloadDescriptionId = useId();
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
      logError('加载上传预览失败:', error);
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
        overwrite: buildDownloadPreviewSummary(localGroups, remoteGroups, 'overwrite'),
        merge: buildDownloadPreviewSummary(localGroups, remoteGroups, 'merge'),
      });
    } catch (error) {
      logError('加载下载预览失败:', error);
      setDownloadPreviewError('暂时无法读取云端会话预览，仍可继续手动下载。');
      setDownloadPreview(null);
    } finally {
      setIsDownloadPreviewLoading(false);
    }
  };

  // 处理上传按钮点击
  const handleUpload = async () => {
    if (!isWorking && isAuthenticated) {
      setModalAnimation('animate-fadeIn');
      setShowUploadModal(true);
      void loadUploadPreview();
    }
  };

  // 处理下载按钮点击
  const handleDownload = async () => {
    if (!isWorking && isAuthenticated) {
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

  // 同步弹窗的键盘与焦点契约。两个面板同时只渲染一个，共用同一个 ref。
  // 不接管的话，Escape 会被 Header 注册的全局 CLEAR_SEARCH 快捷键抢走，
  // 结果是「关不掉弹窗，反而把弹窗背后的搜索框清空」。
  useDialogA11y(panelRef, showUploadModal || showDownloadModal, closeModals);

  // 手动同步的唯一入口：(方向, 模式) 决定下发给引擎的参数、埋点、失败文案。
  // 四个动作的行为差异全部来自 SYNC_ACTIONS 表，不再散落在四个函数体里。
  const runSyncAction = async (actionKey: SyncActionKey) => {
    const spec = SYNC_ACTIONS[actionKey];
    const direction: SyncOperation = actionKey.startsWith('upload') ? 'upload' : 'download';
    const mode = actionKey.endsWith('overwrite') ? 'overwrite' : 'merge';

    if (isWorking || !isAuthenticated) return;

    const refreshLocal = async () => {
      try {
        await dispatch(loadGroups()).unwrap();
      } catch (err) {
        logWarn('同步后刷新本地会话失败:', err);
      }
    };

    // 下载侧的埋点额外带 directRestore（下载按钮走的是菜单，不是直接恢复）。
    const trackingPayload = () =>
      direction === 'download' ? { mode, directRestore: false } : { mode };

    try {
      closeModals();
      void trackProductEvent(
        direction === 'upload' ? 'sync_upload_started' : 'sync_download_started',
        trackingPayload()
      );
      setIsWorking(true);
      setWorkingOperation(direction);
      // 进度条本地模拟：跨消息边界 SW 端的 onProgress 不会回传到 popup，
      // 此处驱动本地进度条 UI；真实结果经 sendSyncCommand 消息回传。
      const progressTimer = createSimulatedProgress(setWorkingProgress);
      const res = await sendSyncCommand(direction, spec.command);
      clearTimeout(progressTimer);
      setWorkingProgress(100);

      if (res.ok) {
        if (spec.refreshLocal) {
          await refreshLocal();
        }

        if (direction === 'upload' && spec.reportSkippedOverwrite) {
          // 空本地保护：本地没有任何活跃组时覆盖上传被跳过（绝不清空云端）。
          // 引擎把这件事如实回传，这里不能再当成「上传成功」上报/提示。
          const payload = res.payload as { skippedOverwrite?: string } | undefined;
          if (payload?.skippedOverwrite === 'no-active-groups') {
            showToast('本地没有活跃会话，覆盖上传已跳过（云端数据保持不变）', 'info');
            return;
          }
        }

        void trackProductEvent(
          direction === 'upload' ? 'sync_upload_completed' : 'sync_download_completed',
          trackingPayload()
        );
      } else {
        const reason = res.error;
        const shown =
          direction === 'download' && reason === 'not_authenticated'
            ? '未登录'
            : (reason || spec.failureMessage);
        showToast(shown, 'error');
      }
    } catch (error) {
      logError(spec.failureLogLabel, error);
      showToast(spec.failureMessage, 'error');
    } finally {
      setIsWorking(false);
      setWorkingOperation('none');
      setWorkingProgress(0);
    }
  };

  if (!isAuthenticated) {
    return null; // 未登录时不显示同步按钮
  }

  return (
    <>
      <div className="sync-button flex items-center gap-2">
        {workingOperation !== 'none' && isWorking && (
          <div className="w-16 bg-gray-200 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full ${workingOperation === 'upload' ? 'bg-green-600' : 'bg-primary-600'}`}
              style={{ width: `${workingProgress}%` }}
            ></div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUpload}
            disabled={isWorking}
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm flat-interaction ${
              isWorking
                ? 'bg-green-100 text-green-600'
                : 'bg-green-100 text-green-600 hover:bg-green-200'
              } transition-colors`}
            title="手动上传本地会话到云端"
          >
            {isWorking && workingOperation === 'upload' ? (
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
            disabled={isWorking}
            className={`flex items-center whitespace-nowrap px-3 py-1.5 rounded-md text-sm flat-interaction ${
              isWorking
                ? 'bg-primary-100 text-primary-600'
                : 'bg-primary-100 text-primary-600 hover:bg-primary-200'
              } transition-colors`}
            title="手动从云端下载会话到本地"
          >
            {isWorking && workingOperation === 'download' ? (
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
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={uploadTitleId}
              aria-describedby={uploadDescriptionId}
              tabIndex={-1}
              className={`relative w-full max-w-5xl overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur focus:outline-none dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <h3 id={uploadTitleId} className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">上传到云端</h3>
                  <p id={uploadDescriptionId} className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">先看这次会怎么改动云端会话，再决定覆盖还是合并</p>
                </div>

                {/* 预览是异步算出来的：不播报的话读屏用户按了按钮后毫无反馈。
                    容器常驻、只换里面的文案，读屏才会播报这处内容变化。 */}
                <div
                  role="status"
                  aria-live="polite"
                  className={`text-center text-sm ${isUploadPreviewLoading || uploadPreviewError ? 'mb-4' : ''}`}
                >
                  {isUploadPreviewLoading && (
                    <span className="text-slate-500 dark:text-slate-400">正在计算上传预览...</span>
                  )}
                  {uploadPreviewError && (
                    <span className="block rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      {uploadPreviewError}
                    </span>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void runSyncAction('upload.overwrite')}
                    className="w-full cursor-pointer overflow-hidden rounded-[24px] border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 dark:border-rose-500/20 dark:bg-slate-900/80"
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
                  </button>

                  <button
                    type="button"
                    onClick={() => void runSyncAction('upload.merge')}
                    className="w-full cursor-pointer overflow-hidden rounded-[24px] border border-emerald-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-emerald-500/20 dark:bg-slate-900/80"
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
                  </button>
                </div>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={closeModals}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {showDownloadModal && (
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={downloadTitleId}
              aria-describedby={downloadDescriptionId}
              tabIndex={-1}
              className={`relative w-full max-w-5xl overflow-hidden rounded-[28px] border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur focus:outline-none dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <h3 id={downloadTitleId} className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">下载到本地</h3>
                  <p id={downloadDescriptionId} className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">先看这次会怎么改动本地会话，再决定覆盖还是合并</p>
                  <p className="mt-2 text-xs font-medium text-sky-600 dark:text-sky-300">
                    当前合并策略：{getSyncStrategyLabel(settings.syncStrategy)}
                  </p>
                </div>

                <div
                  role="status"
                  aria-live="polite"
                  className={`text-center text-sm ${isDownloadPreviewLoading || downloadPreviewError ? 'mb-4' : ''}`}
                >
                  {isDownloadPreviewLoading && (
                    <span className="text-slate-500 dark:text-slate-400">正在计算下载预览...</span>
                  )}
                  {downloadPreviewError && (
                    <span className="block rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      {downloadPreviewError}
                    </span>
                  )}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void runSyncAction('download.overwrite')}
                    className="w-full cursor-pointer overflow-hidden rounded-[24px] border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 dark:border-rose-500/20 dark:bg-slate-900/80"
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
                  </button>

                  <button
                    type="button"
                    onClick={() => void runSyncAction('download.merge')}
                    className="w-full cursor-pointer overflow-hidden rounded-[24px] border border-sky-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:border-sky-500/20 dark:bg-slate-900/80"
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
                  </button>
                </div>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={closeModals}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
