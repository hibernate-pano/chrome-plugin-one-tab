/**
 * 同步服务初始化器
 * 负责在应用启动时初始化正确的同步服务，避免多服务冲突
 */

import { logger } from '@/shared/utils/logger';
import { store } from '@/app/store';
import { selectIsAuthenticated } from '@/features/auth/store/authSlice';

export interface SyncInitializationResult {
  success: boolean;
  activeService: string;
  message: string;
  diagnostics?: any;
}

/**
 * 同步服务初始化器类
 */
export class SyncInitializer {
  private isInitialized = false;
  private activeService: string | null = null;

  /**
   * 初始化同步服务
   */
  async initialize(): Promise<SyncInitializationResult> {
    if (this.isInitialized) {
      return {
        success: true,
        activeService: this.activeService || 'none',
        message: '同步服务已初始化'
      };
    }

    try {
      logger.info('🚀 开始初始化同步服务');

      // 1. 检查用户认证状态
      const state = store.getState();
      if (!selectIsAuthenticated(state)) {
        logger.info('用户未登录，跳过同步服务初始化');
        return {
          success: true,
          activeService: 'none',
          message: '用户未登录，同步服务未启动'
        };
      }

      // 2. 运行诊断检查
      const diagnostics = await this.runPreInitializationDiagnostics();
      
      // 3. 根据诊断结果选择同步策略
      const strategy = this.selectSyncStrategy(diagnostics);
      
      // 4. 初始化选定的同步服务
      const initResult = await this.initializeSelectedService(strategy);

      if (initResult.success) {
        this.isInitialized = true;
        this.activeService = strategy;
      }

      return {
        success: initResult.success,
        activeService: strategy,
        message: initResult.message,
        diagnostics
      };

    } catch (error) {
      logger.error('❌ 同步服务初始化失败:', error);
      return {
        success: false,
        activeService: 'none',
        message: `初始化失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 运行初始化前诊断
   */
  private async runPreInitializationDiagnostics(): Promise<any> {
    try {
      const { quickDiagnostic } = await import('@/utils/syncDiagnostics');
      const diagnosticResult = await quickDiagnostic();
      
      logger.info('🔍 初始化前诊断完成', {
        issuesCount: diagnosticResult.issues.length,
        hasErrors: diagnosticResult.issues.some(i => i.type === 'error'),
        hasWarnings: diagnosticResult.issues.some(i => i.type === 'warning')
      });

      return diagnosticResult;
    } catch (error) {
      logger.warn('⚠️ 诊断检查失败，使用默认策略:', error);
      return null;
    }
  }

  /**
   * 选择同步策略
   */
  private selectSyncStrategy(diagnostics: any): string {
    // 如果诊断发现严重问题，使用简化策略
    if (diagnostics?.issues?.some((i: any) => i.type === 'error')) {
      logger.info('🔧 检测到错误，选择统一同步服务');
      return 'unified';
    }

    // 如果检测到服务冲突，使用简化策略
    if (diagnostics?.issues?.some((i: any) => i.category === 'conflict')) {
      logger.info('🔧 检测到服务冲突，选择统一同步服务');
      return 'unified';
    }

    // 检查环境配置
    try {
      const { getSyncConfig } = require('@/shared/config/syncConfig');
      const config = getSyncConfig();
      
      if (config.mechanism === 'simplified') {
        logger.info('🔧 配置指定使用简化机制，选择统一同步服务');
        return 'unified';
      }
    } catch (error) {
      logger.warn('⚠️ 无法读取同步配置，使用默认策略');
    }

    // 默认使用统一同步服务（推荐）
    logger.info('🔧 使用默认策略：统一同步服务');
    return 'unified';
  }

  /**
   * 初始化选定的同步服务
   */
  private async initializeSelectedService(strategy: string): Promise<{ success: boolean; message: string }> {
    switch (strategy) {
      case 'unified':
        return await this.initializeUnifiedService();
      
      case 'legacy':
        return await this.initializeLegacyServices();
      
      default:
        return {
          success: false,
          message: `未知的同步策略: ${strategy}`
        };
    }
  }

  /**
   * 初始化统一同步服务
   */
  private async initializeUnifiedService(): Promise<{ success: boolean; message: string }> {
    try {
      logger.info('🔄 初始化统一同步服务');

      // 1. 停用其他可能冲突的服务
      await this.disableConflictingServices();

      // 2. 初始化统一同步服务
      const { unifiedSyncService } = await import('@/services/UnifiedSyncService');
      await unifiedSyncService.initialize();

      logger.info('✅ 统一同步服务初始化成功');
      return {
        success: true,
        message: '统一同步服务已启动'
      };

    } catch (error) {
      logger.error('❌ 统一同步服务初始化失败:', error);
      return {
        success: false,
        message: `统一同步服务初始化失败: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 初始化传统同步服务（保持向后兼容）
   */
  private async initializeLegacyServices(): Promise<{ success: boolean; message: string }> {
    try {
      logger.info('🔄 初始化传统同步服务');

      // 初始化实时同步
      const { realtimeSync } = await import('@/services/realtimeSync');
      await realtimeSync.initialize();

      logger.info('✅ 传统同步服务初始化成功');
      return {
        success: true,
        message: '传统同步服务已启动'
      };

    } catch (error) {
      logger.error('❌ 传统同步服务初始化失败:', error);
      
      // 降级到统一同步服务
      logger.info('🔄 降级到统一同步服务');
      return await this.initializeUnifiedService();
    }
  }

  /**
   * 停用可能冲突的服务
   */
  private async disableConflictingServices(): Promise<void> {
    const servicesToDisable = [
      '@/services/realtimeSync',
      '@/services/autoSyncManager'
    ];

    for (const servicePath of servicesToDisable) {
      try {
        const service = await import(servicePath);
        
        // 尝试停用服务
        if (service.default?.disconnect) {
          await service.default.disconnect();
          logger.info(`🔌 已停用服务: ${servicePath}`);
        } else if (service.realtimeSync?.disconnect) {
          await service.realtimeSync.disconnect();
          logger.info(`🔌 已停用服务: ${servicePath}`);
        } else if (service.autoSyncManager?.stop) {
          await service.autoSyncManager.stop();
          logger.info(`🔌 已停用服务: ${servicePath}`);
        }
      } catch (error) {
        // 服务不存在或已停用，忽略错误
        logger.debug(`服务不存在或已停用: ${servicePath}`);
      }
    }
  }

  /**
   * 重新初始化（用于用户登录后）
   */
  async reinitialize(): Promise<SyncInitializationResult> {
    logger.info('🔄 重新初始化同步服务');
    
    // 重置状态
    this.isInitialized = false;
    this.activeService = null;

    // 停用现有服务
    await this.disableConflictingServices();

    // 重新初始化
    return await this.initialize();
  }

  /**
   * 停用所有同步服务
   */
  async shutdown(): Promise<void> {
    logger.info('🔌 停用所有同步服务');

    await this.disableConflictingServices();

    // 停用统一同步服务
    try {
      const { unifiedSyncService } = await import('@/services/UnifiedSyncService');
      await unifiedSyncService.disconnect();
    } catch (error) {
      // 忽略错误
    }

    this.isInitialized = false;
    this.activeService = null;

    logger.info('✅ 所有同步服务已停用');
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    isInitialized: boolean;
    activeService: string | null;
  } {
    return {
      isInitialized: this.isInitialized,
      activeService: this.activeService
    };
  }

  /**
   * 执行自动修复
   */
  async autoFix(): Promise<{ success: boolean; message: string; actions: string[] }> {
    try {
      logger.info('🔧 执行同步服务自动修复');

      const actions: string[] = [];

      // 1. 运行诊断
      const { autoFixSyncIssues } = await import('@/utils/syncDiagnostics');
      const fixResult = await autoFixSyncIssues();
      
      actions.push(...fixResult.actions);

      // 2. 重新初始化服务
      const initResult = await this.reinitialize();
      
      if (initResult.success) {
        actions.push(`重新初始化为: ${initResult.activeService}`);
      }

      return {
        success: initResult.success,
        message: initResult.success ? '自动修复完成' : '自动修复失败',
        actions
      };

    } catch (error) {
      logger.error('❌ 自动修复失败:', error);
      return {
        success: false,
        message: `自动修复失败: ${error instanceof Error ? error.message : '未知错误'}`,
        actions: []
      };
    }
  }
}

/**
 * 全局同步初始化器实例
 */
export const syncInitializer = new SyncInitializer();

/**
 * 便捷函数：初始化同步服务
 */
export async function initializeSyncServices(): Promise<SyncInitializationResult> {
  return await syncInitializer.initialize();
}

/**
 * 便捷函数：重新初始化同步服务
 */
export async function reinitializeSyncServices(): Promise<SyncInitializationResult> {
  return await syncInitializer.reinitialize();
}

/**
 * 便捷函数：自动修复同步问题
 */
export async function autoFixSyncServices(): Promise<{ success: boolean; message: string; actions: string[] }> {
  return await syncInitializer.autoFix();
}
