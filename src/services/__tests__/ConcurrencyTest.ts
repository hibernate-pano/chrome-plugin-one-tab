/**
 * 并发场景测试
 * 测试用户操作与定时同步的并发场景，确保锁机制能够正确防止数据覆盖问题
 */

import { distributedLockManager, LockType } from '../DistributedLockManager';
import { atomicOperationWrapper } from '../AtomicOperationWrapper';
import { pullFirstSyncService } from '../PullFirstSyncService';
import { autoSyncManager } from '../autoSyncManager';
import { lockMonitor } from '../LockMonitor';
import { storage } from '@/shared/utils/storage';
import { TabGroup } from '@/types/tab';

/**
 * 并发测试类
 */
export class ConcurrencyTest {
  private testResults: Array<{
    testName: string;
    success: boolean;
    error?: string;
    duration: number;
    details?: any;
  }> = [];

  /**
   * 运行所有并发测试
   */
  public async runAllTests(): Promise<void> {
    console.log('🧪 开始并发测试...');
    
    // 重置监控统计
    lockMonitor.resetStatistics();
    
    try {
      await this.testUserOperationVsPeriodicSync();
      await this.testMultipleUserOperations();
      await this.testLockTimeout();
      await this.testLockPriority();
      await this.testDataConsistency();
      
      this.printTestResults();
      this.printLockStatistics();
      
    } catch (error) {
      console.error('❌ 并发测试异常:', error);
    }
  }

  /**
   * 测试用户操作与定时同步的并发
   */
  private async testUserOperationVsPeriodicSync(): Promise<void> {
    const testName = '用户操作与定时同步并发测试';
    const startTime = Date.now();
    
    try {
      console.log(`🧪 开始测试: ${testName}`);
      
      // 准备测试数据
      const initialGroups = await this.createTestGroups(10);
      await storage.setGroups(initialGroups);
      
      // 模拟用户操作（保存新标签组）
      const userOperationPromise = this.simulateUserSaveOperation();
      
      // 延迟100ms后触发定时同步
      const periodicSyncPromise = new Promise(resolve => {
        setTimeout(async () => {
          const result = await pullFirstSyncService.performPeriodicSync();
          resolve(result);
        }, 100);
      });
      
      // 等待两个操作完成
      const [userResult, syncResult] = await Promise.all([
        userOperationPromise,
        periodicSyncPromise
      ]);
      
      // 验证结果
      const finalGroups = await storage.getGroups();
      const expectedCount = initialGroups.length + 10; // 初始10个 + 新增10个
      
      if (finalGroups.length === expectedCount) {
        this.addTestResult(testName, true, Date.now() - startTime, {
          userResult,
          syncResult,
          finalGroupCount: finalGroups.length,
          expectedCount
        });
        console.log(`✅ ${testName} 通过`);
      } else {
        throw new Error(`数据不一致: 期望${expectedCount}个标签组，实际${finalGroups.length}个`);
      }
      
    } catch (error) {
      this.addTestResult(testName, false, Date.now() - startTime, undefined, error);
      console.error(`❌ ${testName} 失败:`, error);
    }
  }

  /**
   * 测试多个用户操作的并发
   */
  private async testMultipleUserOperations(): Promise<void> {
    const testName = '多个用户操作并发测试';
    const startTime = Date.now();
    
    try {
      console.log(`🧪 开始测试: ${testName}`);
      
      // 准备测试数据
      const initialGroups = await this.createTestGroups(5);
      await storage.setGroups(initialGroups);
      
      // 同时执行多个用户操作
      const operations = [
        this.simulateUserSaveOperation(3),
        this.simulateUserDeleteOperation(),
        this.simulateUserUpdateOperation(),
        this.simulateUserSaveOperation(2)
      ];
      
      const results = await Promise.all(operations);
      
      // 验证所有操作都成功
      const allSuccessful = results.every(result => result.success);
      
      if (allSuccessful) {
        this.addTestResult(testName, true, Date.now() - startTime, { results });
        console.log(`✅ ${testName} 通过`);
      } else {
        throw new Error('部分操作失败');
      }
      
    } catch (error) {
      this.addTestResult(testName, false, Date.now() - startTime, undefined, error);
      console.error(`❌ ${testName} 失败:`, error);
    }
  }

