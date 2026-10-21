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
import { DEVICE_LEVEL_SETTING_KEYS, stripNonPortableSettings } from '@/types/tab';
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';

// 定义搬到了 @/types/tab（UserSettings 的字段说明旁边）——「哪些字段是设备级的」
// 是设置模型自身的性质，而不是同步接缝的性质；导入路径（utils/storage）也要用它，
// 而 storage → settingsSyncService → @/sync-backend → storage 会成环。
// 这里原样再导出，既有的 import 方（syncEngine / 守卫测试）不受影响。
export { DEVICE_LEVEL_SETTING_KEYS };
// 2026-10-20 审计 A-21：同步层与存储层共用同一张「不跨设备 / 已退役」剔除表。
export { stripNonPortableSettings };

/**
 * 生成「上云的那一份设置」。
 *
 * 剔除两类字段，**两类都不能上云**：
 *
 * ① **设备级**（DEVICE_LEVEL_SETTING_KEYS：syncBackend / syncEnabled /
 *    syncIntervalMinutes）—— 设备级字段以本机为准，云端行里可能仍留着
 *    上传前老版本写下的这些键（存量行、改设置前推上去的行）。
 *
 * ② **已退役**（RETIRED_SETTING_KEYS：groupNameTemplate / allowDuplicateTabs /
 *    deleteStrategy / reorderMode / syncStrategy，2026-10-20 审计 A-9）——
 *    这些设置既没有入口也没有读取方（死设置），留着它们上云就是在
 *    **数据模型里继续假装它们存在**。
 *
 *    【为什么这里也必须剔】Supabase 侧有 allowedFields 白名单兜着，
 *    但 WebDAV 侧是**整份透传**（零字段过滤）—— 不在这里剔，
 *    用户的云盘 settings.json 里就会一直躺着这些早已不存在的设置。
 *    而本地那一侧（storage.setSettings）也会把退役键剔掉 ⇒
 *    两端成对：旧的云端文件里残留的退役键，下载合并时同样会被剔。
 */
export function toCloudSettings(settings: UserSettings): Partial<UserSettings> {
  // 2026-10-20 审计 A-21：改用共用函数 stripNonPortableSettings ——
  // 「上云 / 云端合并 / 导入备份 / 导出备份」四条路径同一张剔除表。
  return stripNonPortableSettings(settings);
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
