// 智能缓存和存储优化工具

/**
 * 智能缓存管理器
 * 提供高效的数据缓存、压缩和同步策略
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt?: number;
  version: number;
  compressed?: boolean;
}

interface CacheOptions {
  ttl?: number; // Time to live in milliseconds
  compress?: boolean;
  priority?: 'low' | 'normal' | 'high';
}

class SmartCache {
  private cache = new Map<string, CacheEntry<any>>();
  private maxSize = 50 * 1024 * 1024; // 50MB
  private currentSize = 0;

  /**
   * 设置缓存项
   */
  set<T>(key: string, data: T, options: CacheOptions = {}): void {
    const { ttl, compress = false } = options;

    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version: 1,
      compressed: compress,
    };

    if (ttl) {
      entry.expiresAt = Date.now() + ttl;
    }

    // 估算数据大小
    const dataSize = this.estimateSize(data);

    // 检查是否需要清理空间
    if (this.currentSize + dataSize > this.maxSize) {
      this.evictEntries(dataSize);
    }

    // 如果启用了压缩
    if (compress && typeof data === 'object') {
      try {
        const compressed = this.compressData(data);
        entry.data = compressed as T;
        entry.compressed = true;
      } catch (error) {
        console.warn('Compression failed, storing uncompressed data:', error);
      }
    }

    this.cache.set(key, entry);
    this.currentSize += dataSize;
  }

  /**
   * 获取缓存项
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) return null;

    // 检查是否过期
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    // 如果数据被压缩，需要解压
    if (entry.compressed) {
      try {
        return this.decompressData(entry.data);
      } catch (error) {
        console.warn('Decompression failed:', error);
        this.delete(key);
        return null;
      }
    }

    return entry.data;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      const dataSize = this.estimateSize(entry.data);
      this.currentSize -= dataSize;
      return this.cache.delete(key);
    }
    return false;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    entries: number;
    size: number;
    maxSize: number;
    hitRate?: number;
  } {
    return {
      entries: this.cache.size,
      size: this.currentSize,
      maxSize: this.maxSize,
    };
  }

  /**
   * 预热缓存
   */
  async warmup(keys: string[]): Promise<void> {
    for (const key of keys) {
      // 这里可以实现预加载逻辑
      if (!this.cache.has(key)) {
        // 从存储中加载
        try {
          const data = await this.loadFromStorage(key);
          if (data) {
            this.set(key, data);
          }
        } catch (error) {
          console.warn(`Failed to warmup cache for ${key}:`, error);
        }
      }
    }
  }

  private estimateSize(data: any): number {
    // 粗略估算对象大小
    if (typeof data === 'string') {
      return data.length * 2; // UTF-16
    }
    if (typeof data === 'object' && data !== null) {
      return JSON.stringify(data).length * 2;
    }
    return 16; // 默认大小
  }

  private evictEntries(requiredSpace: number): void {
    const entries = Array.from(this.cache.entries());

    // 按优先级排序：先删除低优先级的
    entries.sort(([, a], [, b]) => {
      const aPriority = this.getPriorityScore(a);
      const bPriority = this.getPriorityScore(b);
      return aPriority - bPriority;
    });

    let freedSpace = 0;
    for (const [key, entry] of entries) {
      if (freedSpace >= requiredSpace) break;

      const dataSize = this.estimateSize(entry.data);
      this.cache.delete(key);
      this.currentSize -= dataSize;
      freedSpace += dataSize;
    }
  }

  private getPriorityScore(entry: CacheEntry<any>): number {
    // 基于时间和访问频率计算优先级分数
    const age = Date.now() - entry.timestamp;
    const score = age / 1000; // 年龄分数

    // 最近访问的项有更高的优先级
    if (entry.expiresAt) {
      return score * 2; // 有过期时间的优先删除
    }

    return score;
  }

  private compressData(data: any): any {
    // 使用简单的压缩策略
    const jsonString = JSON.stringify(data);

    // 如果启用了lz-string，可以使用更高级的压缩
    if (typeof window !== 'undefined' && (window as any).LZString) {
      return (window as any).LZString.compress(jsonString);
    }

    // 否则返回原始数据
    return data;
  }

  private decompressData(compressedData: any): any {
    // 解压数据
    if (typeof compressedData === 'string' && compressedData.startsWith('compressed:')) {
      if (typeof window !== 'undefined' && (window as any).LZString) {
        const decompressed = (window as any).LZString.decompress(compressedData);
        return JSON.parse(decompressed);
      }
    }

    return compressedData;
  }

  private async loadFromStorage(key: string): Promise<any> {
    // 从本地存储加载数据
    try {
      // 这里可以根据key的类型从不同的存储中加载
      // 暂时返回null，具体实现可以根据需要添加
      return null;
    } catch (error) {
      console.warn(`Failed to load ${key} from storage:`, error);
    }
    return null;
  }
}

