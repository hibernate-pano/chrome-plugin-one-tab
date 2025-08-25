/**
 * 同步配置
 * 控制使用哪种同步机制
 */

/**
 * 同步机制类型
 */
export enum SyncMechanism {
  LEGACY = 'legacy',           // 原有的复杂同步机制
  SIMPLIFIED = 'simplified'    // 新的简化同步机制
}

/**
 * 同步配置接口
 */
export interface SyncConfig {
  // 当前使用的同步机制
  mechanism: SyncMechanism;
  
  // 是否启用渐进式迁移
  enableGradualMigration: boolean;
  
  // 是否启用同步性能监控
  enablePerformanceMonitoring: boolean;
  
  // 是否启用详细日志
  enableVerboseLogging: boolean;
  
  // 降级配置
  fallbackConfig: {
    // 简化同步失败时是否降级到原有机制
    enableFallback: boolean;
    
    // 降级触发的失败次数阈值
    failureThreshold: number;
    
    // 降级后的重试间隔（毫秒）
    retryInterval: number;
  };
}

/**
 * 默认同步配置
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  // 默认使用简化机制（可以通过环境变量覆盖）
  mechanism: process.env.NODE_ENV === 'development' 
    ? SyncMechanism.SIMPLIFIED 
    : SyncMechanism.LEGACY,
  
  enableGradualMigration: true,
  enablePerformanceMonitoring: process.env.NODE_ENV === 'development',
  enableVerboseLogging: process.env.NODE_ENV === 'development',
  
  fallbackConfig: {
    enableFallback: true,
    failureThreshold: 3,
    retryInterval: 5000
  }
};

/**
 * 当前同步配置（可在运行时修改）
 */
let currentSyncConfig: SyncConfig = { ...DEFAULT_SYNC_CONFIG };

/**
 * 获取当前同步配置
 */
export function getSyncConfig(): SyncConfig {
  return { ...currentSyncConfig };
}

/**
 * 更新同步配置
 */
export function updateSyncConfig(updates: Partial<SyncConfig>): void {
  currentSyncConfig = {
    ...currentSyncConfig,
    ...updates,
    fallbackConfig: {
      ...currentSyncConfig.fallbackConfig,
      ...(updates.fallbackConfig || {})
    }
  };
  
  console.log('🔧 同步配置已更新:', currentSyncConfig);
}

/**
 * 重置同步配置为默认值
 */
export function resetSyncConfig(): void {
  currentSyncConfig = { ...DEFAULT_SYNC_CONFIG };
  console.log('🔧 同步配置已重置为默认值');
}

/**
 * 检查是否应该使用简化同步机制
 */
export function shouldUseSimplifiedSync(): boolean {
  return currentSyncConfig.mechanism === SyncMechanism.SIMPLIFIED;
}

/**
 * 检查是否启用降级机制
 */
export function shouldEnableFallback(): boolean {
  return currentSyncConfig.fallbackConfig.enableFallback;
}

/**
 * 获取降级配置
 */
export function getFallbackConfig() {
  return currentSyncConfig.fallbackConfig;
}

/**
 * 性能监控配置
 */
export interface PerformanceMetrics {
  syncDuration: number;
  networkRequests: number;
  conflictsResolved: number;
  dataSize: number;
  timestamp: string;
}

/**
 * 同步性能监控器
 */
class SyncPerformanceMonitor {
  private metrics: PerformanceMetrics[] = [];
  private readonly MAX_METRICS = 100; // 最多保存100条记录

  /**
   * 记录性能指标
   */
  recordMetrics(metrics: PerformanceMetrics): void {
    if (!currentSyncConfig.enablePerformanceMonitoring) {
      return;
    }

    this.metrics.push(metrics);
    
    // 保持数组大小在限制内
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics.shift();
    }

