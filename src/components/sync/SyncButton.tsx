import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { downloadTabGroups } from '@/services/tabGroupSyncService';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { createSimulatedProgress, decideOverwriteClick, getSyncStrategyLabel, isOverwriteGateOpen, renderPreviewSummary, syncModeOf } from './syncPreviewView';

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
  // P1-6：覆盖模式的两段式确认。armed 只表示「用户看到了风险文案并又点了一次」，
  // 只有 armed === 当前 actionKey 时下一次点击才真下发；任何其他点击/关窗都会清空。
  const [armedOverwrite, setArmedOverwrite] = useState<SyncActionKey | null>(null);
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
      setUploadPreviewError('暂时无法读取云端会话预览：合并模式仍可使用，覆盖模式需预览就绪后才会解锁。');
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
      setDownloadPreviewError('暂时无法读取云端会话预览：合并模式仍可使用，覆盖模式需预览就绪后才会解锁。');
      setDownloadPreview(null);
    } finally {
      setIsDownloadPreviewLoading(false);
    }
  };

  // 处理上传按钮点击
  const handleUpload = async () => {
    if (!isWorking && isAuthenticated) {
      setModalAnimation('animate-fadeIn');
      setArmedOverwrite(null);
      setShowUploadModal(true);
      void loadUploadPreview();
    }
  };

  // 处理下载按钮点击
  const handleDownload = async () => {
    if (!isWorking && isAuthenticated) {
      setModalAnimation('animate-fadeIn');
      setArmedOverwrite(null);
      setShowDownloadModal(true);
      void loadDownloadPreview();
    }
  };

  // 关闭模态框
  const closeModals = () => {
    setModalAnimation('animate-fadeOut');
    setArmedOverwrite(null);
    setTimeout(() => {
      setShowUploadModal(false);
      setShowDownloadModal(false);
      setModalAnimation('');
    }, 200);
  };

  /**
   * 覆盖按钮的当前状态（预览未就绪 → blocked/disabled；否则 armed/run 两段式）。
   * 两个方向各算一份，参数只差 preview 数据与目标侧标签。
   */
  const uploadOverwriteState = decideOverwriteClick({
    summary: uploadPreview?.overwrite ?? null,
    isPreviewLoading: isUploadPreviewLoading,
    hasPreviewError: !!uploadPreviewError,
    isArmed: armedOverwrite === 'upload.overwrite',
    isBusy: isWorking,
    targetLabel: '云端',
  });
  const downloadOverwriteState = decideOverwriteClick({
    summary: downloadPreview?.overwrite ?? null,
    isPreviewLoading: isDownloadPreviewLoading,
    hasPreviewError: !!downloadPreviewError,
    isArmed: armedOverwrite === 'download.overwrite',
    isBusy: isWorking,
    targetLabel: '本地',
  });

  /**
   * 两个模式卡片的统一点击出口。覆盖模式在这里被拆成两下：
   * blocked → 告知原因不执行；armed → 写入风险文案、不下发；run → 真下发。
   * 合并模式无破坏性，直接执行（但同样会清掉 armed 状态，避免跨模式误触发）。
   */
  const handleSyncActionClick = async (actionKey: SyncActionKey) => {
    if (syncModeOf(actionKey) !== 'overwrite') {
      setArmedOverwrite(null);
      await runSyncAction(actionKey, false);
      return;
    }
    const state = actionKey === 'upload.overwrite' ? uploadOverwriteState : downloadOverwriteState;
    if (state.type === 'blocked') {
      showToast(state.reason, 'info');
      return;
    }
    if (state.type === 'armed') {
      setArmedOverwrite(actionKey);
      showToast(state.reason, 'warning');
      return;
    }
    setArmedOverwrite(null);
    await runSyncAction(actionKey, true);
  };

  // 同步弹窗的键盘与焦点契约。两个面板同时只渲染一个，共用同一个 ref。
  // 不接管的话，Escape 会被 Header 注册的全局 CLEAR_SEARCH 快捷键抢走，
  // 结果是「关不掉弹窗，反而把弹窗背后的搜索框清空」。
  useDialogA11y(panelRef, showUploadModal || showDownloadModal, closeModals);

  // 手动同步的唯一入口：(方向, 模式) 决定下发给引擎的参数、埋点、失败文案。
  // 四个动作的行为差异全部来自 SYNC_ACTIONS 表，不再散落在四个函数体里。
  const runSyncAction = async (actionKey: SyncActionKey, isOverwriteConfirmed = false) => {
    const spec = SYNC_ACTIONS[actionKey];
    const direction: SyncOperation = actionKey.startsWith('upload') ? 'upload' : 'download';
    const mode = syncModeOf(actionKey);

    // 硬闸门：覆盖模式没有确认标记就拒跑（UI 侧已双闸门，这里是绕过 UI 时的兵底）
    if (!isOverwriteGateOpen({ mode, isConfirmed: isOverwriteConfirmed, isBusy: isWorking, isAuthenticated })) {
      return;
    }

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
        // 2026-10-07：reason 是内部枚举，不该原样弹给用户 —— `precheck_unknown`
        // 这种直接显示等于没说。逐条翻译；未登记的**纯 snake_case 枚举**退回到
        // spec.failureMessage（裸枚举对用户同样没说）；带人类可读文本的 reason
        //（如 `validation_failed: ...`、error.message）原样显示，便于定位。
        const REASON_COPY: Record<string, string> = {
          already_syncing: '同步正在进行中，请稍候',
          precheck_unknown:
            '本地存储读取失败，已中止同步以保护你的未上传内容，请稍后重试',
          // 上传后 UPLOAD_GUARD_MS（35s，见 syncDecision.ts）内的手动下载被跳过：
          // 云端已是本地新状态，再拉只会用旧数据覆盖（或与在途上传竞态）。
          recent_upload_guard: '刚完成上传，云端已是最新状态，无需下载',
          pending_upload_failed:
            '还有未上传的本地改动，已中止下载以免覆盖它们，请先完成上传',
          snapshot_failed: '本地快照创建失败，已中止同步以保护现有数据',
        };
        const mapped = reason != null ? REASON_COPY[reason] : undefined;
        const shown =
          reason === 'not_authenticated' && direction === 'download'
            ? '未登录'
            : mapped ||
              (reason && !/^[a-z_]+$/.test(reason) ? reason : undefined) ||
              spec.failureMessage;
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
          // 外层负责滚动、内层 min-h-full 居中：放得下就居中，放不下就从顶部起排并可滚动。
          // 之前是「flex items-center justify-center」且不可滚动——弹窗内容较高时（窄视口 /
          // 长会话名）会被垂直居中顶出屏幕，标题与关闭按钮落到视口上方且无法滚到（实测
          // 420×480 下弹窗高 1030、top −275，标题与关闭按钮都不可达）。与 AuthModal 同一模式。
          className={`fixed inset-0 z-[105] overflow-y-auto ${modalAnimation}`}
          onClick={closeModals}
        >
          <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-sm" />
          <div className="relative flex min-h-full items-center justify-center p-4">
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
                {/* 描述区固定最小高度：上传弹窗没有「当前合并策略」那行，下载有；
                    不固定的话两个弹窗高度不同，看起来「大小不一」。 */}
                <div className="mb-4 min-h-[4.5rem] text-center">
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
                    onClick={() => void handleSyncActionClick('upload.overwrite')}
                    disabled={uploadOverwriteState.type === 'blocked'}
                    aria-disabled={uploadOverwriteState.type === 'blocked'}
                    className="flex w-full flex-col justify-start overflow-hidden rounded-[24px] border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-sm dark:border-rose-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-rose-600 px-5 py-3.5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">覆盖模式</h4>
                      {renderPreviewSummary(
                        uploadPreview?.overwrite ?? null,
                        '云端',
                        '用当前本地会话直接替换云端现状。',
                      )}
                      {/* 闸门提示：blocked 说清为何点不动；armed 说清再点一次会发生什么 */}
                      <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                        {uploadOverwriteState.type === 'blocked'
                          ? uploadOverwriteState.reason
                          : uploadOverwriteState.type === 'armed'
                            ? uploadOverwriteState.reason
                            : '再点一次立即执行覆盖（不可撤销）'}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSyncActionClick('upload.merge')}
                    className="flex w-full cursor-pointer flex-col justify-start overflow-hidden rounded-[24px] border border-emerald-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-emerald-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-emerald-600 px-5 py-3.5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">合并模式</h4>
                      {renderPreviewSummary(
                        uploadPreview?.merge ?? null,
                        '云端',
                        '把本地会话按 ID 合并进云端，未命中的云端会话会保留。',
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
                {/* 与上传弹窗同高（min-h 固定描述区），保证两个弹窗尺寸一致。 */}
                <div className="mb-4 min-h-[4.5rem] text-center">
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
                    onClick={() => void handleSyncActionClick('download.overwrite')}
                    disabled={downloadOverwriteState.type === 'blocked'}
                    aria-disabled={downloadOverwriteState.type === 'blocked'}
                    className="flex w-full flex-col justify-start overflow-hidden rounded-[24px] border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-sm dark:border-rose-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-rose-600 px-5 py-3.5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">覆盖模式</h4>
                      {renderPreviewSummary(
                        downloadPreview?.overwrite ?? null,
                        '本地',
                        '用云端会话直接替换本地现状。',
                      )}
                      <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                        {downloadOverwriteState.type === 'blocked'
                          ? downloadOverwriteState.reason
                          : downloadOverwriteState.type === 'armed'
                            ? downloadOverwriteState.reason
                            : '再点一次立即执行覆盖（不可撤销）'}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSyncActionClick('download.merge')}
                    className="flex w-full cursor-pointer flex-col justify-start overflow-hidden rounded-[24px] border border-sky-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:border-sky-500/20 dark:bg-slate-900/80"
                  >
                    <div className="flex items-center justify-center bg-sky-600 px-5 py-3.5 text-white">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                    </div>
                    <div className="p-5">
                      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-50">合并模式</h4>
                      {renderPreviewSummary(
                        downloadPreview?.merge ?? null,
                        '本地',
                        '按当前同步策略把云端会话合并进本地。',
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
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default SyncButton;
