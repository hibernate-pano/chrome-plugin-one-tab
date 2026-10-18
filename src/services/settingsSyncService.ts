/**
 * 设置同步的透传层（2026-10-13 改造：经 sync-backend 解析后端，
 * 与 tabGroupSyncService 共用同一接缝）。
 *
 * 改造前本文件直接 `import { sync as supabaseSync }`，等于焊死在 Supabase 上。
 * 现在后端解析只有一处（`@/sync-backend`），WebDAV 接入时本文件无需改动。
 *
 * ── 返回类型为什么保留 `Record<string, any>` 而不是收紧成 `unknown` ──────
 * 调用方 `syncEngine.mergeCloudSettingsIntoLocal()` 直接把返回值展开进
 * `UserSettings`（`{ ...updatedDefault, ...cloudSettings }`）。
 * 收紧成 unknown 会让那次展开需要逐个字段断言，属于「顺手改类型击穿调用方」。
 * 这与 `utils/supabase/ports.ts` 对同一件事的既有判断一致（那里的注释：
 * 「数据型返回值刻意保持 any……避免收紧后击穿既有调用方」）。
 */
import type { UserSettings } from '@/types/tab';
import { DEVICE_LEVEL_SETTING_KEYS } from '@/types/tab';
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';

// 定义搬到了 @/types/tab（UserSettings 的字段说明旁边）——「哪些字段是设备级的」
// 是设置模型自身的性质，而不是同步接缝的性质；导入路径（utils/storage）也要用它，
// 而 storage → settingsSyncService → @/sync-backend → storage 会成环。
// 这里原样再导出，既有的 import 方（syncEngine / 守卫测试）不受影响。
export { DEVICE_LEVEL_SETTING_KEYS };

export function toCloudSettings(settings: UserSettings): Partial<UserSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const key of DEVICE_LEVEL_SETTING_KEYS) delete out[key];
  return out as Partial<UserSettings>;
}

export async function uploadSettings(settings: UserSettings): Promise<void> {
  await ensureBackendPrimed();
  // 这里是**两个后端共同的唯一入口**（settingsSyncService 是透传层，
  // supabaseAdapter 与 webdav/adapter 都从它拿 settings），所以在这剔一次
  // 就同时覆盖了 Supabase 的 allowedFields 白名单与 WebDAV 的整份透传
  // —— 后者零字段过滤，不在这里剔就会把设备级字段整份写进用户的云盘文件。
  return getActiveSyncBackend().uploadSettings(toCloudSettings(settings) as UserSettings);
}

export async function downloadSettings(): Promise<Record<string, any> | null> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().downloadSettings() as Promise<Record<string, any> | null>;
}
