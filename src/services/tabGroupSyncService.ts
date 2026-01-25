import type { TabGroup } from '@/types/tab';
import { sync as supabaseSync } from '@/utils/supabase';

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
