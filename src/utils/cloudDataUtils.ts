/**
 * 云端数据工具函数
 * 用于检查云端是否有数据
 */

import { sync as supabaseSync } from './supabase';

/**
 * 检查云端是否有数据
 * @returns 云端是否有数据的Promise
 */
export const checkCloudData = async (): Promise<boolean> => {
  try {
    // 从云端获取标签组数据
    const cloudGroups = await supabaseSync.downloadTabGroups();
    
    // 如果云端有标签组数据，返回true
    return Array.isArray(cloudGroups) && cloudGroups.length > 0;
  } catch (error) {
    console.error('检查云端数据失败:', error);
    return false;
  }
};
