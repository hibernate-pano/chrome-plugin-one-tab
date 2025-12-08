/**
 * 设备工具函数
 * 用于获取和管理设备标识
 */

import { kvGet, kvSet } from '@/storage/storageAdapter';

// 设备ID存储键（迁移时会同步到 IndexedDB）
const DEVICE_ID_KEY = 'tabvaultpro_device_id';

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
    console.log('生成新的设备ID:', deviceId);
  }

  return deviceId;
}

/**
 * 重置设备ID
 * 用于用户登出或需要重新生成设备ID的情况
 * @returns 新的设备ID
 */
export async function resetDeviceId(): Promise<string> {
  const newDeviceId = generateDeviceId();
  await kvSet(DEVICE_ID_KEY, newDeviceId);
  console.log('重置设备ID:', newDeviceId);
  return newDeviceId;
}
