import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { deleteAllGroups, deleteBroadcastWarn, loadGroups } from '@/store/slices/tabSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { storage } from '@/utils/storage';
import { useToast } from '@/contexts/ToastContext';
import {
  getLastBackendResolution,
  invalidateActiveSyncBackend,
  primeSyncBackend,
} from '@/sync-backend';
import {
  BACKEND_STATUS_DOT_CLASS,
  BACKEND_STATUS_TITLE,
  classifyBackendResolution,
  formatLastSyncTime,
  UNKNOWN_BACKEND_STATUS,
  type BackendStatus,
} from './backendStatus';
import { logError, logWarn } from '../../utils/log';

interface HeaderDropdownProps {
  onClose: () => void;
  /** 窄屏顶栏把布局切换收进了菜单，这里复用 Header 同一份逻辑，避免两份实现分叉。 */
  onToggleLayout?: () => void;
  /** 窄屏顶栏把「清理重复」收进了菜单，同上：复用 Header 的确认弹窗与执行路径。 */
  onRequestCleanDuplicates?: () => void;
}

/** 菜单行的统一 hover 反馈。菜单行不做位移（flat-interaction 的 -translate-y 会轻微跳动），只做背景色。 */
const MENU_ROW = "w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 flex items-center transition-colors duration-150 theme-menu-hover";

/**
 * 读一次**真实**的后端状态（2026-10-16，Wave 2B 缺陷 1）。
 *
 * 为什么每次打开菜单都强制重解析（`invalidateActiveSyncBackend` + `primeSyncBackend`）：
 * `activeBackend` 是**本执行上下文**的进程内缓存，用户在另一个窗口的设置页
 * 改完配置后，popup 这边不会收到任何通知。状态行要回答的是「现在到底能不能
 * 同步」，不是「这个页面半分钟前解析出了什么」，所以必须重新读设置与解锁状态。
 * 解析本身不碰网络（构造适配器不发请求），代价只有一次本地存储读。
 */
async function readBackendStatus(): Promise<BackendStatus> {
  try {
    invalidateActiveSyncBackend();
    await primeSyncBackend();
    return classifyBackendResolution(getLastBackendResolution());
  } catch (error) {
    logWarn('[HeaderDropdown] 同步状态解析失败，按「状态未知」展示:', error);
    return classifyBackendResolution(null);
  }
}

