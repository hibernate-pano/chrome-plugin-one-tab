/**
 * 同步**预览**的数据装配（2026-10-23，第 51 轮）。
 *
 * ── 为什么把这件事从组件里搬出来 ─────────────────────────────────────────
 *
 * 原先「读本机真值 + 读云端 + 算摘要」这三步全写在 React 组件里
 * （`components/sync/SyncButton.tsx`）。后果是：
 *
 *   · 组件里算出来的东西**没法直接测** —— 守卫只能对着**源码长相**断言
 *     （「这段代码里出现了 `skippedRemoteIds: skippedRemoteIds`」），
 *     而源码长相**证明不了**「那个清单真的进了预览」：
 *     把清单换成空数组，源码长相一点没变 ⇒ 守卫照样绿（零检测力）。
 *   · 第 51 轮修的那个缺陷就是这么溜过去的：下载预览压根没拿到「读不出来的
 *     那几组」⇒ 预览把「不会发生的删除」说成会发生。
 *
 * ⇒ 搬到这里之后，守卫可以**真的调用**它（装一个后端替身即可），
 * 拿它算出来的数与**真引擎跑完之后**的事实对账 ——
 * 「预览与实际同源」从此是**行为级**的保证，而不是源码级��许。
 *
 * ── 分层纪律 ─────────────────────────────────────────────────────────────
 * engine → service → port（见 tests/firstSyncPendingGate.test.ts）：
 * 本模块只做「装配」（读真值 + 调纯函数），不碰端口实现细节。
 *
 * ⚠️ 读云端那一层用的是 `services/downloadWithSkippedGroups.ts` 的
 * `downloadGroupsWithSkipped()`（**归一化**跳过清单 + 「方法存在却抛错」
 * 时 fail-closed），**不是** `tabGroupSyncService` 里那个不归一化的版本 ——
 * 同一个纪律（「原子读」）在 IO 层只能有**一份**实现。
 */
import { storage } from '@/utils/storage';
import { downloadGroupsWithSkipped } from '@/services/downloadWithSkippedGroups';
import { buildDownloadPreviewSummary, buildUploadPreviewSummary } from '@/utils/syncPreview';
import type { SyncPreviewSummary } from '@/utils/syncPreview';

/** 上传预览的数据。 */
export interface UploadPreviewData {
  overwrite: SyncPreviewSummary;
  merge: SyncPreviewSummary;
}

/** 下载预览的数据。 */
export interface DownloadPreviewData {
  overwrite: SyncPreviewSummary;
  merge: SyncPreviewSummary;
}

/**
 * 读云端的那一份事实（**原子**：一次调用同时给出「读到的」与「读不出来的」）。
 *
 * ⚠️ 必须是**同一次**下载：分两次调用中间有 await 间隙，可能读到别的轮次的
 * 清单 ⇒ 预览保护/预告错对象（见 services/downloadWithSkippedGroups.ts）。
 */
const readRemoteWithSkips = async () => {
  const remote = await downloadGroupsWithSkipped();
  return {
    groups: remote.groups,
    /** 云端那些「这台设备读不出来」的会话 id（读不出来 = 云端行仍在，只是不在本轮结果里）。 */
    skippedIds: remote.skipped.map(entry => entry.id),
  };
};

/**
 * 上传预览的数据（读真值，不读 30s 缓存）。
 *
 * 为什么必须读真值：这里是**破坏性操作的确认闸门** —— 用户正是核对
 * 「本地 N / 云端 M」之后才按下「覆盖」。缓存过期 ⇒ 用户在错误前提下确认覆盖。
 */
export const loadUploadPreviewData = async (options?: {
  /** 自带存储（WebDAV）的覆盖是「全量上行 + 清单并集」⇒ 云端独有会话一个都不删。 */
  preserveRemoteOnly?: boolean;
}): Promise<UploadPreviewData> => {
  const [localGroups, remote] = await Promise.all([
    storage.getGroupsForWrite(),
    readRemoteWithSkips(),
  ]);

  return {
    overwrite: buildUploadPreviewSummary(localGroups, remote.groups, 'overwrite', {
      preserveRemoteOnly: options?.preserveRemoteOnly === true,
      // 读不出来的那几组**不在** remote.groups 里（那是「读到的」）⇒
      // 不把跳过清单一起给进来，预览就会算错保留数。
      unrestorableRemoteIds: remote.skippedIds,
    }),
    merge: buildUploadPreviewSummary(localGroups, remote.groups, 'merge'),
  };
};

/**
 * 下载预览的数据（读真值，不读 30s 缓存）。
 *
 * ⚠️ 覆盖模式下，「云端这轮读不出来、本机有副本」的那几份**会被保住**
 * （执行侧见 services/syncEngine.ts 的 forceRemote 分支）⇒ 预览必须把它们
 * 算成「保住」而不是「删除」，否则就是**预告与实际相反**（第 51 轮修的缺陷）。
 */
export const loadDownloadPreviewData = async (): Promise<DownloadPreviewData> => {
  const [localGroups, remote] = await Promise.all([
    storage.getGroupsForWrite(),
    readRemoteWithSkips(),
  ]);

  return {
    overwrite: buildDownloadPreviewSummary(localGroups, remote.groups, 'overwrite', {
      skippedRemoteIds: remote.skippedIds,
    }),
    merge: buildDownloadPreviewSummary(localGroups, remote.groups, 'merge', {
      skippedRemoteIds: remote.skippedIds,
    }),
  };
};
