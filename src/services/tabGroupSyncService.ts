import type { TabGroup } from '@/types/tab';
import { sync as supabaseSync, type TabGroupDigest, type SupabaseSyncPort } from '@/utils/supabase';

export type { TabGroupDigest };
export type { SupabaseSyncPort };

/**
 * S3：透传层依赖 SupabaseSyncPort 接口而非具体实现。
 * 默认绑定真实 sync（行为零变化）；测试或未来多实现可经 setSyncPort 注入替身。
 */
let activeSyncPort: SupabaseSyncPort = supabaseSync;

export function setSyncPort(port: SupabaseSyncPort): void {
  activeSyncPort = port;
}

export function resetSyncPort(): void {
  activeSyncPort = supabaseSync;
}

export async function uploadTabGroups(
  groups: TabGroup[],
  overwriteCloud: boolean = false
) {
  return activeSyncPort.uploadTabGroups(groups, overwriteCloud);
}

export async function downloadTabGroups(): Promise<TabGroup[]> {
  const result = await activeSyncPort.downloadTabGroups();
  return result as TabGroup[];
}

export async function markCloudGroupsAsDeleted(deletedIds: string[]): Promise<void> {
  return activeSyncPort.markCloudGroupsAsDeleted(deletedIds);
}

/** P1-6：本地 purge 的组 id 出队后，彻底删除云端对应行（含读回确认无残留） */
export async function purgeCloudGroups(purgedIds: string[]): Promise<void> {
  return activeSyncPort.purgeCloudGroups(purgedIds);
}

/** 轻量探活：只拉 (id, updated_at, version, is_deleted[, 印记列]) 指纹，无大字段。 */
export async function downloadTabGroupsDigest(): Promise<TabGroupDigest[]> {
  return activeSyncPort.fetchTabGroupsDigest();
}
