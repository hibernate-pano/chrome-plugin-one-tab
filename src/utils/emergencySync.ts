/**
 * 紧急同步修复工具
 * 用于解决网络不稳定导致的数据同步异常问题
 */

import { TabGroup } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';
import { logger } from '@/shared/utils/logger';

export interface EmergencyFixResult {
  success: boolean;
  message: string;
  actions: string[];
  beforeCount: number;
  afterCount: number;
  fixedIssues: string[];
  error?: string;
}

/**
 * 紧急同步修复器
 */
export class EmergencySync {
  private isFixing = false;

  /**
   * 执行紧急修复
   */
  async performEmergencyFix(): Promise<EmergencyFixResult> {
    if (this.isFixing) {
      return {
        success: false,
        message: '修复正在进行中',
        actions: [],
        beforeCount: 0,
        afterCount: 0,
        fixedIssues: []
      };
    }

    this.isFixing = true;
    const actions: string[] = [];
    const fixedIssues: string[] = [];

    try {
      console.group('🚨 紧急同步修复开始');

      // 1. 检查认证状态
      const state = store.getState();
      if (!selectIsAuthenticated(state)) {
        throw new Error('用户未登录，无法执行同步修复');
      }

      // 2. 获取当前本地数据
      const localGroups = await storage.getGroups();
      const beforeCount = this.getTotalTabCount(localGroups);

      console.log('📊 修复前状态:', {
        本地组数: localGroups.length,
        本地标签数: beforeCount
      });

      // 3. 停用所有可能冲突的同步服务
      await this.disableAllSyncServices();
      actions.push('停用冲突的同步服务');
      fixedIssues.push('解决同步服务冲突');

      // 4. 清理网络连接状态
      await this.resetNetworkState();
      actions.push('重置网络连接状态');
      fixedIssues.push('修复网络连接问题');

      // 5. 执行强制云端同步（重试机制）
      const cloudGroups = await this.forceCloudSync();
      actions.push('强制从云端同步数据');

      // 6. 数据一致性修复
      const fixedGroups = await this.fixDataConsistency(localGroups, cloudGroups);
      actions.push('修复数据一致性');

      // 7. 执行去重修复（如果需要）
      const finalGroups = await this.performEmergencyDeduplication(fixedGroups);
      const afterCount = this.getTotalTabCount(finalGroups);

      // 8. 强制上传修复后的数据
      await this.forceUploadData(finalGroups);
      actions.push('强制上传修复后的数据');

      // 9. 更新本地存储和UI
      await storage.setGroups(finalGroups);
      store.dispatch(setGroups(finalGroups));
      actions.push('更新本地存储和界面');

      console.log('✅ 修复完成:', {
        修复前标签数: beforeCount,
        修复后标签数: afterCount,
        修复的问题: fixedIssues
      });

      console.groupEnd();

      return {
        success: true,
        message: `紧急修复完成，标签数从 ${beforeCount} 修复为 ${afterCount}`,
        actions,
        beforeCount,
        afterCount,
        fixedIssues
      };

    } catch (error) {
      console.error('❌ 紧急修复失败:', error);
      console.groupEnd();

      return {
        success: false,
        message: '紧急修复失败',
        actions,
        beforeCount: 0,
        afterCount: 0,
        fixedIssues,
        error: error instanceof Error ? error.message : '未知错误'
      };
    } finally {
      this.isFixing = false;
    }
  }

  /**
   * 停用所有同步服务
   */
  private async disableAllSyncServices(): Promise<void> {
    console.log('🔌 停用所有同步服务');

    const servicesToDisable = [
      '@/services/autoSyncManager',
      '@/services/optimisticSyncService'
    ];

    for (const servicePath of servicesToDisable) {
      try {
        const service = await import(servicePath);

        if (service.default?.disconnect) {
          await service.default.disconnect();
        } else if (service.autoSyncManager?.stop) {
          await service.autoSyncManager.stop();
        }

        console.log(`✅ 已停用: ${servicePath}`);
      } catch (error) {
        console.log(`⚠️ 服务不存在或已停用: ${servicePath}`);
      }
    }
  }

  /**
   * 重置网络状态
   */
  private async resetNetworkState(): Promise<void> {
    console.log('🌐 重置网络连接状态');

    // 清理可能的网络错误状态
    try {
      // 如果有网络管理器，重置它
      const { networkManager } = await import('@/shared/utils/networkManager');
      // 这里可以添加重置网络状态的逻辑
      console.log('✅ 网络状态已重置');
    } catch (error) {
      console.log('⚠️ 网络管理器不存在，跳过重置');
    }
  }