// 创建缓存实例
export const smartCache = new SmartCache();

/**
 * 离线数据管理器
 */
export class OfflineManager {
  private isOnline = navigator.onLine;
  private pendingOperations: Array<{
    id: string;
    operation: () => Promise<any>;
    timestamp: number;
  }> = [];

  constructor() {
    // 监听网络状态变化
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.processPendingOperations();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
    });

    // 定期清理过期的挂起操作
    setInterval(() => {
      this.cleanupExpiredOperations();
    }, 60000); // 每分钟清理一次
  }

  /**
   * 检查网络状态
   */
  isOffline(): boolean {
    return !this.isOnline;
  }

  /**
   * 执行操作，支持离线队列
   */
  async execute<T>(
    operation: () => Promise<T>,
    options: {
      queueIfOffline?: boolean;
      maxRetries?: number;
      retryDelay?: number;
    } = {}
  ): Promise<T> {
    const { queueIfOffline = true, maxRetries = 3, retryDelay = 1000 } = options;

    if (this.isOffline() && queueIfOffline) {
      return this.queueOperation(operation);
    }

    // 重试逻辑
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === maxRetries || this.isOffline()) {
          if (queueIfOffline) {
            return this.queueOperation(operation);
          }
          throw error;
        }

        // 等待重试
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, i)));
      }
    }

    throw new Error('Operation failed after retries');
  }

  /**
   * 将操作加入队列
   */
  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const operationId = `op_${Date.now()}_${Math.random()}`;

      const queuedOperation = {
        id: operationId,
        operation: async () => {
          try {
            const result = await operation();
            resolve(result);
            return result;
          } catch (error) {
            reject(error);
            throw error;
          }
        },
        timestamp: Date.now(),
      };

      this.pendingOperations.push(queuedOperation);

      // 存储到本地存储
      this.persistPendingOperations();
    });
  }

  /**
   * 处理挂起的操作
   */
  private async processPendingOperations(): Promise<void> {
    if (this.isOffline() || this.pendingOperations.length === 0) return;

    const operations = [...this.pendingOperations];
    this.pendingOperations = [];

    for (const op of operations) {
      try {
        await op.operation();
      } catch (error) {
        console.warn(`Failed to process pending operation ${op.id}:`, error);
        // 重新加入队列
        this.pendingOperations.push(op);
      }
    }

    this.persistPendingOperations();
  }

  /**
   * 持久化挂起操作
   */
  private async persistPendingOperations(): Promise<void> {
    try {
      const data = this.pendingOperations.map(op => ({
        id: op.id,
        timestamp: op.timestamp,
        // 注意：函数无法序列化，这里只存储元数据
      }));

      localStorage.setItem('pending_operations', JSON.stringify(data));
    } catch (error) {
      console.warn('Failed to persist pending operations:', error);
    }
  }

  /**
   * 恢复挂起操作（应用启动时调用）
   */
  async restorePendingOperations(): Promise<void> {
    try {
      const data = localStorage.getItem('pending_operations');
      if (!data) return;

      const operations = JSON.parse(data);
      // 注意：由于函数无法序列化，这里只是恢复计数
      console.log(`Restored ${operations.length} pending operations`);
    } catch (error) {
      console.warn('Failed to restore pending operations:', error);
    }
  }

  /**
   * 清理过期的挂起操作
   */
  private cleanupExpiredOperations(): void {
    const maxAge = 24 * 60 * 60 * 1000; // 24小时
    const cutoff = Date.now() - maxAge;

    this.pendingOperations = this.pendingOperations.filter(op => op.timestamp > cutoff);

    this.persistPendingOperations();
  }

  /**
   * 获取挂起操作统计
   */
  getPendingStats(): {
    count: number;
    oldest?: number;
    newest?: number;
  } {
    if (this.pendingOperations.length === 0) {
      return { count: 0 };
    }

    const timestamps = this.pendingOperations.map(op => op.timestamp);
    return {
      count: this.pendingOperations.length,
      oldest: Math.min(...timestamps),
      newest: Math.max(...timestamps),
    };
  }
}

