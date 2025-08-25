/**
 * 类型安全的事件系统定义
 * 提供强类型的事件发布订阅机制
 */

import { BaseEvent } from './common';

/**
 * 事件映射接口
 * 定义所有可能的事件类型和其对应的数据结构
 */
export interface EventMap {
  // 标签相关事件
  'tab:created': { tab: any; groupId?: string };
  'tab:updated': { tab: any; changes: Record<string, any> };
  'tab:deleted': { tabId: string; groupId?: string };
  'tab:moved': { tabId: string; fromGroupId: string; toGroupId: string };
  'tab:opened': { tab: any };
  'tab:closed': { tabId: string };
  
  // 标签组相关事件
  'group:created': { group: any };
  'group:updated': { group: any; changes: Record<string, any> };
  'group:deleted': { groupId: string; tabCount: number };
  'group:renamed': { groupId: string; oldName: string; newName: string };
  'group:locked': { groupId: string; locked: boolean };
  'group:merged': { sourceGroupId: string; targetGroupId: string };
  
  // 同步相关事件
  'sync:started': { operation: string; timestamp: string };
  'sync:completed': { operation: string; result: any; duration: number };
  'sync:failed': { operation: string; error: Error; retryCount: number };
  'sync:conflict': { conflictId: string; type: string; data: any };
  'sync:resolved': { conflictId: string; resolution: string };
  
  // 认证相关事件
  'auth:login': { userId: string; provider: string; timestamp: string };
  'auth:logout': { userId: string; reason: string };
  'auth:session-expired': { sessionId: string; userId: string };
  'auth:token-refreshed': { userId: string; expiresAt: string };
  'auth:error': { error: Error; context: string };
  
  // 用户界面事件
  'ui:theme-changed': { theme: string; previousTheme: string };
  'ui:language-changed': { language: string; previousLanguage: string };
  'ui:layout-changed': { layout: string; previousLayout: string };
  'ui:modal-opened': { modalId: string; context?: any };
  'ui:modal-closed': { modalId: string; result?: any };
  'ui:notification-shown': { type: string; message: string; duration?: number };
  
  // 搜索相关事件
  'search:query-changed': { query: string; filters?: Record<string, any> };
  'search:results-updated': { query: string; results: any[]; count: number };
  'search:history-added': { query: string; timestamp: string };
  'search:filter-applied': { filter: string; value: any };
  
  // 导入导出事件
  'import:started': { format: string; fileSize: number };
  'import:progress': { progress: number; processed: number; total: number };
  'import:completed': { format: string; imported: number; errors: number };
  'import:failed': { format: string; error: Error };
  'export:started': { format: string; itemCount: number };
  'export:completed': { format: string; fileSize: number; downloadUrl?: string };
  'export:failed': { format: string; error: Error };
  
  // 性能相关事件
  'performance:memory-warning': { usage: number; threshold: number };
  'performance:slow-operation': { operation: string; duration: number };
  'performance:render-time': { component: string; renderTime: number };
  
  // 错误相关事件
  'error:unhandled': { error: Error; context: string; timestamp: string };
  'error:network': { error: Error; url: string; method: string };
  'error:validation': { field: string; value: any; rule: string };
  'error:permission': { action: string; resource: string; userId: string };
  
  // 设置相关事件
  'settings:updated': { key: string; value: any; previousValue: any };
  'settings:reset': { section: string; timestamp: string };
  'settings:imported': { source: string; settingsCount: number };
  'settings:exported': { format: string; settingsCount: number };
  
  // 扩展相关事件
  'extension:installed': { version: string; timestamp: string };
  'extension:updated': { oldVersion: string; newVersion: string };
  'extension:enabled': { timestamp: string };
  'extension:disabled': { reason: string; timestamp: string };
  'extension:command': { command: string; args?: any[] };
  
  // 通用事件
  'app:ready': { version: string; timestamp: string };
  'app:shutdown': { reason: string; timestamp: string };
  'app:focus': { timestamp: string };
  'app:blur': { timestamp: string };
}

/**
 * 类型安全的事件接口
 */
export interface TypedEvent<K extends keyof EventMap> extends BaseEvent {
  type: K;
  data: EventMap[K];
}

/**
 * 事件监听器类型
 */
export type EventListener<K extends keyof EventMap> = (event: TypedEvent<K>) => void | Promise<void>;

/**
 * 事件发射器接口
 */
export interface TypedEventEmitter {
  // 监听事件
  on<K extends keyof EventMap>(eventType: K, listener: EventListener<K>): () => void;
  
  // 监听一次事件
  once<K extends keyof EventMap>(eventType: K, listener: EventListener<K>): () => void;
  
  // 移除监听器
  off<K extends keyof EventMap>(eventType: K, listener: EventListener<K>): void;
  
  // 发射事件
  emit<K extends keyof EventMap>(eventType: K, data: EventMap[K]): void;
  
  // 移除所有监听器
  removeAllListeners<K extends keyof EventMap>(eventType?: K): void;
  
  // 获取监听器数量
  listenerCount<K extends keyof EventMap>(eventType: K): number;
  
