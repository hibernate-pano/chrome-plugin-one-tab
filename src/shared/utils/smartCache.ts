import { logger } from './logger';
import { memoryManager } from './memoryManager';

/**
 * 缓存策略枚举
 */
export enum CacheStrategy {
  LRU = 'lru', // 最近最少使用
  LFU = 'lfu', // 最少使用频率
  FIFO = 'fifo', // 先进先出
  TTL = 'ttl', // 基于时间
  ADAPTIVE = 'adaptive' // 自适应
}

/**
 * 缓存项接口
 */
export interface SmartCacheItem<T> {
  key: string;
  value: T;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  size: number;
  priority: number;
  ttl?: number;
  tags: string[];
  metadata: Record<string, any>;
}

/**
 * 缓存配置接口
 */
export interface SmartCacheConfig {
  maxSize: number; // 最大项目数
  maxMemory: number; // 最大内存使用 (bytes)
  strategy: CacheStrategy;
  defaultTTL: number; // 默认生存时间 (ms)
  cleanupInterval: number; // 清理间隔 (ms)
  compressionThreshold: number; // 压缩阈值 (bytes)
  enableCompression: boolean;
  enablePersistence: boolean;
  persistenceKey?: string;
  enableMetrics: boolean;
}

/**
 * 缓存统计接口
 */
export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  totalRequests: number;
  totalSize: number;
  totalMemory: number;
  itemCount: number;
  averageAccessTime: number;
  compressionRatio: number;
}

/**
 * 智能缓存管理器
 * 提供高级缓存功能，包括多种缓存策略、压缩、持久化等
 */
export class SmartCache<T = any> {
  private items = new Map<string, SmartCacheItem<T>>();
  private accessOrder: string[] = []; // LRU使用
  private accessFrequency = new Map<string, number>(); // LFU使用
  private insertionOrder: string[] = []; // FIFO使用
  private cleanupTimer?: NodeJS.Timeout;
  private metrics: CacheMetrics;
  private config: SmartCacheConfig;

  constructor(config: Partial<SmartCacheConfig> = {}) {
    this.config = {
      maxSize: 1000,
      maxMemory: 50 * 1024 * 1024, // 50MB
      strategy: CacheStrategy.ADAPTIVE,
      defaultTTL: 30 * 60 * 1000, // 30分钟
      cleanupInterval: 5 * 60 * 1000, // 5分钟
      compressionThreshold: 1024, // 1KB
      enableCompression: true,
      enablePersistence: false,
      enableMetrics: true,
      ...config
    };

    this.metrics = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalRequests: 0,
      totalSize: 0,
      totalMemory: 0,
      itemCount: 0,
      averageAccessTime: 0,
      compressionRatio: 1
    };

