import React, { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { cleanDuplicateTabs } from '@/store/slices/tabSlice';
import { syncService } from '@/services/syncService';
import { useToast } from '@/contexts/ToastContext';
import { cn } from '@/lib/utils';

interface SyncStatusInlineProps {
  /** 由 Header 透传，点击 popover 里的「打开设置 → 同步」时调用。 */
  onOpenSettings?: () => void;
}

/**
 * F10: Header 级别的同步快捷入口（仅登录可见）。
 *
 * 设计：
 *   - 拆分按钮：左 = 立即同步（合并模式 = downloadAndRefresh(false)），
 *     右 = 倒三角，点击展开 popover 容纳「上传到云端 / 下载（覆盖本地） /
 *     删除重复标签 / 打开设置 → 同步」四个动作。
 *   - 直接通过 useAppSelector 读 auth + sync 状态，未登录 return null，
 *     Header 不需要为此新增 prop 表面。
 *   - busy 用单一 useState 锁住所有 popover 动作；点任意动作都先关
 *     popover，避免与外部点击关闭竞争。
 *   - popover 关闭：outside mousedown + Escape（与既有组件的常规约定一致）。
 */
export const SyncStatusInline: React.FC<SyncStatusInlineProps> = ({ onOpenSettings }) => {
  const isAuthenticated = useAppSelector(state => state.auth.isAuthenticated);
  const syncStatus = useAppSelector(state => state.tabs.syncStatus);
  const dispatch = useAppDispatch();
  const { showAlert } = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!isAuthenticated) return null;

  const dotClass = cn(
    'inline-block h-2 w-2 rounded-full shrink-0',
    syncStatus === 'error' && 'bg-rose-500',
    syncStatus === 'syncing' && 'bg-amber-500 animate-pulse',
    (syncStatus === 'idle' || syncStatus === 'success') && 'bg-emerald-500'
  );

  const handleSync = async () => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      await syncService.downloadAndRefresh(false);
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      await syncService.uploadToCloud(false, true);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadOverwrite = async () => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      await syncService.downloadAndRefresh(true);
    } finally {
      setBusy(false);
    }
  };

  // 与 F9 ImportExportTab 的 handleCleanDuplicates 同款：dispatch thunk + showAlert
  // 反馈。cleaning 状态独立于 sync busy，因为清理只是本地数据操作，不阻塞
  // 上传 / 下载。
  const handleCleanDuplicates = async () => {
    if (cleaning) return;
    setOpen(false);
    setCleaning(true);
    try {
      const result = await dispatch(cleanDuplicateTabs()).unwrap();
      showAlert({
        title: '清理完成',
        message: `已移除 ${result.removedTabsCount} 个重复标签页`,
        type: 'success',
        onClose: () => {},
      });
    } catch (e: any) {
      showAlert({
        title: '清理失败',
        message: e?.message || '请重试',
        type: 'error',
        onClose: () => {},
      });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div ref={popoverRef} className="relative flex items-center">
      <button
        type="button"
        onClick={handleSync}
        disabled={busy}
        title="立即同步"
        aria-label="立即同步"
        className={cn(
          'inline-flex items-center gap-1 px-2 py-2 rounded-l-md text-xs font-medium flat-interaction',
          'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'bg-primary-600 text-white hover:bg-primary-700'
        )}
      >
        <span className={cn(dotClass, 'bg-opacity-80')} aria-hidden="true" />
        <span className="hidden sm:inline">{busy ? '同步中' : '同步'}</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多同步操作"
        className={cn(
          'inline-flex items-center px-1.5 py-2 rounded-r-md text-xs font-medium flat-interaction',
          'focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
          'bg-primary-700 text-white hover:bg-primary-800'
        )}
      >
        <svg
          className="w-3 h-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="同步操作"
          className={cn(
            'absolute right-0 top-full mt-1 w-48 rounded-lg border border-gray-200 bg-white',
            'dark:border-gray-700 dark:bg-gray-800 shadow-lg z-30 p-1'
          )}
        >
          <button
            type="button"
            onClick={handleUpload}
            disabled={busy}
            role="menuitem"
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs rounded-md flat-interaction',
              'hover:bg-gray-100 dark:hover:bg-gray-700',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            上传到云端
          </button>
          <button
            type="button"
            onClick={handleDownloadOverwrite}
            disabled={busy}
            role="menuitem"
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs rounded-md flat-interaction',
              'hover:bg-gray-100 dark:hover:bg-gray-700',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            下载（覆盖本地）
          </button>
          <button
            type="button"
            onClick={handleCleanDuplicates}
            disabled={cleaning}
            role="menuitem"
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs rounded-md flat-interaction',
              'hover:bg-gray-100 dark:hover:bg-gray-700',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            {cleaning ? '清理中…' : '删除重复标签'}
          </button>
          <hr className="my-1 border-gray-100 dark:border-gray-700" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings?.();
            }}
            role="menuitem"
            className={cn(
              'w-full text-left px-3 py-1.5 text-xs rounded-md flat-interaction',
              'hover:bg-gray-100 dark:hover:bg-gray-700',
              'text-gray-500 dark:text-gray-400'
            )}
          >
            打开设置 → 同步…
          </button>
        </div>
      )}
    </div>
  );
};

export default SyncStatusInline;