  /**
   * 测试锁超时机制
   */
  private async testLockTimeout(): Promise<void> {
    const testName = '锁超时机制测试';
    const startTime = Date.now();
    
    try {
      console.log(`🧪 开始测试: ${testName}`);
      
      // 获取一个锁并故意不释放
      const lockResult = await distributedLockManager.acquireLock(
        LockType.USER_OPERATION,
        'timeout-test',
        '超时测试',
        2000 // 2秒超时
      );
      
      if (!lockResult.success) {
        throw new Error('无法获取测试锁');
      }
      
      // 等待锁超时
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // 尝试获取新锁，应该成功（因为旧锁已超时）
      const newLockResult = await distributedLockManager.acquireLock(
        LockType.USER_OPERATION,
        'timeout-test-2',
        '超时测试2',
        1000
      );
      
      if (newLockResult.success) {
        distributedLockManager.releaseLock(newLockResult.lockId!);
        this.addTestResult(testName, true, Date.now() - startTime);
        console.log(`✅ ${testName} 通过`);
      } else {
        throw new Error('锁超时机制未正常工作');
      }
      
    } catch (error) {
      this.addTestResult(testName, false, Date.now() - startTime, undefined, error);
      console.error(`❌ ${testName} 失败:`, error);
    }
  }

  /**
   * 测试锁优先级机制
   */
  private async testLockPriority(): Promise<void> {
    const testName = '锁优先级机制测试';
    const startTime = Date.now();
    
    try {
      console.log(`🧪 开始测试: ${testName}`);
      
      // 先获取低优先级锁（定时同步）
      const lowPriorityLock = await distributedLockManager.acquireLock(
        LockType.PERIODIC_SYNC,
        'low-priority-test',
        '低优先级测试',
        5000
      );
      
      if (!lowPriorityLock.success) {
        throw new Error('无法获取低优先级锁');
      }
      
      // 尝试获取高优先级锁（用户操作），应该等待
      const highPriorityPromise = distributedLockManager.acquireLock(
        LockType.USER_OPERATION,
        'high-priority-test',
        '高优先级测试',
        3000
      );
      
      // 1秒后释放低优先级锁
      setTimeout(() => {
        distributedLockManager.releaseLock(lowPriorityLock.lockId!);
      }, 1000);
      
      const highPriorityResult = await highPriorityPromise;
      
      if (highPriorityResult.success) {
        distributedLockManager.releaseLock(highPriorityResult.lockId!);
        this.addTestResult(testName, true, Date.now() - startTime);
        console.log(`✅ ${testName} 通过`);
      } else {
        throw new Error('高优先级锁未能正确获取');
      }
      
    } catch (error) {
      this.addTestResult(testName, false, Date.now() - startTime, undefined, error);
      console.error(`❌ ${testName} 失败:`, error);
    }
  }

  /**
   * 测试数据一致性
   */
  private async testDataConsistency(): Promise<void> {
    const testName = '数据一致性测试';
    const startTime = Date.now();
    
    try {
      console.log(`🧪 开始测试: ${testName}`);
      
      // 准备初始数据
      const initialGroups = await this.createTestGroups(5);
      await storage.setGroups(initialGroups);
      
      // 记录初始状态
      const initialCount = initialGroups.length;
      
      // 执行多个并发操作
      const operations = Array.from({ length: 10 }, (_, i) => 
        this.simulateUserSaveOperation(1, `concurrent-op-${i}`)
      );
      
      await Promise.all(operations);
      
      // 验证最终数据一致性
      const finalGroups = await storage.getGroups();
      const expectedCount = initialCount + 10; // 每个操作添加1个标签组
      
      if (finalGroups.length === expectedCount) {
        this.addTestResult(testName, true, Date.now() - startTime, {
          initialCount,
          finalCount: finalGroups.length,
          expectedCount
        });
        console.log(`✅ ${testName} 通过`);
      } else {
        throw new Error(`数据不一致: 期望${expectedCount}个，实际${finalGroups.length}个`);
      }
      
    } catch (error) {
      this.addTestResult(testName, false, Date.now() - startTime, undefined, error);
      console.error(`❌ ${testName} 失败:`, error);
    }
  }

