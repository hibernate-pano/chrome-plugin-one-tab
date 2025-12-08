/**
 * 同步提示工具函数
 * 用于管理同步提示的本地存储标记
 */

import { kvGet, kvSet } from '@/storage/storageAdapter';

// 本地存储键
const SYNC_PROMPT_SHOWN_KEY = 'tabvaultpro_sync_prompt_shown';

/**
 * 检查是否已经显示过同步提示
 * @param userId 用户ID，用于区分不同用户
 * @returns 是否已经显示过同步提示
 */
export const hasSyncPromptShown = async (userId: string): Promise<boolean> => {
  const shownUsers = (await kvGet<Record<string, number>>(SYNC_PROMPT_SHOWN_KEY)) || {};

  const timestamp = shownUsers[userId];
  if (!timestamp) {
    return false;
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return timestamp > thirtyDaysAgo;
};

/**
 * 标记已经显示过同步提示
 * @param userId 用户ID，用于区分不同用户
 */
export const markSyncPromptShown = async (userId: string): Promise<void> => {
  const shownUsers = (await kvGet<Record<string, number>>(SYNC_PROMPT_SHOWN_KEY)) || {};
  shownUsers[userId] = Date.now();
  await kvSet(SYNC_PROMPT_SHOWN_KEY, shownUsers);
};

/**
 * 重置同步提示显示状态
 * @param userId 用户ID，用于区分不同用户
 */
export const resetSyncPromptShown = async (userId: string): Promise<void> => {
  const shownUsers = (await kvGet<Record<string, number>>(SYNC_PROMPT_SHOWN_KEY)) || {};
  if (!(userId in shownUsers)) return;
  delete shownUsers[userId];
  await kvSet(SYNC_PROMPT_SHOWN_KEY, shownUsers);
};