    this.startCleanupTimer();
    this.loadFromPersistence();
  }

  /**
   * 设置缓存项
   */
  async set(
    key: string, 
    value: T, 
    options: {
      ttl?: number;
      priority?: number;
      tags?: string[];
      metadata?: Record<string, any>;
    } = {}
  ): Promise<void> {
    const {
      ttl = this.config.defaultTTL,
      priority = 1,
      tags = [],
      metadata = {}
    } = options;

    const now = Date.now();
    const serializedValue = await this.serializeValue(value);
    const size = this.calculateSize(serializedValue);

    const item: SmartCacheItem<T> = {
      key,
      value: serializedValue,
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      size,
      priority,
      ttl,
      tags,
      metadata
    };

    // 检查是否需要压缩
    if (this.config.enableCompression && size > this.config.compressionThreshold) {
      item.value = await this.compressValue(serializedValue);
      item.metadata.compressed = true;
    }

    // 添加到缓存
    this.items.set(key, item);
    this.updateAccessStructures(key);

    // 更新统计
    this.updateMetrics();

    // 检查缓存限制
    await this.enforceLimits();

    // 持久化
    if (this.config.enablePersistence) {
      this.saveToPersistence();
    }

    logger.debug(`缓存项已设置: ${key}`, { size, compressed: item.metadata.compressed });
  }

  /**
   * 获取缓存项
   */
  async get(key: string): Promise<T | null> {
    const startTime = performance.now();
    
    this.metrics.totalRequests++;

    const item = this.items.get(key);
    
    if (!item) {
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    // 检查TTL
    if (item.ttl && Date.now() - item.timestamp > item.ttl) {
      this.delete(key);
      this.metrics.misses++;
      this.updateHitRate();
      return null;
    }

    // 更新访问信息
    item.lastAccessed = Date.now();
    item.accessCount++;
    this.updateAccessStructures(key);

    // 解压缩和反序列化
    let value = item.value;
    if (item.metadata.compressed) {
      value = await this.decompressValue(value);
    }
    const deserializedValue = await this.deserializeValue(value);

    // 更新统计
    this.metrics.hits++;
    const accessTime = performance.now() - startTime;
    this.updateAverageAccessTime(accessTime);
    this.updateHitRate();

    logger.debug(`缓存命中: ${key}`, { accessTime: `${accessTime.toFixed(2)}ms` });

    return deserializedValue;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;

    this.items.delete(key);
    this.removeFromAccessStructures(key);
    this.updateMetrics();

    if (this.config.enablePersistence) {
      this.saveToPersistence();
    }

    logger.debug(`缓存项已删除: ${key}`);
    return true;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.items.clear();
    this.accessOrder = [];
    this.accessFrequency.clear();
    this.insertionOrder = [];
    this.resetMetrics();

    if (this.config.enablePersistence) {
      this.clearPersistence();
    }

    logger.debug('缓存已清空');
  }

  /**
   * 检查缓存项是否存在
   */
  has(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;

    // 检查TTL
    if (item.ttl && Date.now() - item.timestamp > item.ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.items.size;
  }

  /**
   * 获取缓存统计
   */
  getMetrics(): CacheMetrics {
    return { ...this.metrics };
  }

  /**
   * 按标签删除缓存项
   */
  deleteByTag(tag: string): number {
    let deletedCount = 0;
    
    for (const [key, item] of this.items.entries()) {
      if (item.tags.includes(tag)) {
        this.delete(key);
        deletedCount++;
      }
    }

    logger.debug(`按标签删除缓存项: ${tag}`, { deletedCount });
    return deletedCount;
  }

  /**
   * 按模式删除缓存项
   */
  deleteByPattern(pattern: RegExp): number {
    let deletedCount = 0;
    
    for (const key of this.items.keys()) {
      if (pattern.test(key)) {
        this.delete(key);
        deletedCount++;
      }
    }

    logger.debug(`按模式删除缓存项: ${pattern}`, { deletedCount });
    return deletedCount;
  }

  /**
   * 获取所有键
   */
  keys(): string[] {
    return Array.from(this.items.keys());
  }

  /**
   * 获取所有值
   */
  async values(): Promise<T[]> {
    const values: T[] = [];
    
    for (const key of this.items.keys()) {
      const value = await this.get(key);
      if (value !== null) {
        values.push(value);
      }
    }

    return values;
  }

  /**
   * 预热缓存
   */
  async warmup(data: Array<{ key: string; value: T; options?: any }>): Promise<void> {
    logger.debug(`开始预热缓存: ${data.length} 项`);
    
    for (const { key, value, options } of data) {
      await this.set(key, value, options);
    }

    logger.debug('缓存预热完成');
  }

  /**
   * 更新访问结构
   */
  private updateAccessStructures(key: string): void {
    // LRU: 移动到最前面
    const lruIndex = this.accessOrder.indexOf(key);
    if (lruIndex > -1) {
      this.accessOrder.splice(lruIndex, 1);
    }
    this.accessOrder.unshift(key);

    // LFU: 增加访问频率
    this.accessFrequency.set(key, (this.accessFrequency.get(key) || 0) + 1);

    // FIFO: 添加到插入顺序
    if (!this.insertionOrder.includes(key)) {
      this.insertionOrder.push(key);
    }
  }

  /**
   * 从访问结构中移除
   */
  private removeFromAccessStructures(key: string): void {
    const lruIndex = this.accessOrder.indexOf(key);
    if (lruIndex > -1) {
      this.accessOrder.splice(lruIndex, 1);
    }

    this.accessFrequency.delete(key);

    const fifoIndex = this.insertionOrder.indexOf(key);
    if (fifoIndex > -1) {
      this.insertionOrder.splice(fifoIndex, 1);
    }
  }

  /**
   * 强制执行缓存限制
   */
  private async enforceLimits(): Promise<void> {
    // 检查数量限制
    while (this.items.size > this.config.maxSize) {
      await this.evictOne();
    }

    // 检查内存限制
    while (this.metrics.totalMemory > this.config.maxMemory) {
      await this.evictOne();
    }
  }

  /**
   * 驱逐一个缓存项
   */
  private async evictOne(): Promise<void> {
    let keyToEvict: string | undefined;

    switch (this.config.strategy) {
      case CacheStrategy.LRU:
        keyToEvict = this.accessOrder[this.accessOrder.length - 1];
        break;

      case CacheStrategy.LFU:
        keyToEvict = this.findLFUKey();
        break;

      case CacheStrategy.FIFO:
        keyToEvict = this.insertionOrder[0];
        break;

      case CacheStrategy.TTL:
        keyToEvict = this.findExpiredKey();
        break;

      case CacheStrategy.ADAPTIVE:
        keyToEvict = await this.findAdaptiveKey();
        break;
    }

    if (keyToEvict) {
      this.delete(keyToEvict);
      logger.debug(`驱逐缓存项: ${keyToEvict}`, { strategy: this.config.strategy });
    }
  }

  /**
   * 查找LFU键
   */
  private findLFUKey(): string | undefined {
    let minFrequency = Infinity;
    let keyToEvict: string | undefined;

    for (const [key, frequency] of this.accessFrequency.entries()) {
      if (frequency < minFrequency) {
        minFrequency = frequency;
        keyToEvict = key;
      }
    }

    return keyToEvict;
  }

  /**
   * 查找过期键
   */
  private findExpiredKey(): string | undefined {
    const now = Date.now();
    
    for (const [key, item] of this.items.entries()) {
      if (item.ttl && now - item.timestamp > item.ttl) {
        return key;
      }
    }

    // 如果没有过期的，返回最旧的
    return this.insertionOrder[0];
  }

  /**
   * 自适应键选择
   */
  private async findAdaptiveKey(): Promise<string | undefined> {
    const now = Date.now();
    let bestScore = -1;
    let keyToEvict: string | undefined;

    for (const [key, item] of this.items.entries()) {
      // 计算综合评分（越低越容易被驱逐）
      const ageScore = (now - item.lastAccessed) / (24 * 60 * 60 * 1000); // 天数
      const frequencyScore = 1 / (item.accessCount + 1);
      const sizeScore = item.size / (1024 * 1024); // MB
      const priorityScore = 1 / item.priority;

      const totalScore = ageScore + frequencyScore + sizeScore + priorityScore;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        keyToEvict = key;
      }
    }

    return keyToEvict;
  }

  /**
   * 序列化值
   */
  private async serializeValue(value: T): Promise<any> {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    return JSON.stringify(value);
  }

  /**
   * 反序列化值
   */
  private async deserializeValue(value: any): Promise<T> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value as T;
      }
    }
    return value;
  }

  /**
   * 压缩值
   */
  private async compressValue(value: any): Promise<any> {
    // 这里可以实现实际的压缩算法，比如使用LZString
    // 为了简化，这里只是模拟
    if (typeof value === 'string') {
      // 简单的压缩模拟
      return btoa(value);
    }
    return value;
  }

  /**
   * 解压缩值
   */
  private async decompressValue(value: any): Promise<any> {
    // 对应的解压缩
    if (typeof value === 'string') {
      try {
        return atob(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  /**
   * 计算大小
   */
  private calculateSize(value: any): number {
    if (typeof value === 'string') {
      return value.length * 2; // Unicode字符
    }
    if (typeof value === 'number') {
      return 8;
    }
    if (typeof value === 'boolean') {
      return 4;
    }
    return JSON.stringify(value).length * 2;
  }

  /**
   * 更新统计信息
   */
  private updateMetrics(): void {
    this.metrics.itemCount = this.items.size;
    this.metrics.totalSize = this.items.size;
    this.metrics.totalMemory = Array.from(this.items.values())
      .reduce((sum, item) => sum + item.size, 0);
  }

  /**
   * 更新命中率
   */
  private updateHitRate(): void {
    this.metrics.hitRate = this.metrics.totalRequests > 0 
      ? (this.metrics.hits / this.metrics.totalRequests) * 100 
      : 0;
  }

  /**
   * 更新平均访问时间
   */
  private updateAverageAccessTime(accessTime: number): void {
    const totalTime = this.metrics.averageAccessTime * this.metrics.hits;
    this.metrics.averageAccessTime = (totalTime + accessTime) / this.metrics.hits;
  }

  /**
   * 重置统计
   */
  private resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalRequests: 0,
      totalSize: 0,
      totalMemory: 0,
      itemCount: 0,
      averageAccessTime: 0,
      compressionRatio: 1
    };
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * 清理过期项目
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, item] of this.items.entries()) {
      if (item.ttl && now - item.timestamp > item.ttl) {
        this.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`清理过期缓存项: ${cleanedCount}`);
    }
  }

  /**
   * 从持久化存储加载
   */
  private loadFromPersistence(): void {
    if (!this.config.enablePersistence || !this.config.persistenceKey) return;

    try {
      const data = localStorage.getItem(this.config.persistenceKey);
      if (data) {
        const parsed = JSON.parse(data);
        for (const [key, item] of Object.entries(parsed)) {
          this.items.set(key, item as SmartCacheItem<T>);
        }
        this.updateMetrics();
        logger.debug(`从持久化存储加载缓存: ${this.items.size} 项`);
      }
    } catch (error) {
      logger.error('加载持久化缓存失败', error);
    }
  }

  /**
   * 保存到持久化存储
   */
  private saveToPersistence(): void {
    if (!this.config.enablePersistence || !this.config.persistenceKey) return;

    try {
      const data = Object.fromEntries(this.items.entries());
      localStorage.setItem(this.config.persistenceKey, JSON.stringify(data));
    } catch (error) {
      logger.error('保存持久化缓存失败', error);
    }
  }

  /**
   * 清除持久化存储
   */
  private clearPersistence(): void {
    if (!this.config.enablePersistence || !this.config.persistenceKey) return;

    try {
      localStorage.removeItem(this.config.persistenceKey);
    } catch (error) {
      logger.error('清除持久化缓存失败', error);
    }
  }

  /**
   * 销毁缓存
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
  }
}
