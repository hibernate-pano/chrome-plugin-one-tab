/**
 * OneTabPlus 同步问题诊断和修复工具
 * 用于诊断和解决多设备同步失效、数据回滚等问题
 */

import { logger } from '@/shared/utils/logger';
import { storage } from '@/shared/utils/storage';
import { sync as supabaseSync } from '@/shared/utils/supabase';
import { store } from '@/app/store';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';

export interface SyncDiagnosticResult {
  timestamp: string;
  issues: SyncIssue[];
  recommendations: string[];
  systemInfo: SystemInfo;
}

export interface SyncIssue {
  type: 'error' | 'warning' | 'info';
  category: 'auth' | 'network' | 'data' | 'config' | 'conflict';
  message: string;
  details?: any;
  solution?: string;
}

export interface SystemInfo {
  isAuthenticated: boolean;
  localGroupsCount: number;
  cloudGroupsCount: number;
  lastSyncTime?: string;
  networkStatus: string;
  activeServices: string[];
  configStatus: any;
}

/**
 * 同步诊断器类
 */
export class SyncDiagnostics {
  private issues: SyncIssue[] = [];
  private recommendations: string[] = [];

  /**
   * 执行完整的同步诊断
   */
  async runFullDiagnostic(): Promise<SyncDiagnosticResult> {
    logger.info('🔍 开始同步问题诊断');

    this.issues = [];
    this.recommendations = [];

    // 1. 检查认证状态
    await this.checkAuthenticationStatus();

    // 2. 检查网络连接
    await this.checkNetworkConnectivity();

    // 3. 检查数据一致性
    await this.checkDataConsistency();

    // 4. 检查同步配置
    await this.checkSyncConfiguration();

    // 5. 检查服务冲突
    await this.checkServiceConflicts();

    // 6. 生成系统信息
    const systemInfo = await this.gatherSystemInfo();

    // 7. 生成建议
    this.generateRecommendations();

    const result: SyncDiagnosticResult = {
      timestamp: new Date().toISOString(),
      issues: this.issues,
      recommendations: this.recommendations,
      systemInfo
    };

    logger.info('🔍 同步诊断完成', {
      issuesCount: this.issues.length,
      recommendationsCount: this.recommendations.length
    });

    return result;
  }

  /**
   * 检查认证状态
   */
  private async checkAuthenticationStatus(): Promise<void> {
    const state = store.getState();
    const isAuthenticated = selectIsAuthenticated(state);

    if (!isAuthenticated) {
      this.addIssue({
        type: 'error',
        category: 'auth',
        message: '用户未登录，无法进行云端同步',
        solution: '请先登录账号'
      });
      return;
    }

    // 检查认证token是否有效
    try {
      const testResult = await supabaseSync.downloadTabGroups();
      this.addIssue({
        type: 'info',
        category: 'auth',
        message: '用户认证状态正常',
        details: { groupsCount: testResult.length }
      });
    } catch (error) {
      this.addIssue({
        type: 'error',
        category: 'auth',
        message: '认证token可能已过期或无效',
        details: error,
        solution: '请重新登录账号'
      });
    }
  }

  /**
   * 检查网络连接
   */
  private async checkNetworkConnectivity(): Promise<void> {
    if (!navigator.onLine) {
      this.addIssue({
        type: 'error',
        category: 'network',
        message: '设备处于离线状态',
        solution: '请检查网络连接'
      });
      return;
    }

    // 测试Supabase连接
    try {
      const startTime = Date.now();
      await fetch('https://supabase.co', { method: 'HEAD', mode: 'no-cors' });
      const responseTime = Date.now() - startTime;

      if (responseTime > 5000) {
        this.addIssue({
          type: 'warning',
          category: 'network',
          message: '网络连接较慢，可能影响同步性能',
          details: { responseTime },
          solution: '建议在网络状况良好时进行同步操作'
        });
      } else {
        this.addIssue({
          type: 'info',
          category: 'network',
          message: '网络连接正常',
          details: { responseTime }
        });
      }
    } catch (error) {
      this.addIssue({
        type: 'warning',
        category: 'network',
        message: '无法测试网络连接',
        details: error
      });
    }
  }

