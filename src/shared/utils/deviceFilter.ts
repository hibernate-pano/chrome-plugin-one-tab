/**
 * 增强的设备过滤器
 * 防止处理自己设备的变化，避免循环同步
 */

import { logger } from './logger';

/**
 * 设备信息接口
 */
export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  userAgent: string;
  createdAt: string;
  lastActiveAt: string;
}

/**
 * 实时事件载荷接口
 */
export interface RealtimePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new?: {
    id: string;
    device_id?: string;
    [key: string]: any;
  };
  old?: {
    id: string;
    device_id?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * 设备过滤结果
 */
export interface FilterResult {
  shouldProcess: boolean;
  reason: string;
  deviceId?: string;
  currentDeviceId?: string;
}

/**
 * 增强的设备过滤器类
 */
export class EnhancedDeviceFilter {
  private currentDeviceId: string | null = null;
  private deviceInfoCache: DeviceInfo | null = null;
  private readonly DEVICE_ID_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
  private lastDeviceIdFetch = 0;

  /**
   * 获取当前设备ID（带缓存）
   */
  async getCurrentDeviceId(): Promise<string> {
    const now = Date.now();
    
    // 检查缓存是否有效
    if (this.currentDeviceId && 
        (now - this.lastDeviceIdFetch) < this.DEVICE_ID_CACHE_TTL) {
      return this.currentDeviceId;
    }

    try {
      // 从Chrome存储获取设备ID
      const { deviceId, deviceIdBackup } = await chrome.storage.local.get([
        'deviceId', 
        'deviceIdBackup'
      ]);

      let finalDeviceId = deviceId;

      // 如果主设备ID不存在，尝试从备份恢复
      if (!finalDeviceId && deviceIdBackup) {
        logger.warn('主设备ID丢失，从备份恢复');
        finalDeviceId = deviceIdBackup;
        await chrome.storage.local.set({ deviceId: deviceIdBackup });
      }

      // 如果都不存在，生成新的设备ID
      if (!finalDeviceId) {
        finalDeviceId = await this.generateNewDeviceId();
        logger.warn('设备ID不存在，已生成新ID:', finalDeviceId);
      }

      // 更新缓存
      this.currentDeviceId = finalDeviceId;
      this.lastDeviceIdFetch = now;

      return finalDeviceId;

    } catch (error) {
      logger.error('获取设备ID失败:', error);
      
      // 返回基于时间戳的临时ID
      const fallbackId = `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      this.currentDeviceId = fallbackId;
      return fallbackId;
    }
  }

  /**
   * 生成新的设备ID
   */
  private async generateNewDeviceId(): Promise<string> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 15);
    const platform = this.getPlatformInfo();
    
    const newDeviceId = `${platform}_${timestamp}_${random}`;

    try {
      // 保存到Chrome存储（包含备份）
      await chrome.storage.local.set({
        deviceId: newDeviceId,
        deviceIdBackup: newDeviceId,
        deviceIdCreatedAt: new Date().toISOString()
      });

      logger.info('新设备ID已生成并保存:', newDeviceId);
      return newDeviceId;

    } catch (error) {
      logger.error('保存设备ID失败:', error);
      return newDeviceId;
    }
  }

  /**
   * 获取平台信息
   */
  private getPlatformInfo(): string {
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('chrome')) return 'chrome';
    if (userAgent.includes('firefox')) return 'firefox';
    if (userAgent.includes('safari')) return 'safari';
    if (userAgent.includes('edge')) return 'edge';
    
    return 'unknown';
  }

  /**
   * 过滤实时事件（主要方法）
   */
  async filterRealtimeEvent(payload: RealtimePayload): Promise<FilterResult> {
    try {
      const currentDeviceId = await this.getCurrentDeviceId();
      
      // 提取事件中的设备ID
      const eventDeviceId = this.extractDeviceIdFromPayload(payload);
      
      // 如果没有设备ID信息，允许处理（可能是旧数据）
      if (!eventDeviceId) {
        return {
          shouldProcess: true,
          reason: '事件中无设备ID信息，允许处理',
          currentDeviceId
        };
      }

      // 检查是否是自己设备的变化
      if (eventDeviceId === currentDeviceId) {
        return {
          shouldProcess: false,
          reason: '跳过自己设备的变化',
          deviceId: eventDeviceId,
          currentDeviceId
        };
      }

      // 额外的安全检查：检查设备ID格式
      if (!this.isValidDeviceId(eventDeviceId)) {
        logger.warn('检测到无效的设备ID格式:', eventDeviceId);
        return {
          shouldProcess: false,
          reason: '设备ID格式无效',
          deviceId: eventDeviceId,
          currentDeviceId
        };
      }

      // 通过所有检查，允许处理
      return {
        shouldProcess: true,
        reason: '来自其他设备的有效变化',
        deviceId: eventDeviceId,
        currentDeviceId
      };

    } catch (error) {
      logger.error('设备过滤失败:', error);
      
      // 出错时保守处理：不处理事件
      return {
        shouldProcess: false,
        reason: `设备过滤出错: ${error instanceof Error ? error.message : '未知错误'}`
      };
    }
  }

  /**
   * 从载荷中提取设备ID
   */
  private extractDeviceIdFromPayload(payload: RealtimePayload): string | null {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    // 对于删除事件，检查oldRecord；对于其他事件检查newRecord
    if (eventType === 'DELETE') {
      return oldRecord?.device_id || null;
    } else {
      return newRecord?.device_id || null;
    }
  }

  /**
   * 验证设备ID格式
   */
  private isValidDeviceId(deviceId: string): boolean {
    if (!deviceId || typeof deviceId !== 'string') {
      return false;
    }

    // 检查长度（设备ID应该有合理的长度）
    if (deviceId.length < 10 || deviceId.length > 100) {
      return false;
    }

    // 检查是否包含有效字符（字母、数字、下划线、连字符）
    const validPattern = /^[a-zA-Z0-9_-]+$/;
    if (!validPattern.test(deviceId)) {
      return false;
    }

    return true;
  }

  /**
   * 获取设备信息（带缓存）
   */
  async getDeviceInfo(): Promise<DeviceInfo> {
    if (this.deviceInfoCache) {
      return this.deviceInfoCache;
    }

    const deviceId = await this.getCurrentDeviceId();
    const userAgent = navigator.userAgent;
    const platform = this.getPlatformInfo();

    this.deviceInfoCache = {
      id: deviceId,
      name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Browser`,
      platform,
      userAgent,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString()
    };

    return this.deviceInfoCache;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.currentDeviceId = null;
    this.deviceInfoCache = null;
    this.lastDeviceIdFetch = 0;
    logger.debug('设备过滤器缓存已清除');
  }

  /**
   * 强制刷新设备ID
   */
  async refreshDeviceId(): Promise<string> {
    this.clearCache();
    return await this.getCurrentDeviceId();
  }

  /**
   * 获取过滤统计信息
   */
  getFilterStats(): {
    currentDeviceId: string | null;
    cacheAge: number;
    lastFetchTime: number;
  } {
    return {
      currentDeviceId: this.currentDeviceId,
      cacheAge: this.lastDeviceIdFetch ? Date.now() - this.lastDeviceIdFetch : 0,
      lastFetchTime: this.lastDeviceIdFetch
    };
  }
}

/**
 * 全局设备过滤器实例
 */
export const deviceFilter = new EnhancedDeviceFilter();

/**
 * 便捷函数：检查是否应该处理实时事件
 */
export async function shouldProcessRealtimeEvent(payload: RealtimePayload): Promise<boolean> {
  const result = await deviceFilter.filterRealtimeEvent(payload);
  
  if (result.shouldProcess) {
    logger.debug('✅ 实时事件通过过滤:', result.reason);
  } else {
    logger.debug('⏭️ 实时事件被过滤:', result.reason);
  }
  
  return result.shouldProcess;
}

/**
 * 便捷函数：获取当前设备ID
 */
export async function getCurrentDeviceId(): Promise<string> {
  return await deviceFilter.getCurrentDeviceId();
}

/**
 * 便捷函数：刷新设备ID缓存
 */
export async function refreshDeviceId(): Promise<string> {
  return await deviceFilter.refreshDeviceId();
}
