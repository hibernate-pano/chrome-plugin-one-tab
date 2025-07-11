/**
 * 同步服务协调器
 * 统一管理所有同步相关操作，防止竞争条件
 */
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

export interface SyncOperation {
  id: string;
  type: 'upload' | 'download' | 'merge';
  priority: number;
  timestamp: number;
  payload?: any;
}

export interface SyncResult {
  success: boolean;
  timestamp: string;
  error?: string;
  data?: any;
}

class SyncCoordinator {
  private syncQueue = new Map<string, SyncOperation>();
  private isProcessing = false;
  private currentOperation: SyncOperation | null = null;
  private retryAttempts = new Map<string, number>();
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // 1秒

  /**
   * 添加同步操作到队列
   */
  async queueSync(operation: Omit<SyncOperation, 'id' | 'timestamp'>): Promise<string> {
    const id = this.generateOperationId();
    const syncOperation: SyncOperation = {
      ...operation,
      id,
      timestamp: Date.now(),
    };

    logger.sync('添加同步操作到队列', { id, type: operation.type, priority: operation.priority });

    // 如果是高优先级操作，替换现有的低优先级操作
    if (operation.priority > 5) {
      const lowPriorityOps = Array.from(this.syncQueue.values()).filter(op => op.priority <= 5);
      lowPriorityOps.forEach(op => {
        logger.sync('移除低优先级操作', { id: op.id, type: op.type });
        this.syncQueue.delete(op.id);
      });
    }

    this.syncQueue.set(id, syncOperation);

    // 如果当前没有处理中的操作，立即开始处理
    if (!this.isProcessing) {
      this.processSyncQueue();
    }

    return id;
  }

  /**
   * 取消同步操作
   */
  cancelSync(operationId: string): boolean {
    if (this.syncQueue.has(operationId)) {
      this.syncQueue.delete(operationId);
      logger.sync('取消同步操作', { operationId });
      return true;
    }
    return false;
  }

  /**
   * 获取队列状态
   */
  getQueueStatus() {
    return {
      queueLength: this.syncQueue.size,
      isProcessing: this.isProcessing,
      currentOperation: this.currentOperation ? {
        id: this.currentOperation.id,
        type: this.currentOperation.type,
        priority: this.currentOperation.priority,
      } : null,
    };
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    logger.sync('清空同步队列', { clearedCount: this.syncQueue.size });
    this.syncQueue.clear();
    this.retryAttempts.clear();
  }

  /**
   * 处理同步队列
   */
  private async processSyncQueue(): Promise<void> {
    if (this.isProcessing || this.syncQueue.size === 0) {
      return;
    }

    this.isProcessing = true;
    logger.sync('开始处理同步队列', { queueSize: this.syncQueue.size });

    try {
      while (this.syncQueue.size > 0) {
        // 获取最高优先级的操作
        const nextOperation = this.getNextOperation();
        if (!nextOperation) {
          break;
        }

        this.currentOperation = nextOperation;
        this.syncQueue.delete(nextOperation.id);

        try {
          await this.executeOperation(nextOperation);
          
          // 重置重试计数
          this.retryAttempts.delete(nextOperation.id);
          
        } catch (error) {
          await this.handleOperationError(nextOperation, error as Error);
        }
      }
    } finally {
      this.isProcessing = false;
      this.currentOperation = null;
      logger.sync('同步队列处理完成');
    }
  }

  /**
   * 获取下一个要执行的操作（按优先级和时间排序）
   */
  private getNextOperation(): SyncOperation | null {
    if (this.syncQueue.size === 0) {
      return null;
    }

    const operations = Array.from(this.syncQueue.values());
    
    // 按优先级降序，时间升序排序
    operations.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.timestamp - b.timestamp;
    });

    return operations[0];
  }

  /**
   * 执行同步操作
   */
  private async executeOperation(operation: SyncOperation): Promise<void> {
    logger.sync('执行同步操作', { 
      id: operation.id, 
      type: operation.type, 
      priority: operation.priority 
    });

    const startTime = Date.now();

    try {
      switch (operation.type) {
        case 'upload':
          await this.executeUpload(operation);
          break;
        case 'download':
          await this.executeDownload(operation);
          break;
        case 'merge':
          await this.executeMerge(operation);
          break;
        default:
          throw new Error(`未知的同步操作类型: ${operation.type}`);
      }

      const duration = Date.now() - startTime;
      logger.success('同步操作完成', { 
        id: operation.id, 
        type: operation.type, 
        duration: `${duration}ms` 
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('同步操作失败', error, { 
        id: operation.id, 
        type: operation.type, 
        duration: `${duration}ms` 
      });
      throw error;
    }
  }

  /**
   * 执行上传操作
   */
  private async executeUpload(_operation: SyncOperation): Promise<void> {
    // 这里应该调用实际的上传服务
    // 暂时模拟异步操作
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 模拟可能的失败
    if (Math.random() < 0.1) {
      throw new Error('网络连接失败');
    }
  }

  /**
   * 执行下载操作
   */
  private async executeDownload(_operation: SyncOperation): Promise<void> {
    // 这里应该调用实际的下载服务
    await new Promise(resolve => setTimeout(resolve, 800));
    
    if (Math.random() < 0.1) {
      throw new Error('服务器响应超时');
    }
  }

  /**
   * 执行合并操作
   */
  private async executeMerge(_operation: SyncOperation): Promise<void> {
    // 这里应该调用实际的数据合并服务
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    if (Math.random() < 0.05) {
      throw new Error('数据冲突需要用户解决');
    }
  }

  /**
   * 处理操作错误
   */
  private async handleOperationError(operation: SyncOperation, error: Error): Promise<void> {
    const attempts = this.retryAttempts.get(operation.id) || 0;
    
    if (attempts < this.MAX_RETRIES) {
      // 增加重试次数
      this.retryAttempts.set(operation.id, attempts + 1);
      
      // 降低优先级并重新加入队列
      const retryOperation: SyncOperation = {
        ...operation,
        priority: Math.max(1, operation.priority - 1),
        timestamp: Date.now() + this.RETRY_DELAY * (attempts + 1),
      };
      
      logger.warn('同步操作失败，将重试', {
        id: operation.id,
        attempt: attempts + 1,
        maxRetries: this.MAX_RETRIES,
        error: error.message,
      });
      
      // 延迟后重新加入队列
      setTimeout(() => {
        this.syncQueue.set(operation.id, retryOperation);
      }, this.RETRY_DELAY * (attempts + 1));
      
    } else {
      // 超过最大重试次数，记录错误
      const friendlyError = errorHandler.handleSyncError(error, {
        component: 'SyncCoordinator',
        action: operation.type,
        extra: { operationId: operation.id, attempts },
      });
      
      logger.error('同步操作最终失败', error, {
        id: operation.id,
        type: operation.type,
        totalAttempts: attempts + 1,
        friendlyError,
      });
      
      // 清除重试记录
      this.retryAttempts.delete(operation.id);
    }
  }

  /**
   * 生成操作ID
   */
  private generateOperationId(): string {
    return `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 销毁协调器
   */
  destroy(): void {
    logger.sync('销毁同步协调器');
    this.clearQueue();
    this.isProcessing = false;
    this.currentOperation = null;
  }
}

// 导出单例实例
export const syncCoordinator = new SyncCoordinator();

// 为了方便测试，也导出类
export { SyncCoordinator };