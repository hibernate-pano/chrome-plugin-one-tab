/**
 * 网络状态管理器
 * 监控网络连接状态，处理网络异常和重连逻辑
 */

import { logger } from './logger';

/**
 * 网络状态枚举
 */
export enum NetworkStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  UNSTABLE = 'unstable',
  SLOW = 'slow'
}

/**
 * 网络质量等级
 */
export enum NetworkQuality {
  EXCELLENT = 'excellent',
  GOOD = 'good', 
  FAIR = 'fair',
  POOR = 'poor'
}

/**
 * 网络信息接口
 */
export interface NetworkInfo {
  status: NetworkStatus;
  quality: NetworkQuality;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  timestamp: string;
}

/**
 * 重连配置
 */
export interface ReconnectConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitterRange: number;
}

/**
 * 网络事件监听器
 */
export type NetworkEventListener = (networkInfo: NetworkInfo) => void;

/**
 * 网络状态管理器类
 */
export class NetworkManager {
  private currentStatus: NetworkStatus = NetworkStatus.ONLINE;
  private currentQuality: NetworkQuality = NetworkQuality.GOOD;
  private listeners: Set<NetworkEventListener> = new Set();
  private reconnectConfig: ReconnectConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30秒健康检查
  private readonly QUALITY_CHECK_INTERVAL = 10000; // 10秒质量检查
  private lastHealthCheck = 0;
  private consecutiveFailures = 0;

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.reconnectConfig = {
      maxAttempts: 5,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitterRange: 0.1,
      ...config
    };