  /**
   * 检查数据一致性
   */
  private async checkDataConsistency(): Promise<void> {
    try {
      const localGroups = await storage.getGroups();
      const cloudGroups = await supabaseSync.downloadTabGroups();

      // 检查数据数量差异
      const localCount = localGroups.length;
      const cloudCount = cloudGroups.length;

      if (Math.abs(localCount - cloudCount) > 0) {
        this.addIssue({
          type: 'warning',
          category: 'data',
          message: '本地和云端数据数量不一致',
          details: { localCount, cloudCount },
          solution: '建议执行一次完整同步'
        });
      }

      // 检查数据内容差异
      const localIds = new Set(localGroups.map(g => g.id));
      const cloudIds = new Set(cloudGroups.map(g => g.id));

      const onlyLocal = localGroups.filter(g => !cloudIds.has(g.id));
      const onlyCloud = cloudGroups.filter(g => !localIds.has(g.id));

      if (onlyLocal.length > 0) {
        this.addIssue({
          type: 'warning',
          category: 'data',
          message: '发现仅存在于本地的数据',
          details: { count: onlyLocal.length, groups: onlyLocal.map(g => g.name) },
          solution: '这些数据可能需要推送到云端'
        });
      }

      if (onlyCloud.length > 0) {
        this.addIssue({
          type: 'warning',
          category: 'data',
          message: '发现仅存在于云端的数据',
          details: { count: onlyCloud.length, groups: onlyCloud.map(g => g.name) },
          solution: '这些数据可能需要同步到本地'
        });
      }

      // 检查时间戳异常
      const now = Date.now();
      const oldGroups = localGroups.filter(g => {
        const updatedTime = new Date(g.updatedAt).getTime();
        return now - updatedTime > 30 * 24 * 60 * 60 * 1000; // 30天前
      });

      if (oldGroups.length > 0) {
        this.addIssue({
          type: 'info',
          category: 'data',
          message: '发现较旧的数据',
          details: { count: oldGroups.length },
          solution: '可以考虑清理过期数据'
        });
      }

    } catch (error) {
      this.addIssue({
        type: 'error',
        category: 'data',
        message: '无法检查数据一致性',
        details: error,
        solution: '请检查网络连接和认证状态'
      });
    }
  }

  /**
   * 检查同步配置
   */
  private async checkSyncConfiguration(): Promise<void> {
    try {
      // 检查同步配置
      const { getSyncConfig } = await import('@/shared/config/syncConfig');
      const config = getSyncConfig();

      this.addIssue({
        type: 'info',
        category: 'config',
        message: '当前同步配置',
        details: config
      });

      // 检查是否有冲突的配置
      if (config.mechanism === 'simplified' && config.enableGradualMigration) {
        this.addIssue({
          type: 'warning',
          category: 'config',
          message: '检测到简化同步机制与渐进式迁移同时启用',
          solution: '建议明确选择一种同步策略'
        });
      }

    } catch (error) {
      this.addIssue({
        type: 'warning',
        category: 'config',
        message: '无法检查同步配置',
        details: error
      });
    }
  }

  /**
   * 检查服务冲突
   */
  private async checkServiceConflicts(): Promise<void> {
    const activeServices: string[] = [];

    // 检查各种同步服务的状态
    try {
      const { optimisticSyncService } = await import('@/services/optimisticSyncService');
      activeServices.push('OptimisticSyncService');
    } catch (error) {
      // 服务不可用
    }

    try {
      const { simplifiedSyncService } = await import('@/services/SimplifiedSyncService');
      if (simplifiedSyncService.isSyncInProgress()) {
        activeServices.push('SimplifiedSyncService (active)');
      } else {
        activeServices.push('SimplifiedSyncService');
      }
    } catch (error) {
      // 服务不可用
    }

    // RealtimeSync 服务已移除

    if (activeServices.length > 2) {
      this.addIssue({
        type: 'warning',
        category: 'conflict',
        message: '检测到多个同步服务同时运行',
        details: { activeServices },
        solution: '建议简化为单一同步策略以避免冲突'
      });
    }

    this.addIssue({
      type: 'info',
      category: 'conflict',
      message: '活跃的同步服务',
      details: { activeServices }
    });
  }

