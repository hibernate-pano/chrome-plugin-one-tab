/**
 * S3 拆分 · ports：调用方实际使用的最小 Supabase 端口（接口）。
 * 透传层（tabGroupSyncService）依赖本接口而非具体实现；默认绑定真实 sync，可注入替身。
 */
import type { TabGroup, UserSettings } from '@/types/tab';
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
  fetchTabGroupsDigest(): Promise<TabGroupDigest[]>;
  downloadTabGroups(): Promise<TabGroup[]>;
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
