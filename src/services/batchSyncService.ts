/**
 * 分批同步服务
 * 
 * 功能：
 * 1. 将大量数据分批处理，每批不超过配置的大小
 * 2. 支持进度回调
 * 3. 支持取消操作
 * 4. 支持超时控制
 */

import { TabGroup } from '@/types/tab';
import { logSanitizer } from '@/utils/logSanitizer';
import { SyncError } from '@/utils/errors';

// 批处理配置
const BATCH_CONFIG = {
  batchSize: 50,      // 每批最大数量
  timeout: 30000,     // 超时时间（毫秒）
  retryCount: 3,      // 重试次数
  retryDelay: 1000,   // 重试延迟（毫秒）
} as const;

/**
 * 同步进度信息
 */
export interface SyncProgress {
  total: number;
  completed: number;
  failed: number;
  currentBatch: number;
  totalBatches: number;
  percentage: number;
}

/**
 * 同步结果
 */
export interface SyncResult {
  success: boolean;
  syncedCount: number;
  failedCount: number;
  errors: string[];
}

/**
 * 批处理回调类型
 */
type BatchProcessor<T, R> = (batch: T[], batchIndex: number) => Promise<R>;

/**
 * 将数组分割成批次
 */
export function splitIntoBatches<T>(items: T[], batchSize: number = BATCH_CONFIG.batchSize): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * 分批同步服务类
 */
class BatchSyncService {
  private abortController: AbortController | null = null;

  /**
   * 分批处理数据
   */
  async processBatches<T, R>(
    items: T[],
    processor: BatchProcessor<T, R>,
    onProgress?: (progress: SyncProgress) => void,
    signal?: AbortSignal
  ): Promise<{ results: R[]; errors: string[] }> {
    const batches = splitIntoBatches(items);
    const results: R[] = [];
    const errors: string[] = [];
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < batches.length; i++) {
      // 检查是否取消
      if (signal?.aborted) {
        throw SyncError.cancelled();
      }

      const batch = batches[i];
      
      try {
        const result = await this.processWithRetry(
          () => processor(batch, i),
          BATCH_CONFIG.retryCount
        );
        results.push(result);
        completed += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`批次 ${i + 1} 处理失败: ${error instanceof Error ? error.message : '未知错误'}`);
        logSanitizer.error('批次处理失败', i + 1);
      }

      // 更新进度
      if (onProgress) {
        onProgress({
          total: items.length,
          completed,
          failed,
          currentBatch: i + 1,
          totalBatches: batches.length,
          percentage: Math.round(((i + 1) / batches.length) * 100),
        });
      }
    }

    return { results, errors };
  }

  /**
   * 带重试的处理
   */
  private async processWithRetry<R>(
    fn: () => Promise<R>,
    retries: number
  ): Promise<R> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('未知错误');
        
        if (attempt < retries) {
          // 等待后重试
          await this.delay(BATCH_CONFIG.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 分批上传标签组
   */
  async uploadInBatches(
    groups: TabGroup[],
    uploadFn: (groups: TabGroup[]) => Promise<void>,
    onProgress?: (progress: SyncProgress) => void,
    signal?: AbortSignal
  ): Promise<SyncResult> {
    this.abortController = new AbortController();
    const combinedSignal = signal || this.abortController.signal;

    // 设置超时
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, BATCH_CONFIG.timeout);

    try {
      const { errors } = await this.processBatches(
        groups,
        async (batch) => {
          await uploadFn(batch);
        },
        onProgress,
        combinedSignal
      );

      return {
        success: errors.length === 0,
        syncedCount: groups.length - errors.length,
        failedCount: errors.length,
        errors,
      };
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw new SyncError('上传失败，请重试');
    } finally {
      clearTimeout(timeoutId);
      this.abortController = null;
    }
  }

  /**
   * 取消当前同步操作
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      logSanitizer.info('同步操作已取消');
    }
  }

  /**
   * 获取批处理配置
   */
  getConfig() {
    return { ...BATCH_CONFIG };
  }
}

// 导出单例
export const batchSyncService = new BatchSyncService();