    this.initialize();
  }

  /**
   * 初始化网络管理器
   */
  private initialize(): void {
    // 监听网络状态变化
    window.addEventListener('online', this.handleOnline.bind(this));
    window.addEventListener('offline', this.handleOffline.bind(this));

    // 监听网络连接变化（如果支持）
    if ('connection' in navigator) {
      const connection = (navigator as any).connection;
      connection.addEventListener('change', this.handleConnectionChange.bind(this));
    }

    // 初始状态检查
    this.updateNetworkInfo();

    // 启动健康检查
    this.startHealthCheck();

    logger.info('网络管理器已初始化', {
      initialStatus: this.currentStatus,
      initialQuality: this.currentQuality
    });
  }

  /**
   * 获取当前网络信息
   */
  getNetworkInfo(): NetworkInfo {
    return {
      status: this.currentStatus,
      quality: this.currentQuality,
      effectiveType: this.getEffectiveType(),
      downlink: this.getDownlink(),
      rtt: this.getRTT(),
      saveData: this.getSaveData(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 检查网络是否可用
   */
  isOnline(): boolean {
    return this.currentStatus === NetworkStatus.ONLINE;
  }

  /**
   * 检查网络质量是否良好
   */
  isQualityGood(): boolean {
    return this.currentQuality === NetworkQuality.EXCELLENT || 
           this.currentQuality === NetworkQuality.GOOD;
  }

  /**
   * 添加网络状态监听器
   */
  addListener(listener: NetworkEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * 移除网络状态监听器
   */
  removeListener(listener: NetworkEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * 执行网络健康检查
   */
  async performHealthCheck(): Promise<boolean> {
    try {
      const startTime = Date.now();
      
      // 使用fetch进行健康检查
      const response = await fetch('/favicon.ico', {
        method: 'HEAD',
        cache: 'no-cache',
        signal: AbortSignal.timeout(5000) // 5秒超时
      });

      const endTime = Date.now();
      const rtt = endTime - startTime;

      if (response.ok) {
        this.consecutiveFailures = 0;
        this.lastHealthCheck = Date.now();
        
        // 根据响应时间更新网络质量
        this.updateQualityByRTT(rtt);
        
        if (this.currentStatus !== NetworkStatus.ONLINE) {
          this.handleNetworkRecovery();
        }
        
        return true;
      } else {
        this.handleHealthCheckFailure();
        return false;
      }

    } catch (error) {
      logger.warn('网络健康检查失败:', error);
      this.handleHealthCheckFailure();
      return false;
    }
  }

  /**
   * 开始重连尝试
   */
  startReconnection(): void {
    if (this.reconnectTimer) {
      return; // 已经在重连中
    }

    this.reconnectAttempts = 0;
    this.scheduleReconnect();
  }

  /**
   * 停止重连尝试
   */
  stopReconnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  /**
   * 销毁网络管理器
   */
  destroy(): void {
    // 移除事件监听器
    window.removeEventListener('online', this.handleOnline.bind(this));
    window.removeEventListener('offline', this.handleOffline.bind(this));

    if ('connection' in navigator) {
      const connection = (navigator as any).connection;
      connection.removeEventListener('change', this.handleConnectionChange.bind(this));
    }

    // 清理定时器
    this.stopReconnection();
    this.stopHealthCheck();

    // 清理监听器
    this.listeners.clear();

    logger.info('网络管理器已销毁');
  }

  /**
   * 处理在线事件
   */
  private handleOnline(): void {
    logger.info('网络连接已恢复');
    this.updateNetworkStatus(NetworkStatus.ONLINE);
    this.stopReconnection();
    this.performHealthCheck();
  }

  /**
   * 处理离线事件
   */
  private handleOffline(): void {
    logger.warn('网络连接已断开');
    this.updateNetworkStatus(NetworkStatus.OFFLINE);
    this.startReconnection();
  }

  /**
   * 处理连接变化事件
   */
  private handleConnectionChange(): void {
    logger.debug('网络连接信息发生变化');
    this.updateNetworkInfo();
  }

  /**
   * 更新网络信息
   */
  private updateNetworkInfo(): void {
    const wasOnline = this.isOnline();
    
    // 更新状态
    if (navigator.onLine) {
      this.currentStatus = NetworkStatus.ONLINE;
    } else {
      this.currentStatus = NetworkStatus.OFFLINE;
    }

    // 更新质量
    this.updateNetworkQuality();

    // 如果状态发生变化，通知监听器
    if (wasOnline !== this.isOnline()) {
      this.notifyListeners();
    }
  }

  /**
   * 更新网络质量
   */
  private updateNetworkQuality(): void {
    const connection = (navigator as any).connection;
    if (!connection) {
      this.currentQuality = NetworkQuality.GOOD;
      return;
    }

    const effectiveType = connection.effectiveType;
    const downlink = connection.downlink;
    const rtt = connection.rtt;

    // 根据有效类型判断质量
    switch (effectiveType) {
      case 'slow-2g':
        this.currentQuality = NetworkQuality.POOR;
        break;
      case '2g':
        this.currentQuality = NetworkQuality.POOR;
        break;
      case '3g':
        this.currentQuality = NetworkQuality.FAIR;
        break;
      case '4g':
        this.currentQuality = NetworkQuality.GOOD;
        break;
      default:
        this.currentQuality = NetworkQuality.EXCELLENT;
    }

    // 根据下行速度和RTT进行微调
    if (downlink && rtt) {
      if (downlink < 0.5 || rtt > 2000) {
        this.currentQuality = NetworkQuality.POOR;
      } else if (downlink < 1.5 || rtt > 1000) {
        this.currentQuality = NetworkQuality.FAIR;
      } else if (downlink > 10 && rtt < 100) {
        this.currentQuality = NetworkQuality.EXCELLENT;
      }
    }
  }

  /**
   * 根据RTT更新网络质量
   */
  private updateQualityByRTT(rtt: number): void {
    if (rtt < 100) {
      this.currentQuality = NetworkQuality.EXCELLENT;
    } else if (rtt < 300) {
      this.currentQuality = NetworkQuality.GOOD;
    } else if (rtt < 1000) {
      this.currentQuality = NetworkQuality.FAIR;
    } else {
      this.currentQuality = NetworkQuality.POOR;
    }
  }

  /**
   * 更新网络状态
   */
  private updateNetworkStatus(status: NetworkStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.notifyListeners();
    }
  }

  /**
   * 处理网络恢复
   */
  private handleNetworkRecovery(): void {
    logger.info('网络连接已恢复');
    this.updateNetworkStatus(NetworkStatus.ONLINE);
    this.stopReconnection();
  }

  /**
   * 处理健康检查失败
   */
  private handleHealthCheckFailure(): void {
    this.consecutiveFailures++;
    
    if (this.consecutiveFailures >= 3) {
      if (this.currentStatus === NetworkStatus.ONLINE) {
        this.updateNetworkStatus(NetworkStatus.UNSTABLE);
      }
    }

    if (this.consecutiveFailures >= 5) {
      this.updateNetworkStatus(NetworkStatus.OFFLINE);
      this.startReconnection();
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
      logger.error('重连尝试次数已达上限，停止重连');
      return;
    }

    const delay = this.calculateReconnectDelay();
    
    logger.info(`安排第 ${this.reconnectAttempts + 1} 次重连，延迟 ${delay}ms`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempts++;
      
      const success = await this.performHealthCheck();
      if (success) {
        logger.info('重连成功');
        this.stopReconnection();
      } else {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * 计算重连延迟
   */
  private calculateReconnectDelay(): number {
    const { baseDelay, maxDelay, backoffMultiplier, jitterRange } = this.reconnectConfig;
    
    // 指数退避
    let delay = baseDelay * Math.pow(backoffMultiplier, this.reconnectAttempts);
    
    // 限制最大延迟
    delay = Math.min(delay, maxDelay);
    
    // 添加抖动
    const jitter = delay * jitterRange * (Math.random() * 2 - 1);
    delay += jitter;
    
    return Math.max(delay, baseDelay);
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * 停止健康检查
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 通知监听器
   */
  private notifyListeners(): void {
    const networkInfo = this.getNetworkInfo();
    this.listeners.forEach(listener => {
      try {
        listener(networkInfo);
      } catch (error) {
        logger.error('网络状态监听器执行失败:', error);
      }
    });
  }

  /**
   * 获取网络连接的有效类型
   */
  private getEffectiveType(): string | undefined {
    const connection = (navigator as any).connection;
    return connection?.effectiveType;
  }

  /**
   * 获取下行速度
   */
  private getDownlink(): number | undefined {
    const connection = (navigator as any).connection;
    return connection?.downlink;
  }

  /**
   * 获取RTT
   */
  private getRTT(): number | undefined {
    const connection = (navigator as any).connection;
    return connection?.rtt;
  }

  /**
   * 获取省流量模式状态
   */
  private getSaveData(): boolean | undefined {
    const connection = (navigator as any).connection;
    return connection?.saveData;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    currentStatus: NetworkStatus;
    currentQuality: NetworkQuality;
    reconnectAttempts: number;
    consecutiveFailures: number;
    lastHealthCheck: number;
    listenersCount: number;
  } {
    return {
      currentStatus: this.currentStatus,
      currentQuality: this.currentQuality,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveFailures: this.consecutiveFailures,
      lastHealthCheck: this.lastHealthCheck,
      listenersCount: this.listeners.size
    };
  }
}

/**
 * 全局网络管理器实例
 */
export const networkManager = new NetworkManager();

/**
 * 便捷函数
 */
export function isNetworkOnline(): boolean {
  return networkManager.isOnline();
}

export function getNetworkQuality(): NetworkQuality {
  return networkManager.getNetworkInfo().quality;
}

export function addNetworkListener(listener: NetworkEventListener): void {
  networkManager.addListener(listener);
}

export function removeNetworkListener(listener: NetworkEventListener): void {
  networkManager.removeListener(listener);
}
