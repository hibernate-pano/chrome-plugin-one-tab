import React from 'react';
import { useAppSelector } from '@/store/hooks';
import { syncService } from '@/services/syncService';
import { cn } from '@/lib/utils';
import { formatLastSync } from '@/utils/sessionPresentation';

/**
 * Compact "sync status + manual refresh" row used inside SyncTab.
 * Replaces the busy-state header on the old `SyncButton`.
 */
export const SyncStatusRow: React.FC = () => {
  const status = useAppSelector(s => s.tabs.syncStatus);
  const lastSyncAt = useAppSelector(s => s.tabs.lastSyncTime);
  const isBusy = status === 'syncing';

  const dotClass = cn(
    'inline-block h-2 w-2 rounded-full',
    status === 'error' && 'bg-rose-500',
    status === 'syncing' && 'bg-amber-500 animate-pulse',
    (status === 'idle' || status === 'success') && 'bg-emerald-500'
  );

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={dotClass} aria-hidden="true" />
      <span className="text-gray-700 dark:text-gray-300">
        {formatLastSync(lastSyncAt)}
      </span>
      <button
        onClick={() => {
          if (isBusy) return;
          // 合并模式拉取云端最新会话
          void syncService.downloadAndRefresh(false);
        }}
        disabled={isBusy}
        className={cn(
          'ml-auto inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium flat-interaction',
          isBusy
            ? 'cursor-not-allowed bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
            : 'bg-primary-600 text-white hover:bg-primary-700'
        )}
      >
        {isBusy ? '同步中…' : '立即同步'}
      </button>
    </div>
  );
};

export default SyncStatusRow;