    if (currentSyncConfig.enableVerboseLogging) {
      console.log('📊 同步性能指标:', metrics);
    }
  }

  /**
   * 获取性能统计
   */
  getPerformanceStats(): {
    averageDuration: number;
    totalRequests: number;
    totalConflicts: number;
    averageDataSize: number;
    recentMetrics: PerformanceMetrics[];
  } {
    if (this.metrics.length === 0) {
      return {
        averageDuration: 0,
        totalRequests: 0,
        totalConflicts: 0,
        averageDataSize: 0,
        recentMetrics: []
      };
    }

    const totalDuration = this.metrics.reduce((sum, m) => sum + m.syncDuration, 0);
    const totalRequests = this.metrics.reduce((sum, m) => sum + m.networkRequests, 0);
    const totalConflicts = this.metrics.reduce((sum, m) => sum + m.conflictsResolved, 0);
    const totalDataSize = this.metrics.reduce((sum, m) => sum + m.dataSize, 0);

    return {
      averageDuration: totalDuration / this.metrics.length,
      totalRequests,
      totalConflicts,
      averageDataSize: totalDataSize / this.metrics.length,
      recentMetrics: this.metrics.slice(-10) // 最近10条记录
    };
  }

  /**
   * 清除性能数据
   */
  clearMetrics(): void {
    this.metrics = [];
    console.log('📊 性能监控数据已清除');
  }
}

/**
 * 全局性能监控器实例
 */
export const syncPerformanceMonitor = new SyncPerformanceMonitor();

/**
 * 同步机制切换器
 */
export class SyncMechanismSwitcher {
  private failureCount = 0;
  private lastFailureTime = 0;

  /**
   * 记录同步失败
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    const config = getFallbackConfig();
    
    if (shouldEnableFallback() && 
        this.failureCount >= config.failureThreshold &&
        shouldUseSimplifiedSync()) {
      
      console.warn(`⚠️ 简化同步连续失败 ${this.failureCount} 次，切换到原有机制`);
      this.switchToLegacySync();
    }
  }

  /**
   * 记录同步成功
   */
  recordSuccess(): void {
    // 成功后重置失败计数
    this.failureCount = 0;
  }

  /**
   * 切换到原有同步机制
   */
  private switchToLegacySync(): void {
    updateSyncConfig({
      mechanism: SyncMechanism.LEGACY
    });
    
    // 设置定时器，一段时间后尝试切换回简化机制
    setTimeout(() => {
      this.attemptSwitchBack();
    }, getFallbackConfig().retryInterval);
  }

  /**
   * 尝试切换回简化机制
   */
  private attemptSwitchBack(): void {
    console.log('🔄 尝试切换回简化同步机制');
    
    updateSyncConfig({
      mechanism: SyncMechanism.SIMPLIFIED
    });
    
    // 重置失败计数
    this.failureCount = 0;
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    currentMechanism: SyncMechanism;
    failureCount: number;
    lastFailureTime: number;
  } {
    return {
      currentMechanism: currentSyncConfig.mechanism,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

/**
 * 全局同步机制切换器实例
 */
export const syncMechanismSwitcher = new SyncMechanismSwitcher();

/**
 * 开发者工具：手动切换同步机制
 */
export const devTools = {
  /**
   * 切换到简化同步机制
   */
  switchToSimplified(): void {
    updateSyncConfig({ mechanism: SyncMechanism.SIMPLIFIED });
  },

  /**
   * 切换到原有同步机制
   */
  switchToLegacy(): void {
    updateSyncConfig({ mechanism: SyncMechanism.LEGACY });
  },

  /**
   * 获取性能统计
   */
  getPerformanceStats() {
    return syncPerformanceMonitor.getPerformanceStats();
  },

  /**
   * 获取当前配置
   */
  getCurrentConfig() {
    return getSyncConfig();
  },

  /**
   * 重置所有配置
   */
  reset() {
    resetSyncConfig();
    syncPerformanceMonitor.clearMetrics();
  }
};

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).syncDevTools = devTools;
}
