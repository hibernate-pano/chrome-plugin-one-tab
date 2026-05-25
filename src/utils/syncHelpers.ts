import type { AnyAction, ThunkDispatch } from '@reduxjs/toolkit';

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSync = false;

/**
 * 调度自动云同步（带优先级防抖）
 * 高优先级操作（删除/新建）500ms 后触发，低优先级 2000ms 后触发。
 * 如果在等待期间有更高优先级的操作到来，取消当前计时器以新操作为准。
 */
export function scheduleAutoSync(
  dispatch: ThunkDispatch<any, any, AnyAction>,
  priority: number
): void {
  if (syncTimer) {
    if (priority <= (syncTimer as any).__priority || 0) return;
    clearTimeout(syncTimer);
  }

  pendingSync = true;
  // 将 priority 附在 timer 上以便后续比较
  (syncTimer as any) = setTimeout(async () => {
    try {
      const { syncTabsToCloud } = await import('@/store/slices/tabSlice');
      const { syncSettingsToCloud } = await import('@/store/slices/settingsSlice');
      await dispatch(syncTabsToCloud({ background: true, overwriteCloud: false }) as any);
      await dispatch(syncSettingsToCloud() as any);
    } catch (e) {
      console.error('[AutoSync] 自动同步失败:', e);
    } finally {
      syncTimer = null;
      pendingSync = false;
    }
  }, priority >= 8 ? 500 : 2000);
}

export function hasPendingSync(): boolean {
  return pendingSync;
}

export function cancelPendingSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingSync = false;
}
