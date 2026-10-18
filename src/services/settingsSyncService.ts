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
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';

/**
 * 设备级字段：不上云，也不被云端覆盖（2026-10-18 产品定稿）。
 *
 * 这三个字段描述的是「**这台设备**拿哪个后端同步、要不要自动同步、多久一次」，
 * 而不是「用户长什么样、怎么用」：
 *   - `syncBackend`：WebDAV 的地址与口令本来就不进 UserSettings
 *     （见 sync-backend/webdav/config.ts 文件头）。把 syncBackend 同步过去，
 *     对端会指向一个它没有凭据的后端 ⇒ 同步直接坏掉，而用户只看到
 *     「同步失败/请先登录」，根本无从判断是自己的后端被换了。
 *   - `syncEnabled` / `syncIntervalMinutes`：描述本机的后台行为，alarm 与解锁态
 *     都是设备级的。在 A 机关掉自动同步、B 机开着，B 一次上传就把 A 的选择改回去。
 *
 * 云端只承载外观与操作偏好（主题、布局、命名模板、通知、固定标签等）。
 * 本地上传在此**剔除**这三个键；云端行里可能仍留有旧值
 * （存量行 / 上传前的老版本），由 mergeCloudSettingsIntoLocal 那一侧忽略。
 * 两侧都要做：只剔上传侧的话，覆盖下载仍会把云端旧值合并回本机。
 */
export const DEVICE_LEVEL_SETTING_KEYS = [
  'syncBackend',
  'syncEnabled',
  'syncIntervalMinutes',
] as const;

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