// 创建离线管理器实例
export const offlineManager = new OfflineManager();

/**
 * 存储优化器
 * 提供智能的数据压缩和存储策略
 */
export class StorageOptimizer {
  private static readonly COMPRESSION_THRESHOLD = 1024; // 1KB
  private static readonly BATCH_SIZE = 100;

  /**
   * 智能压缩数据
   */
  static async compressData(data: any): Promise<string> {
    const jsonString = JSON.stringify(data);

    if (jsonString.length < this.COMPRESSION_THRESHOLD) {
      return jsonString; // 不压缩小数据
    }

    // 检查是否支持原生压缩
    if ('CompressionStream' in window) {
      try {
        const stream = new CompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();

        writer.write(new TextEncoder().encode(jsonString));
        writer.close();

        const chunks: Uint8Array[] = [];
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          if (value) chunks.push(value);
        }

        const compressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          compressed.set(chunk, offset);
          offset += chunk.length;
        }

        return `compressed:${btoa(String.fromCharCode(...compressed))}`;
      } catch (error) {
        console.warn('Native compression failed:', error);
      }
    }

    // 降级到简单压缩
    return this.simpleCompress(jsonString);
  }

  /**
   * 解压缩数据
   */
  static async decompressData(compressedData: string): Promise<any> {
    if (!compressedData.startsWith('compressed:')) {
      return JSON.parse(compressedData);
    }

    const base64Data = compressedData.slice(11);

    // 检查是否支持原生解压
    if ('DecompressionStream' in window) {
      try {
        const compressed = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const stream = new DecompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();

        writer.write(compressed);
        writer.close();

        const chunks: Uint8Array[] = [];
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          if (value) chunks.push(value);
        }

        const decompressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          decompressed.set(chunk, offset);
          offset += chunk.length;
        }

        return JSON.parse(new TextDecoder().decode(decompressed));
      } catch (error) {
        console.warn('Native decompression failed:', error);
      }
    }

    // 降级到简单解压
    const decompressed = this.simpleDecompress(base64Data);
    return JSON.parse(decompressed);
  }

  /**
   * 批量处理数据
   */
  static async batchProcess<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    options: { batchSize?: number } = {}
  ): Promise<R[]> {
    const { batchSize = this.BATCH_SIZE } = options;
    const results: R[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromises = batch.map(processor);

      // 分批执行，控制并发
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // 小延迟避免阻塞主线程
      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    return results;
  }

  /**
   * 简单压缩算法（RLE）
   */
  private static simpleCompress(data: string): string {
    let result = '';
    let count = 1;

    for (let i = 1; i <= data.length; i++) {
      if (data[i] === data[i - 1] && count < 255) {
        count++;
      } else {
        if (count > 3) {
          // 只压缩重复3次以上的字符
          result += `$${count}${data[i - 1]}`;
        } else {
          result += data[i - 1].repeat(count);
        }
        count = 1;
      }
    }

    return result.length < data.length ? `simple:${result}` : data;
  }

  /**
   * 简单解压算法
   */
  private static simpleDecompress(data: string): string {
    if (!data.startsWith('simple:')) return data;

    const compressed = data.slice(7);
    let result = '';
    let i = 0;

    while (i < compressed.length) {
      if (compressed[i] === '$') {
        // 解析压缩格式 $count char
        const countEnd = compressed.indexOf('$', i + 1);
        const count = parseInt(compressed.slice(i + 1, countEnd !== -1 ? countEnd : i + 3));
        const char = compressed[countEnd !== -1 ? countEnd + 1 : i + 3];
        result += char.repeat(count);
        i = countEnd !== -1 ? countEnd + 2 : i + 4;
      } else {
        result += compressed[i];
        i++;
      }
    }

    return result;
  }
}
