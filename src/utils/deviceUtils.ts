/**
 * 设备工具函数
 * 用于获取和管理设备标识
 */

import { kvGet, kvSet } from '@/storage/storageAdapter';
// 2026-10-09 架构 P2-2：键名改引用权威表，不再手抄（详见 journal.ts 同项注释）。
// 注意 DEVICE_ID 归在 LEGACY_KEYS 而非 STORAGE_KEYS：它是沿用旧名的现行键
// （早期写在 chrome.storage.local，迁移到 KV 后没改键名），权威表已按此归类。
import { LEGACY_KEYS } from '@/storage-kv/keys';
import { logInfo } from './log';

// 设备ID存储键（迁移时会同步到 IndexedDB）
const DEVICE_ID_KEY = LEGACY_KEYS.DEVICE_ID;

/**
 * 生成随机设备ID
 * @returns 随机生成的设备ID
 */
function generateDeviceId(): string {
  // 生成一个随机字符串作为设备ID
  const randomPart = Math.random().toString(36).substring(2, 15);
  const timestampPart = Date.now().toString(36);
  return `device_${randomPart}${timestampPart}`;
}

/**
 * 获取当前设备ID
 * 如果本地存储中没有设备ID，则生成一个新的并保存
 * @returns 设备ID
 */
export async function getDeviceId(): Promise<string> {
  let deviceId = await kvGet<string>(DEVICE_ID_KEY);

  // 如果没有设备ID，生成一个新的并保存
  if (!deviceId) {
    deviceId = generateDeviceId();
    await kvSet(DEVICE_ID_KEY, deviceId);
    logInfo('生成新的设备ID:', deviceId);
  }

  return deviceId;
}