export const HeaderDropdown: React.FC<HeaderDropdownProps> = ({
  onClose,
  onToggleLayout,
  onRequestCleanDuplicates,
}) => {
  const dispatch = useAppDispatch();
  const { groups } = useAppSelector(state => state.tabs);
  const settings = useAppSelector(state => state.settings);
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(null);
  // 同步状态行的两个真值（2026-10-16，Wave 2B 缺陷 1 / 2）：
  //   · backendStatus ← getLastBackendResolution()，不再是一颗写死的绿点；
  //   · lastSyncAt    ← storage.getLastSyncTime()。Redux 的 tabs.lastSyncTime
  //     没有任何 reducer / thunk 写过，读它等于这一行永远不渲染。
  const [backendStatus, setBackendStatus] = useState<BackendStatus>(UNKNOWN_BACKEND_STATUS);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  // ── 2026-10-09 P1-5：从云端刷新必须有「进行中 / 成功 / 失败」三态 ──
  // 原先无 isRefreshing、成功也不给任何反馈：点一下如果云端没有新数据，
  // 页面**毫无变化**，用户完全无法区分「已经是最新」「没点上」「坏了」。
  // 同步按钮本体有进度条和 toast，这个刷新快捷入口一条都没有。
  const [isRefreshing, setIsRefreshing] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { showConfirm, showAlert, showToast } = useToast();

  /**
   * 打开独立设置页（2026-10-14）。
   *
   * 为什么不是把设置留在菜单里，也不是用弹窗：菜单只有 256px 宽且是瞬态的，
   * 托不住 WebDAV 表单（详见渲染处注释）。Chrome 的 `options_ui` 才是正解 ——
   * 独立窗口、关闭时状态保留、用户在扩展详情页也有入口。
   *
   * 失败必须出声：`openOptionsPage` 在 manifest 缺 `options_ui` 时可能静默失败，
   * 表现为「点了没反应」—— 与本轮修掉的那个死锁是同一类病，不能重蹈。
   */
  const handleOpenOptions = useCallback(() => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (error) {
      logError('[HeaderDropdown] 打开设置页失败:', error);
      showToast('打开设置页失败，请在扩展管理页点「扩展选项」进入', 'error');
    }
    onClose();
  }, [onClose, showToast]);

  // 处理快速刷新（从云盘下载并合并）
  //
  // 2026-10-16：原先开头有一道 `if (!isAuthenticated) { 弹「请先登录」 }` 门禁，
  // 现在没有任何登录概念，所以这道门禁删掉——未配置/未解锁云盘由 SW 侧的
  // 锁定占位后端处理，它抛的是可读错，文案原样进下面的错误弹窗。
  const handleQuickRefresh = async () => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    try {
      const res = await sendSyncCommand('download', {
        forceRemote: false,
        syncSettings: false,
      });

      if (res.ok) {
        try {
          await dispatch(loadGroups()).unwrap();
          // 成功也要说话：云盘无变化时页面不会有任何视觉差异，
          // 不给一句「已是最新」就等于「点了没反应」。
          showToast('云盘已是最新', 'success');
        } catch (err) {
          // 本地列表没刷出来 —— 这是「云盘成功了但你没看见」的中间态，
          // 必须说清楚，否则用户以为同步失败（或反过来以为成功了）。
          logWarn('同步后刷新本地会话失败:', err);
          showToast('已同步，但本地列表刷新失败，请稍后重试', 'error');
        }
      } else {
        // 这里的弹窗是**明确的失败**（云盘已解锁但拉取失败）。
        // 引擎回传的可能文案里，最常见的是「未配置 / 未解锁」—— 那是设置问题，
        // 区别于「拉取失败」很重要：前者要去设置页，后者可以重试。
        showAlert({
          title: '手动同步失败',
          message: res.error || '无法从云盘拉取数据',
          type: 'error',
          onClose: () => {}
        });
      }
    } catch (error) {
      logError('手动同步失败:', error);
      showAlert({
        title: '手动同步失败',
        message: '网络连接失败，请稍后重试',
        type: 'error',
        onClose: () => {}
      });
    } finally {
      setIsRefreshing(false);
      // 这次尝试可能改变了解锁 / 配置状态（例如口令缺失导致后端解析成锁定），
      // 重查一次，让状态行与刚刚发生的事一致。
      setBackendStatus(await readBackendStatus());
      try {
        setLastSyncAt(await storage.getLastSyncTime());
      } catch (error) {
        logWarn('[HeaderDropdown] 刷新后读取最后同步时间失败:', error);
      }
    }
  };

  // 菜单每次打开都会挂载本组件（Header 里是条件渲染），所以这条 effect 就是
  // 「每次打开菜单做一次真实检查」——不是组件生命周期里只跑一次的装饰。
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const status = await readBackendStatus();
      if (!alive) return;
      setBackendStatus(status);
      try {
        const time = await storage.getLastSyncTime();
        if (alive) setLastSyncAt(time);
      } catch (error) {
        // 读不到时间就不渲染那一行 —— 不拿编出来的值冒充「上次同步」。
        logWarn('[HeaderDropdown] 读取最后同步时间失败:', error);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, []);

  // 处理点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // 移除同步功能，简化逻辑

  // 处理删除所有标签组。核弹级操作：不受「删除会话前确认」开关控制，永远弹确认
  // （该开关只应管单组删除；关闭后一键删光全部曾造成误操作事故 2026-09-26）。
  // 无墓碑模型（2026-09-29）：删除即物理移除，跨设备广播由云端 is_deleted 行承担。
  const handleDeleteAllGroups = () => {
    if (groups.length === 0) return;

    const runDeleteAll = () => {
      onClose();

      dispatch(deleteAllGroups())
        .unwrap()
        .then(payload => {
          // 广播登记失败时本地已删干净，但云端行不会被标 is_deleted ⇒
          // 其它设备下次合并会把它当 remote-only 全部复活。必须如实告知。
          const warn = deleteBroadcastWarn(payload);
          if (warn) {
            showAlert({
              title: '删除未完全同步',
              message: warn,
              type: 'warning',
              onClose: () => {}
            });
          }
          // 2026-10-16：原先这里包在 `if (isAuthenticated)` 里，
          // 未登录时不推送。现在没有登录概念 —— 删光本机会话后把删除
          // 意图广播到云盘，是唯一保证其它设备不复活的途径，所以**无条件**推送。
          // 后端不可用（未配置/未解锁）时 res.ok 为 false，下面会出声。
          sendSyncCommand('upload', {
            overwriteCloud: true,
            syncSettings: true,
          })
            .then(raw => {
              const res = raw as { ok: boolean; error?: string; payload?: { skippedOverwrite?: string } };
              // 「删光本机全部会话」之后本地没有活跃组 → 上传侧的
              // 空本地保护必然跳过 overwriteCloud（宁可不清空云盘）。也就是说
              // 这条命令的覆盖上传几乎总是被跳过，此前无条件打印
              // 「删除操作已同步到云端」是在对没发生的事报成功。
              // 只有 res.ok 且 payload 里没有 skippedOverwrite，才算真的覆盖了云盘。
              if (!res.ok) {
                logError('删除操作同步到云盘失败:', res.error);
                showAlert({
                  title: '同步失败',
                  message: `本机会话已删除，但云盘同步失败：${res.error || '未知错误'}`,
                  type: 'error',
                  onClose: () => {}
                });
                return;
              }
              if (res.payload?.skippedOverwrite) {
                // 删光后本地无活跃组 → 覆盖被跳过是预期路径；删除意图已由
                // 上传内的 markCloudGroupsAsDeleted（pendingDeleteIds 队列）
                // 广播到云盘，无需报警。
                logWarn('[HeaderDropdown] 覆盖上传被跳过（本地无活跃组），删除意图已按队列广播:', res.payload.skippedOverwrite);
                return;
              }
              logWarn('[HeaderDropdown] 删除操作已同步到云盘');
            })
            .catch(error => {
              logError('同步到云盘失败:', error);
            });
        })
        .catch(error => {
          logError('删除所有标签组失败:', error);
          showAlert({
            title: '删除失败',
            message: '删除所有会话失败',
            type: 'error',
            onClose: () => { }
          });
        });
    };

    showConfirm({
      title: `删除全部 ${groups.length} 个会话`,
      // 2026-10-16：原先这里是 `${isAuthenticated ? '，其他登录设备将同步删除' : ''}`。
      // 现在没有登录状态可判，而删除意图**总是**会广播到云盘，所以直接写死：
      // 告诉用户会发生什么，比按一个已不存在的状态分支更诚实。
      message: `将删除本地全部 ${groups.length} 个会话，删除后无法恢复，其他设备下次同步时也会删除。确认继续吗？`,
      type: 'danger',
      confirmText: '全部删除',
      cancelText: '取消',
      onConfirm: runDeleteAll,
      onCancel: () => { }
    });
  };

  // 导出数据为 JSON 格式
  const handleExportData = async () => {
    try {
      setOpenSubmenu(null);
      const exportData = await storage.exportData();
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-backup-${year}-${month}-${day}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出数据失败，请重试',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 导出数据为 OneTab 格式
  const handleExportOneTabFormat = async () => {
    try {
      setOpenSubmenu(null);
      const oneTabText = await storage.exportToOneTabFormat();
      const blob = new Blob([oneTabText], {
        type: 'text/plain'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // 安全地处理日期格式化
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      a.download = `onetab-export-${year}-${month}-${day}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出 OneTab 格式数据失败:', error);
      showAlert({
        title: '导出失败',
        message: '导出 OneTab 格式数据失败，请重试',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 坏时间戳 → null → 整行不渲染（formatLastSyncTime 里对 NaN 的处理）。
  const lastSyncLabel = lastSyncAt ? formatLastSyncTime(lastSyncAt) : null;
  const lastSyncTitle =
    lastSyncAt && lastSyncLabel ? `上次成功同步：${new Date(lastSyncAt).toLocaleString()}` : null;

  return (
    <div
      ref={dropdownRef}
      role="menu"
      aria-label="应用菜单"
      className="ts-panel absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] theme-bg-elevated theme-radius-card theme-shadow-panel border theme-border-default z-20 max-h-[70vh] overflow-y-auto"
    >
      <div className="py-2">
        {/* 2026-10-16：原先这里是一块「只有已登录才渲染」的用户卡片
            （邮箱 + 已登录圆点 + 刷新按钮 + 上次同步时间）。登录不存在后
            改成无条件渲染的同步状态卡——但旧注释声称「判据从登录态换成
            有没有云盘配置」，代码里却根本没有那个检查，只有一颗写死的绿点
            （Wave 2B 缺陷 1）。现在状态来自 getLastBackendResolution()：
            已配置并解锁 / 未解锁 / 未配置 / 状态不可读四态可辨，未就绪时
            提供「去设置」入口；上次同步时间来自 storage.getLastSyncTime()，
            由 syncEngine 的成功路径写入（缺陷 2）。
            ⚠️ 不能删掉整个块：那会让刷新入口与上次同步时间一并消失，
            而两者都在 2026-09-26 误操作事故后被当作必要反馈保留过。 */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">同步</p>
            <button
              onClick={handleQuickRefresh}
              disabled={isRefreshing}
              aria-label={isRefreshing ? '正在从云盘刷新' : '从云盘刷新数据'}
              className="p-1.5 rounded-full flat-interaction transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              title={isRefreshing ? '正在从云盘刷新…' : '从云盘刷新数据'}
            >
              {/* 进行中的可视信号：转圈。只 disabled 不转，用户仍看不出「在动」 */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className={`h-4 w-4 text-primary-600 dark:text-primary-400${isRefreshing ? ' animate-spin' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p
              className="min-w-0 text-xs text-gray-500 dark:text-gray-400 flex items-center"
              title={backendStatus.lockedReason ?? BACKEND_STATUS_TITLE[backendStatus.kind]}
            >
              <span
                className={`inline-block w-2 h-2 rounded-full mr-1 shrink-0 ${BACKEND_STATUS_DOT_CLASS[backendStatus.tone]}`}
              ></span>
              <span className="truncate">自带存储 · {backendStatus.label}</span>
            </p>
            {backendStatus.actionable && (
              <button
                type="button"
                onClick={handleOpenOptions}
                className="shrink-0 text-xs font-medium text-primary-600 underline hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
              >
                去设置
              </button>
            )}
          </div>
          {lastSyncLabel && lastSyncTitle && (
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500" title={lastSyncTitle}>
              上次成功同步 · {lastSyncLabel}
            </p>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 my-1.5"></div>

        {/* ── 窄屏补偿入口（2026-10-14）──────────────────────────────────
            390px 实测：顶栏塞不下「布局切换 + 清理重复 + 主题 + 同步 + 保存 + 菜单」，
            搜索框被压到 0 宽而整框消失。Header 因此在窄屏把前两个低频操作
            收进本菜单 —— 但不能就此让它们在窄屏**消失**（那是「窄屏少个功能」）。
            这里补回两个入口，sm 以上与顶栏按钮重复，故对 sm+ 隐藏。 */}
        <div className="sm:hidden">
          <button
            onClick={() => {
              onToggleLayout?.();
              onClose();
            }}
            className={MENU_ROW}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
              {settings.layoutMode === 'single' && (
                <path d="M12 5.25v13.5" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
            {settings.layoutMode === 'single' ? '切换为双栏布局' : '切换为单栏布局'}
          </button>

          <button
            onClick={() => {
              onRequestCleanDuplicates?.();
              onClose();
            }}
            className={MENU_ROW}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            清理重复标签
          </button>
        </div>

        {/* ── 2026-10-14：设置全部搬进独立选项页，菜单只留入口 ──────────────
            搬走的原因不是「菜单太挤」，而是菜单**放不下也托不住**这类设置：
            宽度只有 256px（w-64），而 WebDAV 面板有 6 个输入框 + 加密单选组 +
            4 个按钮；且菜单是瞬态的（点别处即消失），而填地址/账号/应用密码/
            加密口令全是要回看斟酌的长文本。在 256px 的瞬态下拉里滚表单，
            按钮行要横向滚动才看得全 —— 这不是能靠调样式救回来的问题。
            现在：菜单一行「设置…」→ chrome.runtime.openOptionsPage()。
            2026-10-16：删掉「登录 / 注册」与「退出登录」两行（账号体系已删除）。
            保留在菜单里的只有非账号项：设置、导出/导入、布局切换、
            清理重复、删除全部。 */}
        <button
          onClick={handleOpenOptions}
          className={MENU_ROW}
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          设置…
        </button>

        <div className="relative">
          <button
            onClick={() => setOpenSubmenu(current => current === 'export' ? null : 'export')}
            className={MENU_ROW + ' justify-between'}
            aria-expanded={openSubmenu === 'export'}
            aria-haspopup="menu"
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              导出数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {openSubmenu === 'export' && (
            <div className="ts-panel absolute left-full top-0 ml-1 w-48 rounded-lg border theme-border-default theme-bg-elevated shadow-lg">
            <button
              onClick={handleExportData}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
            </button>
            <button
              onClick={handleExportOneTabFormat}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
            </button>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setOpenSubmenu(current => current === 'import' ? null : 'import')}
            className={MENU_ROW + ' justify-between'}
            aria-expanded={openSubmenu === 'import'}
            aria-haspopup="menu"
            type="button"
          >
            <div className="flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              导入数据
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {openSubmenu === 'import' && (
            <div className="ts-panel absolute left-full top-0 ml-1 w-48 rounded-lg border theme-border-default theme-bg-elevated shadow-lg">
            <label
              className={MENU_ROW + ' cursor-pointer'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              JSON 格式
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const data = JSON.parse(event.target?.result as string);
                        const result = await storage.importDetailed(data);
                        e.target.value = '';
                        if (result.ok) {
                          // ── 2026-10-09 P1-6：导入结果必须报数量 ──────────
                          // 原先「成功不弹提示（Unix 哲学）」直接 reload ——
                          // 用户无从知道导入了几个、跳过几个。跳过的组会静默
                          // 消失，他还以为全都在，要等自己回文件里核对才发现。
                          //
                          // 为什么不再 reload：reload 会把 toast/alert 一起刷掉，
                          // 报了数量等于没报。loadGroups thunk 内部已有
                          // invalidateGroupsCache()，够拿到导入后的新列表。
                          if (result.pending) {
                            showAlert({
                              title: '正在导入',
                              message: `文件较大，导入仍在后台继续，稍后列表会自行更新（文件内共 ${result.source} 个会话）`,
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else if (result.imported < result.source) {
                            showAlert({
                              title: '部分导入完成',
                              message:
                                `文件内共 ${result.source} 个会话，成功导入 ${result.imported} 个；` +
                                `其余 ${result.source - result.imported} 个为空会话或只含无法保存的网址，已被跳过。` +
                                '请回备份文件里核对这几项。',
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else {
                            showToast(`已导入 ${result.imported} 个会话`, 'success');
                          }
                          // 只刷新列表，不 reload 整页：提示能完整显示完
                          dispatch(loadGroups());
                        } else {
                          // 2026-10-10 P2-3：与 OneTab 分支（下方）对齐 —— 那边用
                          // importResult.reason，这里原先是静态的「数据导入失败」，
                          // 把三种完全不同的原因（格式不对 / 组全不可存储 / 写盘失败）
                          // 压成同一句，用户无从判断该重选文件还是该等一等。
                          // reason 由 storage.importDetailed 提供（可选字段）。
                          showAlert({
                            title: '导入失败',
                            message:
                              result.reason ??
                              `数据导入失败${result.source > 0 ? `（文件内共 ${result.source} 个会话，本次一个都没落盘）` : ''}`,
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        logError('解析导入文件失败:', error);
                        e.target.value = '';
                        showAlert({
                          title: '导入失败',
                          message: '解析导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </label>
            <label
              className={MENU_ROW + ' cursor-pointer'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              OneTab 格式
              <input
                type="file"
                accept=".txt"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                      try {
                        const text = event.target?.result as string;
                        const importResult = await storage.importFromOneTabFormat(text);
                        e.target.value = '';
                        if (importResult.ok) {
                          // ── 2026-10-09 P1-6：与 JSON 导入同口径报数量 ──
                          // 原先「成功不弹提示」直接 reload，用户不知道导入了几个、
                          // 跳过几个；reload 还会把提示一起刷掉。改 dispatch(loadGroups)。
                          const total = importResult.source ?? text.split('\n\n').filter(Boolean).length;
                          const done = importResult.imported ?? 0;
                          if (importResult.pending) {
                            showAlert({
                              title: '正在导入',
                              message: `文件较大，导入仍在后台继续，稍后列表会自行更新（文件内共 ${total} 个会话）`,
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else if (done < total) {
                            showAlert({
                              title: '部分导入完成',
                              message:
                                `文件内共 ${total} 个会话，成功导入 ${done} 个；其余 ${total - done} 个` +
                                '为空会话或只含无法保存的网址，已被跳过。请回原文件里核对。',
                              type: 'warning',
                              onClose: () => {},
                            });
                          } else {
                            showToast(`已导入 ${done} 个会话`, 'success');
                          }
                          dispatch(loadGroups());
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: importResult.reason ?? 'OneTab 数据导入失败',
                            type: 'error',
                            onClose: () => { }
                          });
                        }
                      } catch (error) {
                        logError('解析 OneTab 导入文件失败:', error);
                        e.target.value = '';
                        showAlert({
                          title: '导入失败',
                          message: '解析 OneTab 导入文件失败，请确保文件格式正确',
                          type: 'error',
                          onClose: () => { }
                        });
                      }
                      onClose();
                    };
                    reader.readAsText(file);
                  }
                }}
              />
            </label>
            </div>
          )}
        </div>

        {/* 危险区：与菜单平面语言一致（rounded-lg + 留边），用色块与普通项区分防误触。
            核弹级操作：强制确认不受「删除会话前确认」开关控制；无组时隐藏；描述带数量。 */}
        {groups.length > 0 && (
          <div className="px-2 pt-1.5 pb-0.5">
            <button
              onClick={handleDeleteAllGroups}
              className="flex w-full items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-left text-sm font-medium text-rose-700 transition-colors hover:bg-rose-100 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span className="flex-1">
                <span className="block">删除所有会话（{groups.length}）</span>
                <span className="mt-0.5 block text-xs font-normal text-rose-600/80 dark:text-rose-300/80">
                  将清空本地全部会话，删除后无法恢复（其他设备下次同步时也会删除）。
                </span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