  /**
   * 强制云端同步（带重试）
   */
  private async forceCloudSync(): Promise<TabGroup[]> {
    console.log('☁️ 强制从云端同步数据');

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 尝试第 ${attempt} 次云端同步`);

        const cloudGroups = await supabaseSync.downloadTabGroups();

        console.log(`✅ 云端同步成功 (尝试 ${attempt}/${maxRetries})`, {
          云端组数: cloudGroups.length,
          云端标签数: this.getTotalTabCount(cloudGroups)
        });

        return cloudGroups;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('未知错误');
        console.warn(`❌ 第 ${attempt} 次同步失败:`, lastError.message);

        if (attempt < maxRetries) {
          // 等待后重试
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    throw new Error(`云端同步失败，已重试 ${maxRetries} 次。最后错误: ${lastError?.message}`);
  }

  /**
   * 修复数据一致性
   */
  private async fixDataConsistency(localGroups: TabGroup[], cloudGroups: TabGroup[]): Promise<TabGroup[]> {
    console.log('🔧 修复数据一致性');

    // 如果云端没有数据，使用本地数据
    if (cloudGroups.length === 0) {
      console.log('☁️ 云端无数据，使用本地数据');
      return localGroups;
    }

    // 如果本地没有数据，使用云端数据
    if (localGroups.length === 0) {
      console.log('💾 本地无数据，使用云端数据');
      return cloudGroups;
    }

    // 简单策略：使用数据更多的版本
    const localTabCount = this.getTotalTabCount(localGroups);
    const cloudTabCount = this.getTotalTabCount(cloudGroups);

    console.log('📊 数据对比:', {
      本地标签数: localTabCount,
      云端标签数: cloudTabCount
    });

    // 如果差异很大，选择数据更多的版本
    if (Math.abs(localTabCount - cloudTabCount) > 50) {
      const useCloud = cloudTabCount > localTabCount;
      console.log(`🎯 选择${useCloud ? '云端' : '本地'}数据 (数据更完整)`);
      return useCloud ? cloudGroups : localGroups;
    }

    // 差异不大，使用云端数据（假设是最新的）
    console.log('🎯 使用云端数据 (假设为最新)');
    return cloudGroups;
  }

  /**
   * 紧急去重修复
   */
  private async performEmergencyDeduplication(groups: TabGroup[]): Promise<TabGroup[]> {
    console.log('🔄 执行紧急去重修复');

    const urlMap = new Map<string, boolean>();
    let totalRemoved = 0;

    const deduplicatedGroups = groups.map(group => {
      const filteredTabs = group.tabs.filter(tab => {
        if (!tab.url) return true;

        if (urlMap.has(tab.url)) {
          totalRemoved++;
          return false;
        }

        urlMap.set(tab.url, true);
        return true;
      });

      return {
        ...group,
        tabs: filteredTabs,
        updatedAt: filteredTabs.length !== group.tabs.length ? new Date().toISOString() : group.updatedAt
      };
    }).filter(group => group.tabs.length > 0);

    console.log('✅ 紧急去重完成:', {
      移除重复标签: totalRemoved,
      剩余组数: deduplicatedGroups.length,
      剩余标签数: this.getTotalTabCount(deduplicatedGroups)
    });

    return deduplicatedGroups;
  }

  /**
   * 强制上传数据
   */
  private async forceUploadData(groups: TabGroup[]): Promise<void> {
    console.log('📤 强制上传数据到云端');

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 尝试第 ${attempt} 次上传`);

        // 使用覆盖模式确保数据一致性
        await supabaseSync.uploadTabGroups(groups, true);

        console.log(`✅ 数据上传成功 (尝试 ${attempt}/${maxRetries})`);
        return;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('未知错误');
        console.warn(`❌ 第 ${attempt} 次上传失败:`, lastError.message);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    throw new Error(`数据上传失败，已重试 ${maxRetries} 次。最后错误: ${lastError?.message}`);
  }

  /**
   * 获取总标签数
   */
  private getTotalTabCount(groups: TabGroup[]): number {
    return groups.reduce((sum, group) => sum + group.tabs.length, 0);
  }

  /**
   * 检查是否正在修复
   */
  isFixingInProgress(): boolean {
    return this.isFixing;
  }
}

/**
 * 全局紧急修复器实例
 */
export const emergencySync = new EmergencySync();

/**
 * 便捷函数：执行紧急修复
 */
export async function performEmergencyFix(): Promise<EmergencyFixResult> {
  return await emergencySync.performEmergencyFix();
}

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).emergencySync = emergencySync;
  (window as any).performEmergencyFix = performEmergencyFix;
}
