import { authCache } from '@/utils/authCache';
import { storage } from '@/utils/storage';
import { SyncEngine } from '@/services/syncEngine';

/**
 * 后台自动同步（P0）
 *
 * Service Worker 每 15 分钟通过 chrome.alarms 触发一次「拉取并合并」云端数据。
 * 设计约束（spec 2026-08-09-background-auto-sync-design.md §B3）：
 * - 只下载 + 合并，不上传（上传保持 autoSyncMiddleware 响应式）。
 * - 不依赖 Redux store：登录态走 authCache，settings 走 storage.getSettings()。
 * - 复用 SyncEngine（快照 → 下载 → 合并 → 验证 → 写入 → 回滚），不改其逻辑。
 * - 失败静默写 lastSyncStatus.lastSyncError（不弹通知），popup 打开时可见。
 */
export const BACKGROUND_SYNC_ALARM = 'tabstack-background-sync';
export const BACKGROUND_SYNC_PERIOD_MINUTES = 15;

/** 幂等创建 15 分钟周期 alarm（同名 create 自动替换）。 */
export function ensureBackgroundSyncAlarm(): void {
  chrome.alarms.create(BACKGROUND_SYNC_ALARM, {
    periodInMinutes: BACKGROUND_SYNC_PERIOD_MINUTES,
  });
}

/**
 * onAlarm 入口：未登录静默跳过；已登录则用 SW 本地依赖构造 SyncEngine 并拉取合并。
 * 不抛错（任何异常都被 engine 内部捕获并写入 lastSyncError）。
 */
export async function handleBackgroundSyncAlarm(): Promise<void> {
  try {
    const cachedAuth = await authCache.getAuthState();
    if (!cachedAuth?.isAuthenticated) {
      console.log('[BackgroundSync] 未登录，跳过后台同步');
      return;
    }

    const settings = await storage.getSettings();
    const engine = new SyncEngine({
      getState: () => ({
        auth: { isAuthenticated: true, user: cachedAuth.user } as any,
        settings: { syncStrategy: settings.syncStrategy ?? 'newest' } as any,
        tabs: undefined as any,
      }),
    });

    const result = await engine.downloadAndMerge();
    console.log(
      `[BackgroundSync] ${result.success ? '同步成功' : '同步失败'}: ` +
        `本地 ${result.stats?.localCount ?? 0} / 云端 ${result.stats?.cloudCount ?? 0} / ` +
        `合并 ${result.stats?.mergedCount ?? 0} 个组` +
        (result.reason ? ` (${result.reason})` : '')
    );
  } catch (error) {
    // engine 内部已写 lastSyncError；这里兜底记录，避免 SW 崩溃。
    console.error('[BackgroundSync] 后台同步异常:', error);
  }
}
