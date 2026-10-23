/**
 * S3 拆分 · ports：调用方实际使用的最小 Supabase 端口（接口）。
 * 透传层（tabGroupSyncService）依赖本接口而非具体实现；默认绑定真实 sync，可注入替身。
 */
import type { DownloadSkippedGroup, TabGroup, UserSettings } from '@/types/tab';
import type { TabGroupDigest } from './probe';
import type { DeleteBroadcastResult } from '@/core/accountScope';
import type { OverwriteSkipReason } from '@/core/overwriteUploadGuard';


/** sync 端口：tabGroupSyncService 及设置同步实际调用的全部 8 个方法。 */
export interface SupabaseSyncPort {
  migrateToJsonb(): Promise<{ success: boolean; migratedGroups: number }>;
  // 注：数据型返回值刻意保持 `any`（与拆分前 sync 对象推断类型一致），避免收紧后击穿既有调用方。
  /**
   * `writtenTombstoneIds` = 本次 upsert 真正写上云的墓碑行 id（见
   * uploadTabGroups 内注释：调用方必须用它把同批 id 从
   * markCloudGroupsAsDeleted 里剔除，避免同一 id 被二次写墓碑）。
   *
   * `blockedAccountIds` = 被**账号闸门**挡下的会话 id（2026-10-22 DS-1 收口）：
   * 它们属于本机上的另一个账号，**没进上行集合** ⇒ 调用方对账时必须知道
   * 它们「不算已提交」。
   */
  /**
   * `overwriteSkipped` = 覆盖上传被**跳过**（2026-10-23 回归审计 R-1 收口）。
   *
   * 覆盖 = 「先删空该账号的云端，再把本机的写回去」。当账号闸门放行 0 个
   * （换账号后本机的会话都属于上一个账号）时，「删空」会发生而「写回」什么
   * 都不会写 ⇒ **纯数据丢失** ⇒ 必须跳过，并把这件事如实报给上层
   * （否则界面报「已覆盖云端」，而云端其实被清空了 / 或原封未动）。
   */
  uploadTabGroups(
    groups: TabGroup[],
    overwriteCloud?: boolean
  ): Promise<{
    result: any;
    writtenTombstoneIds?: string[];
    blockedAccountIds?: string[];
    overwriteSkipped?: OverwriteSkipReason;
  }>;
  markCloudGroupsAsDeleted(deletedIds: string[]): Promise<DeleteBroadcastResult>;
  purgeCloudGroups(purgedIds: string[]): Promise<void>;
  /** 无墓碑模型：物理删除云端过期墓碑行（is_deleted=true 且 deleted_at 早于龄期）。 */
  purgeExpiredCloudTombstones(maxAgeDays?: number): Promise<number>;
  fetchTabGroupsDigest(): Promise<TabGroupDigest[]>;
  /**
   * 下载会话（只含**成功还原**的那些）。
   *
   * `options.onlyIds`（2026-10-23 第 53 轮）：只取给定的那几行。
   * 不传 = 全量。传了 = 出网量 ∝ 变更量（见 core/cloudDelta.ts 的判据）。
   */
  downloadTabGroups(options?: { onlyIds?: string[] }): Promise<TabGroup[]>;
  /**
   * 本轮（或最近一轮）下载里**读不出来**而被整组跳过的会话（2026-10-20 D-6）。
   *
   * 「这一组存在于云端，但这一轮没能把它还原成可用的会话」——
   * 形状不可恢复 / 还原率不达标 / tabs 表回填被网关截断 / 单组处理异常。
   * 那些**云端行原封保留**（一个字节都没被动过）。
   *
   * 为什么必须把它报出去（而不是让它在返回值里消失）：
   * 覆盖下载（forceRemote）会用云端**替换**本地。若「这轮没读到」与
   * 「云端没有」无法区分，引擎就会把本机那一份物理清除 ⇒
   * 云端的数据被用户自己的下载吃掉，界面还报「下载成功」。
   *
   * 与 `downloadTabGroups()` 的结果**来自同一轮**（实现保证，见
   * utils/supabase/download.ts 的 lastDownloadSkipped）。
   */
  downloadSkippedGroups(): Promise<DownloadSkippedGroup[]>;
  uploadSettings(settings: UserSettings): Promise<any>;
  downloadSettings(): Promise<any>;
}

/** auth 端口：登录态/会话读取最小面（高危语义：fail-soft 空会话，不抛错）。 */
export interface SupabaseAuthPort {
  signUp(email: string, password: string): Promise<unknown>;
  signIn(email: string, password: string): Promise<unknown>;
  signOut(): Promise<unknown>;
  getCurrentUser(): Promise<{ data: { user: unknown }; error: unknown }>;
  getSession(): Promise<{ data: { session: unknown }; error: unknown }>;
}

/** 聚合端口：auth + sync 最小面。 */
export interface SupabasePort {
  auth: SupabaseAuthPort;
  sync: SupabaseSyncPort;
}
