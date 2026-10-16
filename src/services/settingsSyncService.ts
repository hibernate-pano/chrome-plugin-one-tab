/**
 * 设置同步的透传层（2026-10-13 改造：经 sync-backend 解析后端，
 * 与 tabGroupSyncService 共用同一接缝）。
 *
 * 改造前本文件直接 import 某个后端 SDK，等于焊死在一个后端上。
 * 现在后端解析只有一处（`@/sync-backend`），换后端时本文件无需改动。
 *
 * ── 返回类型为什么保留 `Record<string, any>` 而不是收紧成 `unknown` ──────
 * 调用方 `syncEngine.mergeCloudSettingsIntoLocal()` 直接把返回值展开进
 * `UserSettings`（`{ ...updatedDefault, ...cloudSettings }`）。
 * 收紧成 unknown 会让那次展开需要逐个字段断言，属于「顺手改类型击穿调用方」。
 * 这与本层一贯的纪律一致（「数据型返回值刻意保持 any……避免收紧后击穿既有调用方」）。
 */
import type { UserSettings } from '@/types/tab';
import { ensureBackendPrimed, getActiveSyncBackend } from '@/sync-backend';

export async function uploadSettings(settings: UserSettings): Promise<void> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().uploadSettings(settings);
}

export async function downloadSettings(): Promise<Record<string, any> | null> {
  await ensureBackendPrimed();
  return getActiveSyncBackend().downloadSettings() as Promise<Record<string, any> | null>;
}
