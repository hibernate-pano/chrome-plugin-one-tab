/**
 * 云端数据工具函数
 * 用于检查云端是否有数据
 */

import { sync as supabaseSync, supabase } from './supabase';

/**
 * 检查云端是否有数据
 * @returns 云端是否有数据的Promise
 */
export const checkCloudData = async (): Promise<boolean> => {
  try {
    // 先检查用户是否已登录
    const { data: sessionData } = await supabase.auth.getSession();

    // 如果用户未登录，直接返回false
    if (!sessionData.session) {
      console.log('用户未登录，无法检查云端数据');
      return false;
    }

    // 从云端获取标签组数据
    const cloudGroups = await supabaseSync.downloadTabGroups();

    // 如果云端有标签组数据，返回true
    return Array.isArray(cloudGroups) && cloudGroups.length > 0;
  } catch (error) {
    // 检查是否是认证错误
    if (error instanceof Error &&
      (error.message.includes('用户未登录') ||
        error.message.includes('会话已过期') ||
        error.message.includes('row-level security policy'))) {
      console.log('用户认证问题，无法检查云端数据:', error.message);
      return false;
    }

    console.error('检查云端数据失败:', error);
    return false;
  }
};