  /**
   * 收集系统信息
   */
  private async gatherSystemInfo(): Promise<SystemInfo> {
    const state = store.getState();
    const isAuthenticated = selectIsAuthenticated(state);

    let localGroupsCount = 0;
    let cloudGroupsCount = 0;

    try {
      const localGroups = await storage.getGroups();
      localGroupsCount = localGroups.length;
    } catch (error) {
      // 忽略错误
    }

    try {
      const cloudGroups = await supabaseSync.downloadTabGroups();
      cloudGroupsCount = cloudGroups.length;
    } catch (error) {
      // 忽略错误
    }

    return {
      isAuthenticated,
      localGroupsCount,
      cloudGroupsCount,
      networkStatus: navigator.onLine ? 'online' : 'offline',
      activeServices: [], // 将在checkServiceConflicts中填充
      configStatus: {}
    };
  }

  /**
   * 生成修复建议
   */
  private generateRecommendations(): void {
    const errorCount = this.issues.filter(i => i.type === 'error').length;
    const warningCount = this.issues.filter(i => i.type === 'warning').length;

    if (errorCount > 0) {
      this.recommendations.push('🚨 发现严重问题，建议优先解决错误类问题');
    }

    if (warningCount > 2) {
      this.recommendations.push('⚠️ 发现多个警告，建议简化同步配置');
    }

    // 基于问题类型生成具体建议
    const hasAuthIssues = this.issues.some(i => i.category === 'auth' && i.type === 'error');
    const hasDataInconsistency = this.issues.some(i => i.category === 'data' && i.type === 'warning');
    const hasServiceConflicts = this.issues.some(i => i.category === 'conflict');

    if (hasAuthIssues) {
      this.recommendations.push('🔐 建议重新登录以解决认证问题');
    }

    if (hasDataInconsistency) {
      this.recommendations.push('🔄 建议执行一次完整的数据同步');
    }

    if (hasServiceConflicts) {
      this.recommendations.push('⚙️ 建议简化为单一同步机制（仅使用实时订阅）');
    }

    if (this.issues.length === 0) {
      this.recommendations.push('✅ 系统状态良好，无需特殊处理');
    }
  }

  /**
   * 添加问题记录
   */
  private addIssue(issue: SyncIssue): void {
    this.issues.push(issue);

    const emoji = issue.type === 'error' ? '❌' : issue.type === 'warning' ? '⚠️' : 'ℹ️';
    logger.info(`${emoji} [${issue.category}] ${issue.message}`, issue.details);
  }

  /**
   * 执行自动修复（简化同步策略）
   */
  async executeAutoFix(): Promise<{ success: boolean; message: string; actions: string[] }> {
    const actions: string[] = [];

    try {
      // 1. 切换到仅使用实时订阅的简化策略
      const { updateSyncConfig, SyncMechanism } = await import('@/shared/config/syncConfig');

      updateSyncConfig({
        mechanism: SyncMechanism.SIMPLIFIED,
        enableGradualMigration: false
      });
      actions.push('切换到简化同步机制');

      // 2. RealtimeSync 服务已移除，无需停用

      // 3. 执行一次完整同步以确保数据一致性
      const { optimisticSyncService } = await import('@/services/optimisticSyncService');
      const syncResult = await optimisticSyncService.syncWithPullFirst();

      if (syncResult.success) {
        actions.push('执行完整数据同步');
      } else {
        actions.push('数据同步失败，需要手动处理');
      }

      return {
        success: true,
        message: '自动修复完成',
        actions
      };

    } catch (error) {
      return {
        success: false,
        message: `自动修复失败: ${error instanceof Error ? error.message : '未知错误'}`,
        actions
      };
    }
  }
}

/**
 * 全局诊断器实例
 */
export const syncDiagnostics = new SyncDiagnostics();

/**
 * 便捷函数：快速诊断
 */
export async function quickDiagnostic(): Promise<SyncDiagnosticResult> {
  return await syncDiagnostics.runFullDiagnostic();
}

/**
 * 便捷函数：自动修复
 */
export async function autoFixSyncIssues(): Promise<{ success: boolean; message: string; actions: string[] }> {
  return await syncDiagnostics.executeAutoFix();
}
