import { store } from '@/store';
import { getCurrentUser, setFromCache } from '@/store/slices/authSlice';
import { loadSettings } from '@/store/slices/settingsSlice';
import { syncEngine } from '@/services/syncEngine';
import { enqueue, hasQueuedOrRunningJob } from './mutationQueue';
import { logError, logInfo, logWarn } from '../utils/log';

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
  logInfo(`[BackgroundSync] 已注册后台同步 alarm（每 ${SYNC_INTERVAL_MINUTES} 分钟）`);
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
    logError('[BackgroundSync] 后台同步异常:', err);
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
  // 0. 同步任务去重闸门（1.22.12）：队列里已有 sync 任务在跑或在排（popup 的
  // AutoSync 下载、上一轮 alarm 还没收尾、延迟上传……）时，本轮直接让路。
  // 不让路的后果是同一条 FIFO 上叠两条整库管线：alarm 每 60s 一次，与每次开
  // popup 的 AutoSync 相互叠加 —— 线上日志里 normalizeTabsData 告警成对出现
  // （两轮全量下载）、用户点击的 removeTab 排在它们后面撞满 30s 协议超时。
  // 让路是安全的：pending_upload 由 mutation 路径的 scheduleUpload 自驱、
  // 下载路径末尾也有 stillPending 兜底重调度，本轮不传不丢任何上传意图；
  // 数据新鲜度最多少等一个 alarm 周期（60s），下轮照常执行。
  if (hasQueuedOrRunningJob('sync:')) {
    logInfo('[BackgroundSync] 已有同步任务在途，跳过本轮轮询（不叠第二条整库管线，下轮 alarm 重试）');
    return true;
  }

  // 1. 恢复登录态（读取 chrome.storage.local 中的 session）
  const user = await store.dispatch(getCurrentUser()).unwrap().catch(() => null);
  if (!user) {
    logInfo('[BackgroundSync] 未登录，跳过后台同步');
    return false;
  }

  // 2. 登录态写入 store（SyncEngine 检查 store.auth.isAuthenticated 才放行）
  store.dispatch(
    setFromCache({ user, isAuthenticated: true })
  );

  // 2.5 载入用户设置（syncStrategy 决定合并策略；SW 的 store 是新实例，默认值会丢用户配置）
  //
  // ── 2026-10-05：读失败改为中止本轮，不再「用默认值继续」（P1）────────────
  // syncStrategy 决定上传时用哪种合并策略，而 cloudOverwrite 那个默认值
  // （conservative）恰好是**最危险**的一个：它假设「云端更新则丢弃本地」，
  // 于是「本地其实有未上传的新状态」这个前提一旦不成立，用户的本地数据
  // 就被云端旧数据覆盖。而设置读失败时，我们**恰恰不知道**这个前提成不成立
  // —— 默认值不是「安全的兜底」，它是「在不确定时选了破坏性更强的那个」。
  //
  // 原来这里是 `.catch(() => undefined)`，读失败与「设置本来就是默认值」不可区分，
  // 两者都会让流程继续 —— 这正是「静默用错策略」的来源。
  try {
    await store.dispatch(loadSettings()).unwrap();
  } catch (e) {
    logWarn(
      '[BackgroundSync] 读不到用户设置，中止本轮同步（syncStrategy 决定合并策略，' +
        '默认值 conservative 会在「本地领先云端」时覆盖本地数据 —— 与其赌一把，' +
        '不如什么都不做）。下轮 alarm 重试。',
      e
    );
    return true;
  }

  // 3. ponytail: 先上传本地未推送变更。持久化标志 storage.getPendingUpload()
  // 跨进程跨 SW 重启保留：popup 失焦销毁后本地有变更 = true，下一次后台
  // alarm 起来时会先上传。forcePending=true 跳过 isSyncing 短路。
  // 上传失败（网络断等）则中止本次下载：拉下来的只会是云端旧数据，
  // 会覆盖本地未推送的新状态（复活）。pending flag 已保留，下轮重试。
  try {
    const hasPending = await syncEngine.hasPendingUpload();
    if (hasPending) {
      logInfo('[BackgroundSync] 本地有未上传变更，先上传再下载');
      // 单写者队列（与 service-worker.ts 的 SYNC upload handler 同名 'sync:upload'），
      // 后台轮询上传与 popup SYNC 消息上传串行执行，避免并发 upload/download 撞车。
      const upResult = await enqueue('sync:upload', () => syncEngine.upload({ forcePending: true }));
      if (!upResult.success) {
        logWarn(`[BackgroundSync] 上传未成功，跳过本次下载: ${upResult.error}（下轮 alarm 重试）`);
        return true;
      }
    }
  } catch (e) {
    // ── 2026-10-05：判据读不到时**中止本轮**，不再继续下载 ──────────────
    // 原来这里是 logWarn + 继续走第 4 步下载。那是危险的：读不到
    // pending_upload 意味着「本地有没有未推送的变更」这个问题没有答案，
    // 而下载会用云端数据覆盖本地。若本地其实有未推送的新状态（正是读失败
    // 最可能的原因之一），这一轮下载就会把它覆盖掉 —— 用户的修改静默丢失。
    //
    // 上传路径的注释（第 79-80 行）已经写明「上传失败则中止本次下载：
    // 拉下来的只会是云端旧数据，会覆盖本地未推送的新状态（复活）」。
    // 读不到判据与上传失败在后果上是同一类：不确定本地是否领先 ⇒ 不下载。
    logWarn(
      '[BackgroundSync] 读不到 pending_upload 判据，中止本轮同步（不下载：' +
        '本地是否领先云端未知，下载可能覆盖未推送的本地变更）。下轮 alarm 重试。',
      e
    );
    return true;
  }

  // 4. 下载并合并到本地 storage（同 'sync:download' 名，串行化）
  const result = await enqueue('sync:download', () => syncEngine.downloadAndMerge());
  if (!result.success) {
    const reason = result.reason ?? 'unknown';
    // already_syncing / recent_upload_guard / pending_upload_failed 属正常并发或保护性跳过，不视为错误
    if (reason !== 'already_syncing' && reason !== 'recent_upload_guard' && reason !== 'pending_upload_failed') {
      logWarn(`[BackgroundSync] 自动下载未成功: ${reason}`);
    }
    return true;
  }

  // 5. 合并结果已由 SyncEngine 写入 storage
  const summary = result.stats
    ? `（本地 ${result.stats.localCount} → 云端 ${result.stats.cloudCount}，合并 ${result.stats.mergedCount}）`
    : '';
  logInfo(`[BackgroundSync] 后台同步完成: ${result.groups.length} 个组${summary}`);
  return true;
}