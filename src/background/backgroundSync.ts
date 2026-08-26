import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';
import { loadSettings } from '@/store/slices/settingsSlice';
import { syncEngine } from '@/services/syncEngine';

/**
 * 后台定时同步（chrome.alarms 驱动，Service Worker 常驻时每 60s 触发）。
 *
 * 目的：B 设备扩展开着但未打开 popup 时，也能定期从云端拉取 A 设备的变更，
 * 写入本地 storage；用户随后打开 popup 时数据已是最新（popup 首屏 loadGroups
 * 直接读到后台下载好的结果），无需等待手动同步。
 *
 * 设计约束（MV3）：
 * - Service Worker 是事件驱动、可随时被系统杀掉；alarms 触发会重新唤醒 SW。
 * - SW 无 localStorage；supabase 客户端已改用 chrome.storage.local 持久化 session
 *   （见 src/utils/supabase.ts），因此这里能安全恢复登录态。
 * - 每次唤醒都是全新执行上下文，store 也是新实例——先 getCurrentUser 注入登录态，
 *   再走 SyncEngine 下载合并（快照→下载→合并→验证→写入，失败自动回滚）。
 */

const SYNC_ALARM = 'tapstack-background-sync';
const SYNC_INTERVAL_MINUTES = 1; // 60s

/** 注册后台同步 alarm。在 service-worker 启动时调用一次。 */
export function setupBackgroundSync(): void {
  chrome.alarms.create(SYNC_ALARM, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
  chrome.alarms.onAlarm.addListener(handleAlarm);
  console.log(`[BackgroundSync] 已注册后台同步 alarm（每 ${SYNC_INTERVAL_MINUTES} 分钟）`);
}

/** 供手动触发一次（测试/调试） */
export async function runBackgroundSyncOnce(): Promise<boolean> {
  return performBackgroundSync();
}

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== SYNC_ALARM) return;
  try {
    await performBackgroundSync();
  } catch (err) {
    console.error('[BackgroundSync] 后台同步异常:', err);
  }
}

/**
 * 执行一次后台同步：恢复登录态 → 先推送本地未上传变更 → 再下载合并。
 *
 * ponytail: 原实现只下载不上传，是“复活”问题的核心后台表现——MV3 popup
 * 失焦销毁后任何本地变更都不可能再上云，但后台轮询仍然在拉云端，会把
 * 云端旧版本合并回本地。先检查持久化 pending_upload，若有未上传变更
 * 先 upload()（即使 SW 刚起来也是冷启动无 timer，安全可调），再
 * downloadAndMerge。这保证“下载”不会反着覆盖“刚改但还没上传完”的本地状态。
 *
 * @returns true 表示执行了同步（上传 / 下载任一）；false 表示未登录，跳过。
 */
async function performBackgroundSync(): Promise<boolean> {
  // 1. 恢复登录态（读取 chrome.storage.local 中的 session）
  const user = await store.dispatch(getCurrentUser()).unwrap().catch(() => null);
  if (!user) {
    console.log('[BackgroundSync] 未登录，跳过后台同步');
    return false;
  }

  // 2. 登录态写入 store（SyncEngine 检查 store.auth.isAuthenticated 才放行）
  store.dispatch(
    setFromCache({ user, isAuthenticated: true })
  );

  // 2.5 载入用户设置（syncStrategy 决定合并策略；SW 的 store 是新实例，默认值会丢用户配置）
  await store.dispatch(loadSettings()).unwrap().catch(() => undefined);

  // 3. ponytail: 先上传本地未推送变更。持久化标志 storage.getPendingUpload()
  // 跨进程跨 SW 重启保留：popup 失焦销毁后本地有变更 = true，下一次后台
  // alarm 起来时会先上传。forceUpload=true 跳过 cancelPendingUpload 短路。
  try {
    const hasPending = await syncEngine.hasPendingUpload();
    if (hasPending) {
      console.log('[BackgroundSync] 本地有未上传变更，先上传再下载');
      const upResult = await syncEngine.upload({ forcePending: true });
      if (!upResult.success) {
        console.warn(`[BackgroundSync] 上传未成功：${upResult.error}—继续下载（后续 alarm 会重试）`);
      }
    }
  } catch (e) {
    console.warn('[BackgroundSync] 检查 pending_upload 失败（继续）:', e);
  }

  // 4. 下载并合并到本地 storage
  const result = await syncEngine.downloadAndMerge();
  if (!result.success) {
    const reason = result.reason ?? 'unknown';
    if (reason !== 'already_syncing' && reason !== 'recent_upload_guard') {
      console.warn(`[BackgroundSync] 自动下载未成功: ${reason}`);
    }
    return true;
  }

  // 5. 合并结果已由 SyncEngine 写入 storage
  const summary = result.stats
    ? `（本地 ${result.stats.localCount} → 云端 ${result.stats.cloudCount}，合并 ${result.stats.mergedCount}）`
    : '';
  console.log(`[BackgroundSync] 后台同步完成: ${result.groups.length} 个组${summary}`);
  return true;
}