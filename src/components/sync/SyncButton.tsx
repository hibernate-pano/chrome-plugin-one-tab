import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { dispatchReloadSettings } from '@/store/slices/settingsSlice';
import { loadDownloadPreviewData, loadUploadPreviewData } from '@/services/syncPreviewLoader';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { decideOverwriteClick, decideSyncEntry, isOverwriteGateOpen, renderPreviewSummary, resolveSyncFailureCopy, shouldRenderSyncControls, syncIdentityCanRun, syncModeOf } from './syncPreviewView';
import { skippedRemoteGroupsNotice } from './skippedRemoteGroupsCopy';
import { skippedOverwriteNotice } from './skippedOverwriteNotice';
// ── 2026-10-22（402）：「云端项目被限制」的人话与机器判据 ─────────────────
// 预览读云端失败时，机器标记决定「说人话」还是「说读不到预览」（见两处 catch）。
import { isBackendUnavailableError } from '@/core/backendUnavailable';
import { backendUnavailableCopy } from './backendUnavailableCopy';

// 与 syncEngine.SyncOperation 同语义（仅 UI 进度条用），本文件不再 import syncEngine。
type SyncOperation = 'upload' | 'download' | 'none';
import { useToast } from '@/contexts/ToastContext';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';
import { trackProductEvent } from '@/utils/productEvents';
import { SyncPreviewSummary } from '@/utils/syncPreview';
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
    // 上传只是把设置**读出去**（syncEngine.upload → uploadSettings(storage.getSettings())），
    // 存储里的设置没被改写，本上下文无需重读。
    refreshSettings: false,
    // 空本地保护：覆盖上传被跳过时不能当成「上传成功」上报/提示。
    reportSkippedOverwrite: true,
  },
  'upload.merge': {
    command: { overwriteCloud: false, syncSettings: true },
    failureMessage: '上传失败，请重试',
    failureLogLabel: '上传数据到云端失败:',
    refreshLocal: false,
    // 同 upload.overwrite：上传不改本地设置。
    refreshSettings: false,
    reportSkippedOverwrite: false,
  },
  'download.overwrite': {
    command: { forceRemote: true, syncSettings: true },
    failureMessage: '下载失败，请重试',
    failureLogLabel: '从云端下载数据失败:',
    // 下载会改写本地会话，必须重载。
    refreshLocal: true,
    // 这一动作会在 SW 里把**云端设置**合并进存储（syncEngine.mergeCloudSettingsIntoLocal，
    // 由 syncSettings:true 触发）⇒ 本上下文的 settings state 与缓存都成了旧值。
    // 不重读的代价见 dispatchReloadSettings 注释：用户下一次改设置会把旧值整份回写。
    refreshSettings: true,
    reportSkippedOverwrite: false,
  },
  'download.merge': {
    command: { forceRemote: false, syncSettings: false },
    failureMessage: '下载失败，请重试',
    failureLogLabel: '从云端下载数据失败:',
    refreshLocal: true,
    // 合并下载不带 syncSettings ⇒ 存储里的设置没被动过，无需重读。
    refreshSettings: false,
    reportSkippedOverwrite: false,
  },
} as const;

type SyncActionKey = keyof typeof SYNC_ACTIONS;

