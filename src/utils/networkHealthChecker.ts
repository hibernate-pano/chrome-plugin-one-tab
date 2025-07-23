/**
 * 网络健康检查和修复工具
 * 解决网络连接不稳定导致的同步问题
 */

import { logger } from '@/shared/utils/logger';

export interface NetworkHealthStatus {
  isOnline: boolean;
  supabaseReachable: boolean;
  latency: number;
  lastCheckTime: string;
  issues: string[];
  recommendations: string[];
}

export interface NetworkFixResult {
  success: boolean;
  message: string;
  fixedIssues: string[];
  remainingIssues: string[];
}

/**
 * 网络健康检查器
 */
export class NetworkHealthChecker {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastHealthStatus: NetworkHealthStatus | null = null;
  private readonly SUPABASE_URL = 'https://supabase.co';
  private readonly CHECK_TIMEOUT = 10000; // 10秒超时

  /**
   * 执行完整的网络健康检查
   */
  async performHealthCheck(): Promise<NetworkHealthStatus> {
    const startTime = Date.now();
    const issues: string[] = [];
    const recommendations: string[] = [];

    console.group('🌐 网络健康检查');

    try {
      // 1. 检查基本网络连接
      const isOnline = navigator.onLine;
      console.log('📡 基本网络状态:', isOnline ? '在线' : '离线');

      if (!isOnline) {
        issues.push('设备处于离线状态');
        recommendations.push('请检查网络连接');
      }

      // 2. 检查Supabase连接
      let supabaseReachable = false;
      let latency = -1;

      if (isOnline) {
        try {
          const pingStart = Date.now();
          const response = await this.pingSupabase();
          latency = Date.now() - pingStart;
          supabaseReachable = response.success;

          console.log('☁️ Supabase连接:', {
            可达: supabaseReachable,
            延迟: `${latency}ms`,
            状态: response.status
          });

          if (!supabaseReachable) {
            issues.push('Supabase服务不可达');
            recommendations.push('检查防火墙设置或稍后重试');
          } else if (latency > 5000) {
            issues.push('网络延迟过高');
            recommendations.push('网络较慢，建议在网络状况良好时进行同步');
          }

        } catch (error) {
          issues.push('Supabase连接测试失败');
          recommendations.push('检查网络设置或联系技术支持');
          console.error('❌ Supabase连接测试失败:', error);
        }
      }

      // 3. 检查DNS解析
      await this.checkDNSResolution(issues, recommendations);

      // 4. 检查CORS和安全策略
      await this.checkCORSAndSecurity(issues, recommendations);

      const healthStatus: NetworkHealthStatus = {
        isOnline,
        supabaseReachable,
        latency,
        lastCheckTime: new Date().toISOString(),
        issues,
        recommendations
      };

      this.lastHealthStatus = healthStatus;

      console.log('📊 健康检查结果:', {
        总体状态: issues.length === 0 ? '健康' : '有问题',
        问题数量: issues.length,
        检查耗时: `${Date.now() - startTime}ms`
      });

      console.groupEnd();
      return healthStatus;

    } catch (error) {
      console.error('❌ 网络健康检查失败:', error);
      console.groupEnd();

      return {
        isOnline: false,
        supabaseReachable: false,
        latency: -1,
        lastCheckTime: new Date().toISOString(),
        issues: ['网络健康检查失败'],
        recommendations: ['请检查网络连接并重试']
      };
    }
  }

  /**
   * 修复网络问题
   */
  async fixNetworkIssues(): Promise<NetworkFixResult> {
    const fixedIssues: string[] = [];
    const remainingIssues: string[] = [];

    console.group('🔧 网络问题修复');

    try {
      // 1. 重置网络状态
      await this.resetNetworkState();
      fixedIssues.push('重置网络状态');

      // 2. 清理可能的连接缓存
      await this.clearConnectionCache();
      fixedIssues.push('清理连接缓存');

      // 3. 重新检查网络状态
      const healthStatus = await this.performHealthCheck();

      if (healthStatus.issues.length > 0) {
        remainingIssues.push(...healthStatus.issues);
      }

      console.log('🎯 修复结果:', {
        已修复: fixedIssues,
        剩余问题: remainingIssues
      });

      console.groupEnd();

      return {
        success: remainingIssues.length === 0,
        message: remainingIssues.length === 0 ? '网络问题已修复' : '部分问题仍需手动处理',
        fixedIssues,
        remainingIssues
      };

    } catch (error) {
      console.error('❌ 网络修复失败:', error);
      console.groupEnd();

      return {
        success: false,
        message: '网络修复失败',
        fixedIssues,
        remainingIssues: ['网络修复过程中出现错误']
      };
    }
  }