  // 获取所有事件类型
  eventNames(): (keyof EventMap)[];
}

/**
 * 事件中间件类型
 */
export type EventMiddleware<K extends keyof EventMap = keyof EventMap> = (
  event: TypedEvent<K>,
  next: () => void
) => void | Promise<void>;

/**
 * 事件过滤器类型
 */
export type EventFilter<K extends keyof EventMap> = (event: TypedEvent<K>) => boolean;

/**
 * 事件转换器类型
 */
export type EventTransformer<K extends keyof EventMap, R extends keyof EventMap> = (
  event: TypedEvent<K>
) => TypedEvent<R> | null;

/**
 * 批量事件接口
 */
export interface BatchEvent {
  id: string;
  events: TypedEvent<keyof EventMap>[];
  timestamp: string;
  metadata?: Record<string, any>;
}

/**
 * 事件存储接口
 */
export interface EventStore {
  // 保存事件
  save<K extends keyof EventMap>(event: TypedEvent<K>): Promise<void>;
  
  // 批量保存事件
  saveBatch(events: TypedEvent<keyof EventMap>[]): Promise<void>;
  
  // 查询事件
  query<K extends keyof EventMap>(
    eventType: K,
    filter?: EventFilter<K>,
    options?: {
      limit?: number;
      offset?: number;
      startTime?: string;
      endTime?: string;
    }
  ): Promise<TypedEvent<K>[]>;
  
  // 获取事件流
  getStream<K extends keyof EventMap>(
    eventType: K,
    fromTimestamp?: string
  ): AsyncIterable<TypedEvent<K>>;
  
  // 清理旧事件
  cleanup(beforeTimestamp: string): Promise<number>;
}

/**
 * 事件聚合器接口
 */
export interface EventAggregator {
  // 聚合事件
  aggregate<K extends keyof EventMap>(
    eventType: K,
    aggregator: (events: TypedEvent<K>[]) => any,
    timeWindow: number
  ): Promise<any>;
  
  // 计算事件统计
  getStatistics<K extends keyof EventMap>(
    eventType: K,
    timeRange: { start: string; end: string }
  ): Promise<{
    count: number;
    frequency: number;
    averageInterval: number;
  }>;
}

/**
 * 事件重放器接口
 */
export interface EventReplayer {
  // 重放事件
  replay<K extends keyof EventMap>(
    events: TypedEvent<K>[],
    options?: {
      speed?: number;
      filter?: EventFilter<K>;
      transform?: EventTransformer<K, keyof EventMap>;
    }
  ): Promise<void>;
  
  // 重放到指定时间点
  replayTo(timestamp: string): Promise<void>;
}

/**
 * 事件调试器接口
 */
export interface EventDebugger {
  // 开始调试
  startDebugging<K extends keyof EventMap>(eventType?: K): void;
  
  // 停止调试
  stopDebugging(): void;
  
  // 获取调试信息
  getDebugInfo(): {
    totalEvents: number;
    eventsByType: Record<string, number>;
    averageProcessingTime: number;
    errors: Error[];
  };
  
  // 导出调试日志
  exportDebugLog(): string;
}

/**
 * 事件性能监控接口
 */
export interface EventPerformanceMonitor {
  // 开始监控
  startMonitoring(): void;
  
  // 停止监控
  stopMonitoring(): void;
  
  // 获取性能指标
  getMetrics(): {
    eventsPerSecond: number;
    averageProcessingTime: number;
    memoryUsage: number;
    slowEvents: Array<{
      type: string;
      processingTime: number;
      timestamp: string;
    }>;
  };
  
  // 设置性能阈值
  setThresholds(thresholds: {
    maxProcessingTime?: number;
    maxEventsPerSecond?: number;
    maxMemoryUsage?: number;
  }): void;
}

/**
 * 事件配置接口
 */
export interface EventConfig {
  // 最大监听器数量
  maxListeners?: number;
  
  // 是否启用调试
  debug?: boolean;
  
  // 是否启用性能监控
  enablePerformanceMonitoring?: boolean;
  
  // 事件存储配置
  storage?: {
    enabled: boolean;
    maxEvents?: number;
    ttl?: number; // 事件生存时间（毫秒）
  };
  
  // 批处理配置
  batching?: {
    enabled: boolean;
    batchSize?: number;
    flushInterval?: number; // 毫秒
  };
  
  // 错误处理配置
  errorHandling?: {
    continueOnError: boolean;
    maxRetries?: number;
    retryDelay?: number;
  };
}

/**
 * 事件总线接口
 * 整合所有事件相关功能的主接口
 */
export interface EventBus extends TypedEventEmitter {
  // 配置事件总线
  configure(config: EventConfig): void;
  
  // 添加中间件
  use(middleware: EventMiddleware): void;
  
  // 获取事件存储
  getStore(): EventStore | null;
  
  // 获取性能监控器
  getPerformanceMonitor(): EventPerformanceMonitor | null;
  
  // 获取调试器
  getDebugger(): EventDebugger | null;
  
  // 销毁事件总线
  destroy(): void;
}
