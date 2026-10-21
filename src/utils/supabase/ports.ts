/**
 * S3 拆分 · ports：调用方实际使用的最小 Supabase 端口（接口）。
 * 透传层（tabGroupSyncService）依赖本接口而非具体实现；默认绑定真实 sync，可注入替身。
 */
import type { DownloadSkippedGroup, TabGroup, UserSettings } from '@/types/tab';
import type { TabGroupDigest } from './probe';


/** sync 端口：tabGroupSyncService 及设置同步实际调用的全部 8 个方法。 */
export interface SupabaseSyncPort {
  migrateToJsonb(): Promise<{ success: boolean; migratedGroups: number }>;
  // 注：数据型返回值刻意保持 `any`（与拆分前 sync 对象推断类型一致），避免收紧后击穿既有调用方。
  /**
   * `writtenTombstoneIds` = 本次 upsert 真正写上云的墓碑行 id（见
   * uploadTabGroups 内注释：调用方必须用它把同批 id 从
   * markCloudGroupsAsDeleted 里剔除，避免同一 id 被二次写墓碑）。
   */
  uploadTabGroups(
    groups: TabGroup[],
    overwriteCloud?: boolean
  ): Promise<{ result: any; writtenTombstoneIds?: string[] }>;
  markCloudGroupsAsDeleted(deletedIds: string[]): Promise<void>;
  purgeCloudGroups(purgedIds: string[]): Promise<void>;
  /** 无墓碑模型：物理删除云端过期墓碑行（is_deleted=true 且 deleted_at 早于龄期）。 */
  purgeExpiredCloudTombstones(maxAgeDays?: number): Promise<number>;
  fetchTabGroupsDigest(): Promise<TabGroupDigest[]>;
  /** 全量下载会话（只含**成功还原**的那些）。 */
  downloadTabGroups(): Promise<TabGroup[]>;
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
