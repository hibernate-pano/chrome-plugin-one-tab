import type { TabGroup } from '@/types/tab';
import { sync as supabaseSync, type TabGroupDigest, type SupabaseSyncPort } from '@/utils/supabaseFacade';

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

/** P1-6（历史）：按 id 彻底删除云端行（含读回确认无残留）。 */
export async function purgeCloudGroups(purgedIds: string[]): Promise<void> {
  return activeSyncPort.purgeCloudGroups(purgedIds);
}

/** 无墓碑模型：物理删除超过龄期的云端墓碑行（is_deleted=true），返回删除行数。 */
export async function purgeExpiredCloudTombstones(maxAgeDays: number = 30): Promise<number> {
  return activeSyncPort.purgeExpiredCloudTombstones(maxAgeDays);
}

/** 轻量探活：只拉 (id, updated_at, version, is_deleted[, 印记列]) 指纹，无大字段。 */
export async function downloadTabGroupsDigest(): Promise<TabGroupDigest[]> {
  return activeSyncPort.fetchTabGroupsDigest();
}
