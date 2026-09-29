import React, { useState, useRef, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { signOut } from '@/store/slices/authSlice';
import { deleteAllGroups, loadGroups } from '@/store/slices/tabSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { storage } from '@/utils/storage';
import { LoginForm } from '../auth/LoginForm';
import { RegisterForm } from '../auth/RegisterForm';
import { useToast } from '@/contexts/ToastContext';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';
import { 
  toggleShowNotifications, 
  toggleConfirmBeforeDelete,
  toggleCollectPinnedTabs,
  saveSettings 
} from '@/store/slices/settingsSlice';
import { ThemeStyleSelector } from './ThemeStyleSelector';
import { trackProductEvent } from '@/utils/productEvents';
import {
  collectDiagnostics,
  diagnosticsFileName,
  diagnosticsSummaryText,
  serializeDiagnosticsReport,
} from '@/utils/diagnostics';
import { logError, logInfo, logWarn } from '../../utils/log';

/** 问题反馈落点：GitHub issues 新建页。用户自己决定粘不粘诊断摘要。 */
const FEEDBACK_ISSUE_URL = 'https://github.com/hibernate-pano/chrome-plugin-one-tab/issues/new';

/**
 * 复制文本到剪贴板，两级降级，返回是否真的写进去了。
 *
 * 为什么不静默：用户点了「问题反馈」却在 issue 里发现没有摘要，只能自己去翻
 * 扩展目录找文件——那等于这个功能没做。所以失败必须让用户看见，且要给他一条
 * 还能拿到内容的路（把摘要原文摆在弹窗里，手动复制）。
 * 第一级用 Clipboard API；它在非安全上下文或权限被拒时抛错，此时退回
 * execCommand（老但可用），再失败就交给调用方弹窗。
 */
const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    logWarn('Clipboard API 写入失败，降级到 execCommand:', error);
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (error) {
    logError('剪贴板降级路径也失败:', error);
    return false;
  }
};

interface HeaderDropdownProps {
  onClose: () => void;
}

/** 菜单行的统一 hover 反馈。菜单行不做位移（flat-interaction 的 -translate-y 会轻微跳动），只做背景色。 */
const MENU_ROW = "w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 flex items-center transition-colors duration-150 hover:bg-gray-50 dark:hover:bg-gray-700/50";

/** 菜单内的开关行：整行可点，toggle 只做状态显示 */
const DropdownToggleRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onToggle: () => void;
}> = ({ icon, label, checked, onToggle }) => (
  <button
    onClick={onToggle}
    className={MENU_ROW + ' justify-between'}
    role="switch"
    aria-checked={checked}
    type="button"
  >
    <span className="flex items-center">
      {icon}
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
    </span>
    <span
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </span>
  </button>
);

