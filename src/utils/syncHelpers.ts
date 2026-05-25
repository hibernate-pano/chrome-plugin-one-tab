import { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit';
import { syncTabsToCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud } from '@/store/slices/settingsSlice';

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_DELAY = 2000;

const OPERATION_PRIORITIES: Record<string, number> = {
  '删除标签组': 10,
  '删除所有标签组': 10,
  '新标签组': 8,
  '导入标签组': 8,
  '更新标签组': 5,
  '标签组名称更新': 5,
  '标签组锁定状态更新': 3,
  '标签组顺序更新': 3,
  '标签页移动': 2,
  '本地更改': 1,
};

let currentSyncOperation: { type: string; priority: number } | null = null;
let pendingSync = false;

export async function syncToCloud<T>(
  dispatch: ThunkDispatch<T, any, UnknownAction>,
  getState: () => any,
  operationType: string
): Promise<boolean> {
  const priority = OPERATION_PRIORITIES[operationType] || 1;

  return new Promise(resolve => {
    if (currentSyncOperation && syncDebounceTimer) {
      if (priority > currentSyncOperation.priority) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      } else {
        resolve(true);
        return;
      }
    }

    currentSyncOperation = { type: operationType, priority };
    pendingSync = true;

    syncDebounceTimer = setTimeout(async () => {
      try {
        const state = getState();
        const isAuthenticated = state.auth?.isAuthenticated || false;

        if (!isAuthenticated) {
          currentSyncOperation = null;
          pendingSync = false;
          resolve(true);
          return;
        }

        await dispatch(syncTabsToCloud({ background: true, overwriteCloud: false }) as any);
        await dispatch(syncSettingsToCloud() as any);

        currentSyncOperation = null;
        pendingSync = false;
        resolve(true);
      } catch (e) {
        console.error('[AutoSync] 同步失败，将在下次操作时重试:', e);
        currentSyncOperation = null;
        pendingSync = false;
        resolve(false);
      }
    }, priority >= 8 ? 500 : SYNC_DEBOUNCE_DELAY);
  });
}

export function hasPendingSync(): boolean {
  return pendingSync;
}

export function cancelPendingSync(): void {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  currentSyncOperation = null;
  pendingSync = false;
}
