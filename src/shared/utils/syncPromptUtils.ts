/**
 * 同步提示工具函数
 * 用于管理同步提示的本地存储标记
 */

// 本地存储键
const SYNC_PROMPT_SHOWN_KEY = 'onetabplus_sync_prompt_shown';

/**
 * 检查是否已经显示过同步提示
 * @param userId 用户ID，用于区分不同用户
 * @returns 是否已经显示过同步提示
 */
export const hasSyncPromptShown = async (userId: string): Promise<boolean> => {
  try {
    // 使用 Chrome Storage API 替代 localStorage，兼容 Service Worker
    const result = await chrome.storage.local.get(SYNC_PROMPT_SHOWN_KEY);
    const shownData = result[SYNC_PROMPT_SHOWN_KEY];

    if (!shownData) {
      return false;
    }

    const shownUsers = shownData as Record<string, number>;
    // 检查用户ID是否在已显示列表中，并且时间戳不超过30天
    const timestamp = shownUsers[userId];
    if (!timestamp) {
      return false;
    }

    // 如果时间戳超过30天，也视为未显示过
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return timestamp > thirtyDaysAgo;
  } catch (error) {
    console.error('解析同步提示显示记录失败:', error);
    return false;
  }
};

/**
 * 标记已经显示过同步提示
 * @param userId 用户ID，用于区分不同用户
 */
export const markSyncPromptShown = async (userId: string): Promise<void> => {
  try {
    // 使用 Chrome Storage API 替代 localStorage，兼容 Service Worker
    const result = await chrome.storage.local.get(SYNC_PROMPT_SHOWN_KEY);
    const shownUsers = result[SYNC_PROMPT_SHOWN_KEY] || {};

    // 更新用户的显示时间戳
    shownUsers[userId] = Date.now();

    await chrome.storage.local.set({
      [SYNC_PROMPT_SHOWN_KEY]: shownUsers
    });
  } catch (error) {
    console.error('保存同步提示显示记录失败:', error);
  }
};

/**
 * 重置同步提示显示状态
 * @param userId 用户ID，用于区分不同用户
 */
export const resetSyncPromptShown = async (userId: string): Promise<void> => {
  try {
    // 使用 Chrome Storage API 替代 localStorage，兼容 Service Worker
    const result = await chrome.storage.local.get(SYNC_PROMPT_SHOWN_KEY);
    const shownData = result[SYNC_PROMPT_SHOWN_KEY];

    if (!shownData) {
      return;
    }

    const shownUsers = shownData as Record<string, number>;

    // 删除用户的显示记录
    if (userId in shownUsers) {
      delete shownUsers[userId];

      if (Object.keys(shownUsers).length === 0) {
        await chrome.storage.local.remove(SYNC_PROMPT_SHOWN_KEY);
      } else {
        await chrome.storage.local.set({
          [SYNC_PROMPT_SHOWN_KEY]: shownUsers
        });
      }
    }
  } catch (error) {
    console.error('重置同步提示显示记录失败:', error);
  }
};