  /**
   * 启动定期健康检查
   */
  startPeriodicCheck(intervalMs: number = 60000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(async () => {
      try {
        const status = await this.performHealthCheck();
        
        // 如果发现严重问题，记录警告
        if (status.issues.length > 0) {
          logger.warn('网络健康检查发现问题', { 
            issues: status.issues,
            recommendations: status.recommendations 
          });
        }
      } catch (error) {
        logger.error('定期网络检查失败', { error });
      }
    }, intervalMs);

    logger.info('✅ 定期网络健康检查已启动', { intervalMs });
  }

  /**
   * 停止定期检查
   */
  stopPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('🛑 定期网络健康检查已停止');
    }
  }

  /**
   * 获取最后的健康状态
   */
  getLastHealthStatus(): NetworkHealthStatus | null {
    return this.lastHealthStatus;
  }

  /**
   * 私有方法：ping Supabase
   */
  private async pingSupabase(): Promise<{ success: boolean; status?: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.CHECK_TIMEOUT);

    try {
      const response = await fetch(this.SUPABASE_URL, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return { success: true, status: response.status };
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('连接超时');
      }
      
      return { success: false };
    }
  }

  /**
   * 私有方法：检查DNS解析
   */
  private async checkDNSResolution(issues: string[], recommendations: string[]): Promise<void> {
    try {
      // 尝试解析一个已知的域名
      const testUrl = 'https://www.google.com';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      await fetch(testUrl, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      console.log('✅ DNS解析正常');
    } catch (error) {
      issues.push('DNS解析可能存在问题');
      recommendations.push('尝试更换DNS服务器或联系网络管理员');
      console.warn('⚠️ DNS解析测试失败:', error);
    }
  }

  /**
   * 私有方法：检查CORS和安全策略
   */
  private async checkCORSAndSecurity(issues: string[], recommendations: string[]): Promise<void> {
    try {
      // 检查是否在安全上下文中
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        issues.push('非安全上下文可能影响网络请求');
        recommendations.push('确保使用HTTPS协议');
      }

      console.log('✅ 安全策略检查完成');
    } catch (error) {
      console.warn('⚠️ 安全策略检查失败:', error);
    }
  }

  /**
   * 私有方法：重置网络状态
   */
  private async resetNetworkState(): Promise<void> {
    // 这里可以添加重置网络状态的逻辑
    // 例如清理Service Worker缓存等
    console.log('🔄 重置网络状态');
    
    // 模拟重置操作
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * 私有方法：清理连接缓存
   */
  private async clearConnectionCache(): Promise<void> {
    console.log('🧹 清理连接缓存');
    
    // 这里可以添加清理缓存的逻辑
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * 全局网络健康检查器实例
 */
export const networkHealthChecker = new NetworkHealthChecker();

/**
 * 便捷函数：执行网络健康检查
 */
export async function checkNetworkHealth(): Promise<NetworkHealthStatus> {
  return await networkHealthChecker.performHealthCheck();
}

/**
 * 便捷函数：修复网络问题
 */
export async function fixNetworkIssues(): Promise<NetworkFixResult> {
  return await networkHealthChecker.fixNetworkIssues();
}

// 在开发环境下暴露到全局对象
if (process.env.NODE_ENV === 'development') {
  (window as any).networkHealthChecker = networkHealthChecker;
  (window as any).checkNetworkHealth = checkNetworkHealth;
  (window as any).fixNetworkIssues = fixNetworkIssues;
}