export const HeaderDropdown: React.FC<HeaderDropdownProps> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const { isAuthenticated, user } = useAppSelector(state => state.auth);
  const { groups, lastSyncTime } = useAppSelector(state => state.tabs);
  const settings = useAppSelector(state => state.settings);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<'export' | 'import' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const authModalRef = useRef<HTMLDivElement>(null);
  const { showConfirm, showAlert, showToast } = useToast();

  // 账号弹窗的键盘与焦点契约：打开移焦、Tab 循环、Escape 关闭、关闭还焦。
  // 不接管 Escape 的话，按键会被 Header 的全局 CLEAR_SEARCH 快捷键吃掉，
  // 弹窗关不掉，反而把背后的搜索框清空。
  useDialogA11y(authModalRef, showAuthModal, () => setShowAuthModal(false));

  // 处理通知开关
  const handleToggleNotifications = async () => {
    dispatch(toggleShowNotifications());
    // toggleShowNotifications 已经更新了 Redux state，现在保存到存储
    await dispatch(saveSettings() as any);
  };

  // 处理删除确认开关
  const handleToggleConfirmDelete = async () => {
    dispatch(toggleConfirmBeforeDelete());
    // toggleConfirmBeforeDelete 已经更新了 Redux state，现在保存到存储
    await dispatch(saveSettings() as any);
  };

  // 处理“收集固定页”开关
  const handleToggleCollectPinnedTabs = async () => {
    dispatch(toggleCollectPinnedTabs());
    await new Promise(resolve => setTimeout(resolve, 0));
    await dispatch(saveSettings() as any);
  };

  // 处理快速刷新（从云端下载并合并）
  const handleQuickRefresh = async () => {
    if (!isAuthenticated) {
      showAlert({
        title: '未登录',
        message: '请先登录以使用同步功能',
        type: 'warning',
        onClose: () => {}
      });
      return;
    }

    try {
      const res = await sendSyncCommand('download', {
        forceRemote: false,
        syncSettings: false,
      });

      if (res.ok) {
        try {
          await dispatch(loadGroups()).unwrap();
        } catch (err) {
          logWarn('同步后刷新本地会话失败:', err);
        }
      } else {
        showAlert({
          title: '手动同步失败',
          message: res.error === 'not_authenticated' ? '未登录' : (res.error || '无法从云端拉取数据'),
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
    }
  };

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

  const handleSignOut = () => {
    // 先关闭下拉菜单，提高用户体验
    onClose();

    // 异步登出，不阻塞用户界面
    dispatch(signOut())
      .then(() => {
        logInfo('登出成功');
      })
      .catch(error => {
        logError('登出失败:', error);
      });
  };

  // 移除同步功能，简化逻辑

  // 处理删除所有标签组。核弹级操作：不受「删除前确认」开关控制，永远弹确认
  // （该开关只应管单组删除；关闭后一键删光全部曾造成误操作事故 2026-09-26）。
  // 无墓碑模型（2026-09-29）：删除即物理移除，跨设备广播由云端 is_deleted 行承担。
  const handleDeleteAllGroups = () => {
    if (groups.length === 0) return;

    const runDeleteAll = () => {
      onClose();

      dispatch(deleteAllGroups())
        .then(() => {
          if (isAuthenticated) {
            sendSyncCommand('upload', {
              overwriteCloud: true,
              syncSettings: true,
            })
              .then(raw => {
                const res = raw as { ok: boolean; error?: string; payload?: { skippedOverwrite?: string } };
                // 「删光本机全部会话」之后本地没有活跃组 → uploadTabGroups 的
                // 空本地保护必然跳过 overwriteCloud（宁可不清空云端）。也就是说
                // 这条命令的覆盖上传几乎总是被跳过，此前无条件打印
                // 「删除操作已同步到云端」是在对没发生的事报成功。
                // 只有 res.ok 且 payload 里没有 skippedOverwrite，才算真的覆盖了云端。
                if (!res.ok) {
                  logError('删除操作同步到云端失败:', res.error);
                  showAlert({
                    title: '同步失败',
                    message: `本机会话已删除，但云端同步失败：${res.error || '未知错误'}`,
                    type: 'error',
                    onClose: () => {}
                  });
                  return;
                }
                if (res.payload?.skippedOverwrite) {
                  // 删光后本地无活跃组 → 覆盖被跳过是预期路径；删除意图已由
                  // upload 内的 markCloudGroupsAsDeleted（pendingDeleteIds 队列）
                  // 广播到云端，无需报警。
                  logInfo('[HeaderDropdown] 覆盖上传被跳过（本地无活跃组），删除意图已按队列广播:', res.payload.skippedOverwrite);
                  return;
                }
                logInfo('删除操作已同步到云端');
              })
              .catch(error => {
                logError('同步到云端失败:', error);
              });
          } else {
            logInfo('用户未登录，跳过同步到云端');
          }
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
      message: `将删除本地全部 ${groups.length} 个会话，删除后无法恢复${isAuthenticated ? '，其他登录设备将同步删除' : ''}。确认继续吗？`,
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

  // 导出脱敏诊断信息（B1）。只传登录态布尔值：user 对象里有邮箱与 id，
  // 诊断文件里不允许出现任何一个（见 src/utils/diagnostics.ts 的白名单说明）。
  const handleExportDiagnostics = async () => {
    try {
      setOpenSubmenu(null);
      // 载荷与文件名共用同一个 Date：跨零点时两者才对得上（见 exportStamp.ts）。
      const now = new Date();
      const report = await collectDiagnostics({ isAuthenticated, now });
      const blob = new Blob([serializeDiagnosticsReport(report)], {
        type: 'application/json'
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = diagnosticsFileName(report.environment.extensionVersion, now);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (error) {
      logError('导出诊断信息失败:', error);
      showAlert({
        title: '导出失败',
        message: '收集诊断信息失败，请重试；若反复失败请到「问题反馈」里说明',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  // 问题反馈（B2）：打开 GitHub issues 新建页，并把脱敏摘要放进剪贴板。
  // 先开页面再收集：window.open 必须落在用户手势的同步路径里，等 await 之后再开
  // 可能被弹窗拦截；而收集失败也不该把用户已经打开的反馈页关掉。
  const handleReportIssue = async () => {
    onClose();
    window.open(FEEDBACK_ISSUE_URL, '_blank', 'noopener,noreferrer');
    try {
      const report = await collectDiagnostics({ isAuthenticated });
      const summary = diagnosticsSummaryText(report);
      if (await copyTextToClipboard(summary)) {
        showToast('诊断摘要已复制，请在 issue 正文里粘贴', 'success');
      } else {
        // 复制不了就把原文摆出来让用户手动拿，不静默吞掉
        showAlert({
          title: '诊断摘要未复制',
          message: `浏览器拒绝了剪贴板写入，请手动复制以下内容：\n\n${summary}`,
          type: 'warning',
          onClose: () => { }
        });
      }
    } catch (error) {
      logError('生成诊断摘要失败:', error);
      showAlert({
        title: '诊断摘要生成失败',
        message: '已为你打开反馈页，但收集诊断信息失败，请在 issue 里补充复现步骤',
        type: 'error',
        onClose: () => { }
      });
    }
  };

  return (
    <div ref={dropdownRef} className="absolute right-0 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-20">
      <div className="py-2">
        {isAuthenticated && user && (
          <>
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.email}</p>
                <button
                  onClick={handleQuickRefresh}
                  className="p-1.5 rounded-full flat-interaction transition-colors"
                  title="从云端刷新数据"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-primary-600 dark:text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                    已登录
                  </p>
                {lastSyncTime && (
                  <p className="text-xs text-gray-400 dark:text-gray-500" title={`最后手动同步: ${new Date(lastSyncTime).toLocaleString()}`}>
                    {(() => {
                      const now = new Date();
                      const syncDate = new Date(lastSyncTime);
                      const diffMs = now.getTime() - syncDate.getTime();
                      const diffMins = Math.floor(diffMs / 60000);
                      
                      if (diffMins < 1) return '刚刚同步';
                      if (diffMins < 60) return `${diffMins}分钟前`;
                      const diffHours = Math.floor(diffMins / 60);
                      if (diffHours < 24) return `${diffHours}小时前`;
                      const diffDays = Math.floor(diffHours / 24);
                      return `${diffDays}天前`;
                    })()}
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        {!isAuthenticated && (
          <button
            onClick={() => setShowAuthModal(true)}
            className={MENU_ROW}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
            登录 / 注册
          </button>
        )}

        <div className="border-t border-gray-200 dark:border-gray-700 my-1.5"></div>

        {/* 设置区：一层节标题 + 三行开关（行本身自解释，不再分「通用/标签页」小标题） */}
        <div className="px-4 pt-1.5 pb-1">
          <p className="text-xs font-medium text-gray-400 dark:text-gray-500">设置</p>
        </div>

        <DropdownToggleRow
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          }
          label="通知提醒"
          checked={settings.showNotifications}
          onToggle={handleToggleNotifications}
        />

        <DropdownToggleRow
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          }
          label="删除前确认"
          checked={settings.confirmBeforeDelete}
          onToggle={handleToggleConfirmDelete}
        />

        <DropdownToggleRow
          icon={
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3M5 11h14M5 19h14" />
            </svg>
          }
          label="保存固定标签页"
          checked={settings.collectPinnedTabs}
          onToggle={handleToggleCollectPinnedTabs}
        />

        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

        {/* 主题风格选择 */}
        <ThemeStyleSelector />

        <div className="border-t border-gray-200 dark:border-gray-700 my-1.5"></div>

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
            <div className="absolute left-full top-0 ml-1 w-48 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
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
            {/* 诊断信息：同样是一次导出，但内容是脱敏后的规模与环境快照
                （不含任何标签 URL、标题、会话名），用于反馈问题时贴 issue。 */}
            <button
              onClick={handleExportDiagnostics}
              className={MENU_ROW}
              type="button"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 12h16.5m-16.5 0a3 3 0 013-3m13.5 0a3 3 0 013 3m-16.5 0a3 3 0 003 3m13.5 0a3 3 0 003-3m-16.5 0a9 9 0 0118 0m-18 0a9 9 0 018 9m-8-9a9 9 0 00-8 9m0-9v9m18-9v9" />
              </svg>
              诊断信息
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
            <div className="absolute left-full top-0 ml-1 w-48 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
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
                        const success = await storage.importData(data);
                        e.target.value = '';
                        if (success) {
                          // 成功不弹提示（Unix 哲学）：直接刷新展示导入结果
                          window.location.reload();
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: '数据导入失败',
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
                        const success = await storage.importFromOneTabFormat(text);
                        e.target.value = '';
                        if (success) {
                          void trackProductEvent('onetab_import_completed', {
                            importSource: 'onetab',
                            importedSessions: text.split('\n\n').filter(Boolean).length,
                          });
                          // 成功不弹提示（Unix 哲学）：直接刷新展示导入结果
                          window.location.reload();
                        } else {
                          showAlert({
                            title: '导入失败',
                            message: 'OneTab 数据导入失败',
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

        {/* 问题反馈：与导出/导入同一层的普通菜单行（真 button + 可见文字，
            读屏有名字；不是图标按钮，所以不需要 aria-label）。 */}
        <button
          onClick={handleReportIssue}
          className={MENU_ROW}
          type="button"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          问题反馈
        </button>

        {/* 危险区：与菜单平面语言一致（rounded-lg + 留边），用色块与普通项区分防误触。
            核弹级操作：强制确认不受「删除前确认」开关控制；无组时隐藏；描述带数量。 */}
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
                  将清空本地全部会话，删除后无法恢复（其他登录设备同步删除）。
                </span>
              </span>
            </button>
          </div>
        )}

        {isAuthenticated && (
          <>
            <div className="border-t border-gray-200 dark:border-gray-700 my-1.5"></div>
            <button
              onClick={handleSignOut}
              className={MENU_ROW}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              退出登录
            </button>
          </>
        )}
      </div>

      {showAuthModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div
            ref={authModalRef}
            role="dialog"
            aria-modal="true"
            aria-label="登录或注册账号"
            tabIndex={-1}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 focus:outline-none"
          >
            <div className="flex border-b border-gray-300 dark:border-gray-700">
              <button
                type="button"
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'login' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'register' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('register')}
              >
                注册
              </button>
              <button
                type="button"
                className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
                onClick={() => setShowAuthModal(false)}
                aria-label="关闭登录弹窗"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              {activeTab === 'login' ? (
                <LoginForm onSuccess={() => {
                  setShowAuthModal(false);
                  onClose();
                }} />
              ) : (
                <RegisterForm onSuccess={() => {
                  setShowAuthModal(false);
                  onClose();
                }} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
