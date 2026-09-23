import type { TabGroup } from '@/types/tab';
import { sync as supabaseSync, type TabGroupDigest } from '@/utils/supabase';

export type { TabGroupDigest };

export async function uploadTabGroups(
  groups: TabGroup[],
  overwriteCloud: boolean = false
) {
  return supabaseSync.uploadTabGroups(groups, overwriteCloud);
}

export async function downloadTabGroups(): Promise<TabGroup[]> {
  const result = await supabaseSync.downloadTabGroups();
  return result as TabGroup[];
}

export async function markCloudGroupsAsDeleted(deletedIds: string[]): Promise<void> {
  return supabaseSync.markCloudGroupsAsDeleted(deletedIds);
}

/** P1-6：本地 purge 的组 id 出队后，彻底删除云端对应行（含读回确认无残留） */
export async function purgeCloudGroups(purgedIds: string[]): Promise<void> {
  return supabaseSync.purgeCloudGroups(purgedIds);
}

/** 轻量探活：只拉 (id, updated_at, version, is_deleted[, 印记列]) 指纹，无大字段。 */
export async function downloadTabGroupsDigest(): Promise<TabGroupDigest[]> {
  return supabaseSync.fetchTabGroupsDigest();
}
