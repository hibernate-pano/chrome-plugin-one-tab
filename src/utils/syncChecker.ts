import { storage } from './storage';
import { sync as supabaseSync } from './supabase';
import { TabGroup } from '@/types/tab';

/**
 * 同步状态检查器
 * 用于检查本地和云端数据是否一致
 */
export const syncChecker = {
  /**
   * 检查本地和云端数据是否一致
   * @returns 同步状态信息
   */
  async checkSyncStatus(): Promise<SyncStatusInfo> {
    try {
      // 获取本地数据
      const localGroups = await storage.getGroups();
      
      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      
      // 计算统计信息
      const localGroupCount = localGroups.length;
      const cloudGroupCount = cloudGroups.length;
      
      // 计算本地标签总数
      const localTabCount = localGroups.reduce((count, group) => count + group.tabs.length, 0);
      
      // 计算云端标签总数
      const cloudTabCount = cloudGroups.reduce((count, group) => count + group.tabs.length, 0);
      
      // 检查是否有本地独有的标签组
      const localOnlyGroups = findLocalOnlyGroups(localGroups, cloudGroups);
      
      // 检查是否有云端独有的标签组
      const cloudOnlyGroups = findCloudOnlyGroups(localGroups, cloudGroups);
      
      // 计算同步状态
      const syncStatus = calculateSyncStatus(localGroupCount, cloudGroupCount, localOnlyGroups.length, cloudOnlyGroups.length);
      
      return {
        localGroupCount,
        cloudGroupCount,
        localTabCount,
        cloudTabCount,
        localOnlyGroups,
        cloudOnlyGroups,
        syncStatus,
        lastChecked: new Date().toISOString()
      };
    } catch (error) {
      console.error('检查同步状态失败:', error);
      throw error;
    }
  },
  
  /**
   * 修复同步问题
   * @param action 修复操作
   * @returns 修复结果
   */
  async fixSyncIssues(action: 'upload' | 'download' | 'merge'): Promise<FixResult> {
    try {
      switch (action) {
        case 'upload':
          // 将本地数据上传到云端
          return await this.uploadAllToCloud();
        
        case 'download':
          // 从云端下载数据到本地
          return await this.downloadAllFromCloud();
        
        case 'merge':
          // 合并本地和云端数据
          return await this.mergeLocalAndCloud();
        
        default:
          throw new Error('无效的修复操作');
      }
    } catch (error) {
      console.error('修复同步问题失败:', error);
      throw error;
    }
  },
  
  /**
   * 将所有本地数据上传到云端
   */
  async uploadAllToCloud(): Promise<FixResult> {
    try {
      // 获取本地数据
      const localGroups = await storage.getGroups();
      
      // 上传到云端
      await supabaseSync.uploadTabGroups(localGroups);
      
      return {
        success: true,
        action: 'upload',
        message: `成功将 ${localGroups.length} 个标签组上传到云端`
      };
    } catch (error) {
      return {
        success: false,
        action: 'upload',
        message: `上传失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  },
  
  /**
   * 从云端下载所有数据到本地
   */
  async downloadAllFromCloud(): Promise<FixResult> {
    try {
      // 从云端下载数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      
      // 保存到本地
      await storage.setGroups(cloudGroups);
      
      return {
        success: true,
        action: 'download',
        message: `成功从云端下载 ${cloudGroups.length} 个标签组`
      };
    } catch (error) {
      return {
        success: false,
        action: 'download',
        message: `下载失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  },
  
  /**
   * 合并本地和云端数据
   */
  async mergeLocalAndCloud(): Promise<FixResult> {
    try {
      // 获取本地数据
      const localGroups = await storage.getGroups();
      
      // 获取云端数据
      const cloudGroups = await supabaseSync.downloadTabGroups();
      
      // 合并数据
      const mergedGroups = mergeGroups(localGroups, cloudGroups);
      
      // 保存到本地
      await storage.setGroups(mergedGroups);
      
      // 上传到云端
      await supabaseSync.uploadTabGroups(mergedGroups);
      
      return {
        success: true,
        action: 'merge',
        message: `成功合并本地和云端数据，共 ${mergedGroups.length} 个标签组`
      };
    } catch (error) {
      return {
        success: false,
        action: 'merge',
        message: `合并失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }
};

/**
 * 查找本地独有的标签组
 */
function findLocalOnlyGroups(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
  const cloudGroupIds = new Set(cloudGroups.map(group => group.id));
  return localGroups.filter(group => !cloudGroupIds.has(group.id));
}

/**
 * 查找云端独有的标签组
 */
function findCloudOnlyGroups(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
  const localGroupIds = new Set(localGroups.map(group => group.id));
  return cloudGroups.filter(group => !localGroupIds.has(group.id));
}

/**
 * 计算同步状态
 */
function calculateSyncStatus(
  localGroupCount: number,
  cloudGroupCount: number,
  localOnlyCount: number,
  cloudOnlyCount: number
): SyncStatus {
  // 如果本地和云端数据完全一致
  if (localGroupCount === cloudGroupCount && localOnlyCount === 0 && cloudOnlyCount === 0) {
    return 'synced';
  }
  
  // 如果本地有云端没有的数据
  if (localOnlyCount > 0) {
    return 'local-ahead';
  }
  
  // 如果云端有本地没有的数据
  if (cloudOnlyCount > 0) {
    return 'cloud-ahead';
  }
  
  // 如果本地和云端都有对方没有的数据
  if (localOnlyCount > 0 && cloudOnlyCount > 0) {
    return 'diverged';
  }
  
  // 默认情况
  return 'unknown';
}

/**
 * 合并标签组
 */
function mergeGroups(localGroups: TabGroup[], cloudGroups: TabGroup[]): TabGroup[] {
  const mergedMap = new Map<string, TabGroup>();
  const currentTime = new Date().toISOString();
  
  // 添加所有本地项到映射
  localGroups.forEach(item => {
    const localItem = {
      ...item,
      syncStatus: 'synced' as const,
      lastSyncedAt: currentTime
    };
    mergedMap.set(item.id, localItem);
  });
  
  // 合并云端项，冲突时使用更新版本
  cloudGroups.forEach(cloudItem => {
    const localItem = mergedMap.get(cloudItem.id);
    
    if (!localItem) {
      // 云端独有项，添加它
      const newItem = {
        ...cloudItem,
        syncStatus: 'synced' as const,
        lastSyncedAt: currentTime
      };
      mergedMap.set(cloudItem.id, newItem);
    } else {
      // 项存在于本地，使用更新版本
      const localTime = new Date(localItem.updatedAt).getTime();
      const cloudTime = new Date(cloudItem.updatedAt).getTime();
      
      if (cloudTime > localTime) {
        // 云端版本更新，使用云端版本
        const updatedItem = {
          ...cloudItem,
          syncStatus: 'synced' as const,
          lastSyncedAt: currentTime
        };
        mergedMap.set(cloudItem.id, updatedItem);
      }
    }
  });
  
  return Array.from(mergedMap.values());
}

// 类型定义
export type SyncStatus = 'synced' | 'local-ahead' | 'cloud-ahead' | 'diverged' | 'unknown';

export interface SyncStatusInfo {
  localGroupCount: number;
  cloudGroupCount: number;
  localTabCount: number;
  cloudTabCount: number;
  localOnlyGroups: TabGroup[];
  cloudOnlyGroups: TabGroup[];
  syncStatus: SyncStatus;
  lastChecked: string;
}

export interface FixResult {
  success: boolean;
  action: 'upload' | 'download' | 'merge';
  message: string;
}
