import type { UserSettings } from '@/types/tab';
import { sync as supabaseSync } from '@/utils/supabase';

export async function uploadSettings(settings: UserSettings) {
  return supabaseSync.uploadSettings(settings);
}

export async function downloadSettings(): Promise<Record<string, any> | null> {
  return supabaseSync.downloadSettings();
}