  /**
   * 模拟用户保存操作
   */
  private async simulateUserSaveOperation(count: number = 10, prefix: string = 'test'): Promise<any> {
    const newGroups = await this.createTestGroups(count, prefix);
    
    return atomicOperationWrapper.executeAtomicDataOperation(
      // Pull
      () => storage.getGroups(),
      
      // Process
      async (groups: TabGroup[]) => {
        const updatedGroups = [...groups, ...newGroups];
        return {
          success: true,
          updatedData: updatedGroups,
          result: { addedCount: count }
        };
      },
      
      // Push
      async (groups: TabGroup[]) => {
        await storage.setGroups(groups);
      },
      
      {
        type: LockType.USER_OPERATION,
        operationId: atomicOperationWrapper.generateOperationId('save_test'),
        description: `模拟保存${count}个标签组`,
        timeout: 10000,
        retryOnLockFailure: true,
        maxRetries: 3
      }
    );
  }

  /**
   * 模拟用户删除操作
   */
  private async simulateUserDeleteOperation(): Promise<any> {
    return atomicOperationWrapper.executeAtomicDataOperation(
      // Pull
      () => storage.getGroups(),
      
      // Process
      async (groups: TabGroup[]) => {
        const updatedGroups = groups.slice(0, -1); // 删除最后一个
        return {
          success: true,
          updatedData: updatedGroups,
          result: { deletedCount: 1 }
        };
      },
      
      // Push
      async (groups: TabGroup[]) => {
        await storage.setGroups(groups);
      },
      
      {
        type: LockType.USER_OPERATION,
        operationId: atomicOperationWrapper.generateOperationId('delete_test'),
        description: '模拟删除操作',
        timeout: 10000,
        retryOnLockFailure: true,
        maxRetries: 3
      }
    );
  }

  /**
   * 模拟用户更新操作
   */
  private async simulateUserUpdateOperation(): Promise<any> {
    return atomicOperationWrapper.executeAtomicDataOperation(
      // Pull
      () => storage.getGroups(),
      
      // Process
      async (groups: TabGroup[]) => {
        if (groups.length > 0) {
          groups[0].name = `更新后的名称_${Date.now()}`;
          groups[0].updatedAt = new Date().toISOString();
        }
        return {
          success: true,
          updatedData: groups,
          result: { updatedCount: 1 }
        };
      },
      
      // Push
      async (groups: TabGroup[]) => {
        await storage.setGroups(groups);
      },
      
      {
        type: LockType.USER_OPERATION,
        operationId: atomicOperationWrapper.generateOperationId('update_test'),
        description: '模拟更新操作',
        timeout: 10000,
        retryOnLockFailure: true,
        maxRetries: 3
      }
    );
  }

  /**
   * 创建测试标签组
   */
  private async createTestGroups(count: number, prefix: string = 'test'): Promise<TabGroup[]> {
    const groups: TabGroup[] = [];
    
    for (let i = 0; i < count; i++) {
      groups.push({
        id: `${prefix}_group_${Date.now()}_${i}`,
        name: `${prefix}标签组 ${i + 1}`,
        tabs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
        isLocked: false
      });
    }
    
    return groups;
  }

  /**
   * 添加测试结果
   */
  private addTestResult(
    testName: string, 
    success: boolean, 
    duration: number, 
    details?: any, 
    error?: any
  ): void {
    this.testResults.push({
      testName,
      success,
      duration,
      details,
      error: error?.message || error
    });
  }

  /**
   * 打印测试结果
   */
  private printTestResults(): void {
    console.log('\n📊 并发测试结果:');
    console.log('='.repeat(50));
    
    this.testResults.forEach(result => {
      const status = result.success ? '✅ 通过' : '❌ 失败';
      console.log(`${status} ${result.testName} (${result.duration}ms)`);
      
      if (!result.success && result.error) {
        console.log(`   错误: ${result.error}`);
      }
    });
    
    const totalTests = this.testResults.length;
    const passedTests = this.testResults.filter(r => r.success).length;
    const failedTests = totalTests - passedTests;
    
    console.log('='.repeat(50));
    console.log(`总测试数: ${totalTests}, 通过: ${passedTests}, 失败: ${failedTests}`);
    console.log(`成功率: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  }

  /**
   * 打印锁统计信息
   */
  private printLockStatistics(): void {
    console.log('\n🔒 锁统计信息:');
    console.log(lockMonitor.generateReport());
  }
}

// 导出测试实例
export const concurrencyTest = new ConcurrencyTest();