export const SyncButton: React.FC<SyncButtonProps> = () => {
  const dispatch = useAppDispatch();
  /**
   * 登录态的**那一档**（四档 + 还没核），不是「登录了没」这个布尔。
   *
   * ⚠️ 2026-10-23（第 50 轮）：以前这里取的是 `isAuthenticated`，
   * 而那个布尔把「核不到」（断网 / 402）与「核到没登录」压成同一件事
   * ⇒ 断网时点同步得到的回复是「还没有登录 TapStack 云端，请先去登录」——
   * 事实错（用户多半登录着），动作也错（断网时登录必然失败）。
   */
  const authStatusKind = useAppSelector(state => state.auth.authStatusKind);
  const auth = authStatusKind ?? 'unchecked';
  const settings = useAppSelector(state => state.settings);
  /**
   * 「当前身份能不能真的跑一次同步」（与 authGuard / backgroundSync 同口径，按后端分流）。
   *
   * 2026-10-18 C 组修正：原先是 `canSync = webdav || isAuthenticated`，而它同时被
   * 用来**隐藏整组按钮**和**给 isOverwriteGateOpen 传 isAuthenticated**。拆开之后：
   *   · 渲染不再看身份（见下方 shouldRenderSyncControls），未登录用户也看得见同步；
   *   · 身份只决定「点下去能不能真跑」，不能跑时由入口闸门当场给出下一步。
   * 自带存储（WebDAV）用户没有 TapStack 账号，登录态恒为 false，
   * 所以判据必须按后端分流而不是直接读登录态。
   */
  const identityCanRun = syncIdentityCanRun({
    syncBackend: settings.syncBackend,
    auth,
  });
  const identityGate = { syncBackend: settings.syncBackend, auth };
  /**
   * 上传覆盖在自带存储（WebDAV）上**不删云端独有会话**（全量上行 + 清单并集，
   * 见 `syncPreview.buildUploadPreviewSummary` 的 preserveRemoteOnly）。
   * 预览与说明文案都必须按后端分流，否则用户会被一个不存在的删除数吓住，
   * 而同一后端的设置页口径恰恰写着「云端独有会话未被删除」。
   */
  const uploadOverwritePreservesRemote = settings.syncBackend === 'webdav';
  const [isWorking, setIsWorking] = useState(false);
  const [workingOperation, setWorkingOperation] = useState<SyncOperation>('none');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [modalAnimation, setModalAnimation] = useState('');
  const [isUploadPreviewLoading, setIsUploadPreviewLoading] = useState(false);
  const [isDownloadPreviewLoading, setIsDownloadPreviewLoading] = useState(false);
  const [uploadPreviewError, setUploadPreviewError] = useState<string | null>(null);
  const [downloadPreviewError, setDownloadPreviewError] = useState<string | null>(null);
  const [uploadPreview, setUploadPreview] = useState<ModePreviewMap | null>(null);
  const [downloadPreview, setDownloadPreview] = useState<ModePreviewMap | null>(null);
  // ⚠️ 2026-10-23（第 51 轮）：这里原本还有一个**独立的** `uploadPreservedCount`
  // 状态（覆盖上传时「云端会被保住几行」）。它与摘要里的 `preservedCount`
  // 是**同一个判据算出来的同一个数**（core/overwriteUploadGuard.ts）⇒ 两份数字
  // 必然漂移（改了一处忘了另一处 ⇒ 卡片与风险文案对不上）。
  // ⇒ 现在只留**一个**来源：摘要里的 `preservedCount`（预览与执行同源）。
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
      // 数据装配搬到 services/syncPreviewLoader.ts（2026-10-23，第 51 轮）：
      // 「读真值 + 读云端 + 算摘要」必须在**能直接被测到**的地方 ——
      // 留在组件里的话，守卫只能对着源码长相断言，而源码长相证明不了
      // 「那份清单真的进了预览」。
      const data = await loadUploadPreviewData({
        preserveRemoteOnly: uploadOverwritePreservesRemote,
      });
      setUploadPreview({
        overwrite: data.overwrite,
        merge: data.merge,
      });
    } catch (error) {
      logError('加载上传预览失败:', error);
      // ── 2026-10-22（402）：「服务端不可用」要说人话，而不是「读不到预览」──
      // 这一句原先是**所有**失败共用的兜底：「暂时无法读取云端会话预览」。
      // 而生产实测（项目被封禁）时它**特别误导**：用户读到的是「预览读不出来」
      // ⇒ 他会以为是自己云端的数据有问题、反复点、或者干脆不敢同步。
      //
      // 机器标记优先（判据在 core/backendUnavailable.ts，不靠文案匹配）。
      setUploadPreviewError(
        isBackendUnavailableError(error)
          ? backendUnavailableCopy('upload')
          : '暂时无法读取云端会话预览：合并模式仍可使用，覆盖模式需预览就绪后才会解锁。'
      );
      setUploadPreview(null);
    } finally {
      setIsUploadPreviewLoading(false);
    }
  };

  const loadDownloadPreview = async () => {
    setIsDownloadPreviewLoading(true);
    setDownloadPreviewError(null);

    try {
      // 同上：数据装配在 services/syncPreviewLoader.ts（能直接被测到）。
      const data = await loadDownloadPreviewData();

      setDownloadPreview({
        overwrite: data.overwrite,
        merge: data.merge,
      });
    } catch (error) {
      logError('加载下载预览失败:', error);
      // ── 2026-10-22（402）：同上 —— 「服务端不可用」要说人话 ───────────────
      setDownloadPreviewError(
        isBackendUnavailableError(error)
          ? backendUnavailableCopy('download')
          : '暂时无法读取云端会话预览：合并模式仍可使用，覆盖模式需预览就绪后才会解锁。'
      );
      setDownloadPreview(null);
    } finally {
      setIsDownloadPreviewLoading(false);
    }
  };

  /**
   * 打开任一同步弹窗前的统一入口：身份不足就不开，并**当场**说清缺什么、去哪补。
   *
   * 这一条是 C 组的关键：放宽渲染门禁后，若入口仍静默放行，未登录用户会经历
   * 「按钮出现 → 弹窗能开 → 点覆盖两下 → 毫无反应」。所以缺身份时不开弹窗，
   * 而是立刻给出可执行提示（不是编辑弹窗里那句「上传失败，请重试」）。
   */
  const openSyncModal = (direction: SyncOperation) => {
    const decision = decideSyncEntry({ ...identityGate, isBusy: isWorking });
    if (decision.type === 'blocked') {
      showToast(decision.reason, 'warning');
      return;
    }
    setModalAnimation('animate-fadeIn');
    setArmedOverwrite(null);
    if (direction === 'upload') {
      setShowUploadModal(true);
      void loadUploadPreview();
    } else {
      setShowDownloadModal(true);
      void loadDownloadPreview();
    }
  };

  // 处理上传按钮点击
  const handleUpload = () => openSyncModal('upload');

  // 处理下载按钮点击
  const handleDownload = () => openSyncModal('download');

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
    // 有读不出来的云端会话会被保留 ⇒ 风险文案必须说出来（预览不得预告与实际相反）。
    //
    // 取值来自**预览摘要自己算出来的那个数**（buildUploadPreviewSummary 用的是
    // 与执行侧同一个判据函数）⇒ 卡片上显示的、风险文案里说的、实际会保留的
    // 是同一个数，不会各算各的。
    preservedCount: uploadPreview?.overwrite?.preservedCount ?? 0,
  });
  const downloadOverwriteState = decideOverwriteClick({
    summary: downloadPreview?.overwrite ?? null,
    isPreviewLoading: isDownloadPreviewLoading,
    hasPreviewError: !!downloadPreviewError,
    isArmed: armedOverwrite === 'download.overwrite',
    isBusy: isWorking,
    targetLabel: '本地',
    // 覆盖下载会保住「云端这轮读不出来、本机有副本」的那几份 ⇒ 风险文案必须
    // 说出来（「直接替换本地现状」在有保住项时**不再成立**）。
    // 取值来自**预览摘要自己算出来的那个数** ⇒ 卡片上显示的、风险文案里说的、
    // 实际会保住的是同一个数，不会各算各的。
    preservedCount: downloadPreview?.overwrite?.preservedCount ?? 0,
  });

  /**
   * 两个模式卡片的统一点击出口。覆盖模式在这里被拆成两下：
   * blocked → 告知原因不执行；armed → 写入风险文案、不下发；run → 真下发。
   * 合并模式无破坏性，直接执行（但同样会清掉 armed 状态，避免跨模式误触发）。
   */
  const handleSyncActionClick = async (actionKey: SyncActionKey) => {
    // 兵底：入口闸门已拦住缺身份的情况，这里再拦一次，保证**不可能**通过
    // 任何路径走到「点了两下毫无反应」。
    const entry = decideSyncEntry({ ...identityGate, isBusy: isWorking });
    if (entry.type === 'blocked') {
      showToast(entry.reason, 'warning');
      return;
    }
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
    // 形参沿用 isOverwriteGateOpen 的 isAuthenticated 命名，但传的是**身份能否真跑**
    // 的判定（按后端分流）——WebDAV 用户没有账号，传裸 isAuthenticated 会把他拦死。
    if (!isOverwriteGateOpen({ mode, isConfirmed: isOverwriteConfirmed, isBusy: isWorking, isAuthenticated: identityCanRun })) {
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
      // 真实进度在 SW 侧，跨消息边界不会回传到 popup：
      // 顶栏用不定式条表达“进行中”，真实结果经 sendSyncCommand 消息回传。
      const res = await sendSyncCommand(direction, spec.command);

      if (res.ok) {
        if (spec.refreshLocal) {
          await refreshLocal();
        }
        if (spec.refreshSettings) {
          // 覆盖下载在 SW 里改写了存储中的设置，本上下文手里的是旧值（缓存也没失效）。
          // 重读失败必须出声：此时界面显示旧设置，而用户接着改任何一项都会把旧值
          // 整份回写（saveSettings 是盲写）并上传 —— 静默的话没人会知道。
          const reloadError = await dispatchReloadSettings(dispatch);
          if (reloadError) {
            logWarn('同步后重读设置失败，界面可能显示旧值:', reloadError);
            showToast('设置已从云端更新，但界面没能重新读取；请重新打开本窗口，期间先别改设置', 'warning');
          }
        }

        if (direction === 'upload' && spec.reportSkippedOverwrite) {
          // 空本地保护：本地没有任何活跃组时覆盖上传被跳过（绝不清空云端）。
          // 引擎把这件事如实回传，这里不能再当成「上传成功」上报/提示。
          //
          // 2026-10-23（R-1）新增第二种跳过理由 `no-account-groups`：换账号后
          // 本机的会话都属于上一个账号 ⇒ 闸门放行 0 个 ⇒ 覆盖会删空**当前账号**
          // 的云端却什么都不会写 ⇒ 纯数据丢失 ⇒ 跳过并如实上报。
          // 两种理由的文案由同一个纯函数产出（skippedOverwriteNotice），
          // 两处消费点不会各说各话。
          const payload = res.payload as { skippedOverwrite?: string } | undefined;
          const notice = skippedOverwriteNotice(payload?.skippedOverwrite);
          if (notice) {
            showToast(notice.text, notice.level);
            return;
          }
        }

        // ── 2026-10-20：「云端有会话这轮读不出来」必须让用户看见 ──────────
        //
        // 根因：云端下行时读不出来的会话会被**整组跳过**（形状读不出来 /
        // 还原率不达标 / tabs 表被网关截断 / 单组处理异常，见
        // src/utils/supabase/download.ts），而这件事过去**只写进日志**。
        // 于是界面报「同步成功」，用户却在列表里发现少了几组，无法解释自己
        // 为什么少了东西 —— v1.22.0 起删除即物理清除、无回收站，用户的第一
        // 反应必然是「是不是同步把我的东西弄丢了」。
        //
        // 为什么不是 error：这一轮**没有硬失败**，重试也不会变好（云端那行
        // 还是读不出来）。说成失败 ⇒ 界面弹「下载失败，请重试」⇒ 用户一直
        // 点重试，那是**误导性失败**，比谎报成功更糟。所以级别固定为 info。
        //
        // 为什么模式由**组件**判断而不是依赖引擎回传：引擎侧有没有带模式信息
        // 是引擎的事，而「本次是不是覆盖」这个状态组件本来就知道（SYNC_ACTIONS
        // 的 command.forceRemote）。依赖自己已知的真相，比依赖别人回传更可靠。
        //
        // 字段缺失（老后端 / 测试替身 / 这轮没跳过任何会话）⇒ notice 为 null
        // ⇒ **一个字都不多说**（弹「0 个会话读不出来」是纯噪音）。
        if (direction === 'download') {
          const payload = res.payload as
            | { skippedRemoteGroups?: { count?: number; ids?: string[] } }
            | undefined;
          const notice = skippedRemoteGroupsNotice({
            direction,
            mode,
            count: payload?.skippedRemoteGroups?.count,
          });
          if (notice) {
            showToast(notice.text, notice.severity, notice.durationMs);
          }
        }

        void trackProductEvent(
          direction === 'upload' ? 'sync_upload_completed' : 'sync_download_completed',
          trackingPayload()
        );
      } else {
        const reason = res.error;
        // 2026-10-07：reason 是内部枚举，不该原样弹给用户 —— `precheck_unknown`
        // 这种直接显示等于没说。翻译表与兜底规则集中在 syncPreviewView
        //（纯函数，可直接单测）；未登录在**两个方向**都有可执行文案。
        //
        // ── 2026-10-22（402）：把「服务端不可用」的机器标记交给翻译层 ──────
        // 标记不传 ⇒ 翻译层只能落到兜底「上传失败，请重试」⇒ 而重试无用
        // （项目被封禁）。方向由本组件自己知道（direction 变量），
        // 不去猜 payload 里的内容。
        showToast(
          resolveSyncFailureCopy({
            reason,
            fallbackMessage: spec.failureMessage,
            backendUnavailable: res.backendUnavailable === true,
            direction,
          }),
          'error'
        );
      }
    } catch (error) {
      logError(spec.failureLogLabel, error);
      showToast(spec.failureMessage, 'error');
    } finally {
      setIsWorking(false);
      setWorkingOperation('none');
    }
  };

  if (!shouldRenderSyncControls(settings.syncBackend)) {
    // 2026-10-18 C 组：不再按登录态隐藏整组按钮。云端未登录用户也要看得见同步，
    // 点下去由 decideSyncEntry 说清「未登录 + 去菜单登录」，而不是凭空消失
    //（新装扩展默认后端是 supabase，隐藏等于新用户完全不知道有同步这回事）。
    return null;
  }

  return (
    <>
      <div className="sync-button flex items-center gap-2">
        {workingOperation !== 'none' && isWorking && (
          <div
            className="h-1.5 w-16 overflow-hidden rounded-full theme-bg-tertiary"
            role="progressbar"
            aria-label={workingOperation === 'upload' ? '正在上传' : '正在下载'}
          >
            {/* 不定式进度：真实进度在 SW 侧，popup 拿不到回传；
                用匀速假百分比会给虚假安全感，改为来回扫动的条 + 文字说明。
                2026-10-22 审计 U-01：轨道与进度条原先写死 bg-gray-200/dark:bg-slate-700
                与 text-green-600 —— 固定灰阶与固定绿，在暖色主题里色相不属于主题。
                现在都读主题令牌：轨道 = --color-bg-tertiary，
                进度条 = --color-accent-text（accent 的「当墨色用」那一档）。
                这里没用 --color-success：实测它在 legacy / prism / apple 浅色主题的
                轨道上只有 2.04–2.08:1（低于非文本 3:1），accent 墨色最差 4.89:1。 */}
            <div className="h-full w-1/2 animate-pulse rounded-full bg-current theme-accent-text motion-safe:animate-[tapstack-indeterminate_1.2s_ease-in-out_infinite]" />
          </div>
        )}

        {/* ── 2026-10-19 审计 F-1（P0）：窄屏下这两颗按钮必须收成图标 ────────
         *
         * 修复前它们是**带文字**的「上传」「下载」，合计 148px；而顶栏操作区
         * `flex-shrink: 0`，搜索框那一列是 `minmax(0, 1fr)` —— 于是 400px 宽的
         * 窗口里搜索框被压成 **0 宽**，
         * 「找回会话」这个核心入口整框消失。
         *
         * 主审真机复现（400×700）：`.app-header-search w=0`、
         * `.search-input w=26`、`.app-header-actions w=308`（占可用 376px 的 82%）。
         *
         * 修法：`lg`（1024px）以下只留图标（`hidden lg:inline` 收掉文字），
         * `lg` 以上恢复文字标签。图标与文字都保留可访问名称 —— 读屏用户
         * 拿到的名字和视觉用户看到的一致，不因断点而失真。
         *
         * 断点取 `lg` 而不是 `sm`：641–1024px 这段操作区最宽 421px，
         * 而顶栏在该区间让搜索独占一行（见 global.css 的 grid-template-areas），
         * 两颗带文字的同步按钮仍会把首行挤爆。
         *
         * ── 2026-10-20 几何修复：命中区必须 ≥36×36 ────────────────────────
         * 收成图标之后，这两颗按钮的命中区只剩 **32×28px**（实测 400px 与
         * 1280px 两处）—— 比顶栏其它图标按钮（`.btn-icon` 的 36×36）小一圈。
         * 顶栏那条 `@media (max-width:640px) { .btn-icon { min-width/min-height: 2.25rem } }`
         * 管不到它们：它们用的是自己的 `px-2 py-1.5`，压根不是 `.btn-icon`。
         *
         * 补 `min-w-9 min-h-9`（= 2.25rem = 36px），把两颗按钮纳入与
         * `.btn-icon` 相同的尺寸下限。选 36px 的理由见 hitTarget.ts：
         * WCAG 2.2 的 SC 2.5.8（AA）下限是 24px、SC 2.5.5（AAA）要 44px；
         * 400px 宽的顶栏装不下 44px（操作区已占 280px），36px 是留足余量
         * 又不牺牲可用性的那个值。
         */}
        <div className="flex items-center gap-1 lg:gap-2">
          {/*
            2026-10-22 审计 U-01：这两颗按钮原先写死 `bg-green-100 text-green-600`
            与 `bg-primary-100 text-primary-600` ——
            · primary 是 Tailwind 的**固定品牌蓝**，不跟主题走 ⇒ 12 套主题 × 明暗下
              颜色完全不变（claude 主题的顶栏同时出现绿 / 蓝 / 陶土红三种色相）；
            · 对比度实测 3.00:1 与 4.24:1，**都低于 AA 的 4.5:1**（标签 13px）。
            现在两处都读主题令牌：底色 --color-accent-soft、文字 --color-accent-text
            （这组值在 6 套主题 × 明暗下都 ≥4.5:1，见 tests/guards/themeContrast.test.ts）。
            上传/下载靠**图标形状**区分（向上入托盘 / 向下入托盘），图标语义不动。

            2026-10-22 审计 U-14：圆角原先写死 `rounded-md`（= 6px），是 6 套主题里
            唯一的离群形状（chrome/apple 的语言是 10px 软圆角，其余 8px）——
            同一排按钮在 6 套主题下看起来像 6 个产品。现在读 --radius-btn
            （theme-radius-btn），跟着本主题的形状语言走。 */}
          <button
            type="button"
            onClick={handleUpload}
            disabled={isWorking}
            className={`flex items-center whitespace-nowrap px-2 lg:px-3 py-1.5 min-w-9 min-h-9 theme-radius-btn text-sm flat-interaction theme-accent-soft theme-accent-text ${
              isWorking ? '' : 'hover:theme-accent-wash'
            } transition-colors`}
            title="手动上传本地会话到云端"
            aria-label="上传本地会话到云端"
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
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 lg:mr-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span className="hidden lg:inline">上传</span>
              </>
            )}
          </button>

          <button
            onClick={handleDownload}
            disabled={isWorking}
            className={`flex items-center whitespace-nowrap px-2 lg:px-3 py-1.5 min-w-9 min-h-9 theme-radius-btn text-sm flat-interaction theme-accent-soft theme-accent-text ${
              isWorking ? '' : 'hover:theme-accent-wash'
            } transition-colors`}
            title="手动从云端下载会话到本地"
            aria-label="从云端下载会话到本地"
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
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 lg:mr-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden lg:inline">下载</span>
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
              className={`relative w-full max-w-lg overflow-hidden theme-radius-panel border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur focus:outline-none dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
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

                <div className="grid grid-cols-1 gap-4">
                  <button
                    type="button"
                    onClick={() => void handleSyncActionClick('upload.overwrite')}
                    disabled={uploadOverwriteState.type === 'blocked'}
                    aria-disabled={uploadOverwriteState.type === 'blocked'}
                    className="flex w-full flex-col justify-start overflow-hidden theme-radius-card border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-sm dark:border-rose-500/20 dark:bg-slate-900/80"
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
                        uploadOverwritePreservesRemote
                          ? '把本机全部会话写入云端；云端独有会话保留，同 id 冲突按版本新旧裁决。'
                          : '用当前本地会话直接替换云端现状。',
                        uploadPreview?.overwrite?.preservedCount ?? 0,
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
                    className="flex w-full cursor-pointer flex-col justify-start overflow-hidden theme-radius-card border border-emerald-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-emerald-500/20 dark:bg-slate-900/80"
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
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={downloadTitleId}
              aria-describedby={downloadDescriptionId}
              tabIndex={-1}
              className={`relative w-full max-w-lg overflow-hidden theme-radius-panel border border-slate-200/80 bg-white/95 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ring-1 ring-white/60 backdrop-blur focus:outline-none dark:border-slate-700/80 dark:bg-slate-900/95 dark:ring-slate-800/80 ${modalAnimation}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={closeModals}
                className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200/80 bg-white/80 text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-slate-700/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                aria-label="关闭同步弹窗"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="px-6 pb-6 pt-6 sm:px-7 sm:pb-7 sm:pt-7">
                {/* 与上传弹窗同高（min-h 固定描述区），保证两个弹窗尺寸一致。 */}
                <div className="mb-4 min-h-[4.5rem] text-center">
                  <h3 id={downloadTitleId} className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">下载到本地</h3>
                  <p id={downloadDescriptionId} className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">先看这次会怎么改动本地会话，再决定覆盖还是合并</p>
                  {/* ── 2026-10-19 审计 C-6：删掉「当前合并策略」这行 ──────────
                   * 它展示的是 settings.syncStrategy，但那个设置**没有任何入口**
                   * （grep 全仓：除默认值、上/下行字段映射、诊断导出与这一行
                   * 之外没有读取方），而合并**固定**走 mergeOpStamped
                   * （组级 LWW 整组覆盖，见 src/services/syncEngine.ts）。
                   *
                   * 也就是说这行在陈述一个用户改不了、且**根本没被执行**的策略。
                   * 若存量设置是 local / remote / ask，弹窗会显示一个从未发生
                   * 的合并行为 —— 这是本仓库最不该出现的一类谎报。
                   *
                   * ⚠️ 2026-10-23 第 50 轮：下面这行原先写的是「后保存的那台赢」
                   * —— **那是假话**。胜负由 (序号, 设备编号) 决胜，而两台设备的
                   * 序号来自**各自独立**的计数器 ⇒ 先保存的那台完全可能赢
                   * （真相源：src/core/opStamp.ts 与 src/core/opStampMerge.ts
                   * 的文件头注释；DS-43-18）。
                   * ⇒ 这里改成与商店 Known Issues 同一口径：说清「印记决胜」，
                   * 并说清败方的后果（**整组**被替换，不是合并）。 */}
                  <p className="mt-2 text-xs font-medium text-sky-600 dark:text-sky-300">
                    同一会话两边都改过时，由操作印记决胜（后改的不一定赢），输的一边这次改动会被整组替换
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

                <div className="grid grid-cols-1 gap-4">
                  <button
                    type="button"
                    onClick={() => void handleSyncActionClick('download.overwrite')}
                    disabled={downloadOverwriteState.type === 'blocked'}
                    aria-disabled={downloadOverwriteState.type === 'blocked'}
                    className="flex w-full flex-col justify-start overflow-hidden theme-radius-card border border-rose-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-sm dark:border-rose-500/20 dark:bg-slate-900/80"
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
                        downloadPreview?.overwrite?.preservedCount ?? 0,
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
                    className="flex w-full cursor-pointer flex-col justify-start overflow-hidden theme-radius-card border border-sky-200/70 bg-white text-left shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-sky-500/20 dark:bg-slate-900/80"
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
                        '按 ID 把云端会话合并进本地，未命中的本地会话会保留。',
                      )}
                    </div>
                  </button>
                </div>

                <div className="mt-6 text-center">
                  <button
                    type="button"
                    onClick={closeModals}
                    className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
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
