/**
 * 共享工具类导出
 */
export { logger } from './logger';
export { errorHandler } from './errorHandler';
export { storage } from './storage';
export { performanceOptimizer, createMemoComparison } from './performanceOptimizer';
export { memoryManager, MemoryManager } from './memoryManager';
export { renderStatsManager, generateRenderOptimizationReport } from './renderOptimizer';
export { SmartCache, CacheStrategy } from './smartCache';

// 导出类型
export type { MemoryStats, MemoryMonitorConfig, CacheItem, CacheConfig } from './memoryManager';
export type { RenderStats, RenderMonitorConfig } from './renderOptimizer';
export type { SmartCacheItem, SmartCacheConfig, CacheMetrics } from './smartCache';
