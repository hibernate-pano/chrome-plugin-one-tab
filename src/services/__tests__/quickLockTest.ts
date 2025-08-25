/**
 * 快速锁机制测试
 * 用于在浏览器控制台中快速验证锁机制是否正常工作
 */

import { distributedLockManager, LockType } from '../DistributedLockManager';
import { atomicOperationWrapper } from '../AtomicOperationWrapper';
import { logger } from '@/shared/utils/logger';

/**
 * 快速测试锁机制
 */
export async function quickLockTest(): Promise<void> {
  console.log('🧪 开始快速锁机制测试...');
  
  try {
    // 测试1: 基本锁获取和释放
    console.log('📝 测试1: 基本锁获取和释放');
    const lockResult1 = await distributedLockManager.acquireLock(
      LockType.USER_OPERATION,
      'test-1',
      '测试锁1',
      5000
    );
    
    if (lockResult1.success) {
      console.log('✅ 锁1获取成功:', lockResult1.lockId);
      
      // 释放锁
      const released = distributedLockManager.releaseLock(lockResult1.lockId!);
      console.log('✅ 锁1释放结果:', released);
    } else {
      console.error('❌ 锁1获取失败:', lockResult1.error);
    }
    
    // 测试2: 锁冲突
    console.log('📝 测试2: 锁冲突测试');
    const lockResult2 = await distributedLockManager.acquireLock(
      LockType.PERIODIC_SYNC,
      'test-2',
      '测试锁2（低优先级）',
      5000
    );
    
    if (lockResult2.success) {
      console.log('✅ 低优先级锁获取成功:', lockResult2.lockId);
      
      // 尝试获取高优先级锁
      const lockResult3 = await distributedLockManager.acquireLock(
        LockType.USER_OPERATION,
        'test-3',
        '测试锁3（高优先级）',
        2000
      );
      
      if (lockResult3.success) {
        console.log('✅ 高优先级锁获取成功:', lockResult3.lockId);
        distributedLockManager.releaseLock(lockResult3.lockId!);
      } else {
        console.log('⚠️ 高优先级锁获取失败（预期）:', lockResult3.error);
      }
      
      // 释放低优先级锁
      distributedLockManager.releaseLock(lockResult2.lockId!);
    }
    
    // 测试3: 原子操作包装器
    console.log('📝 测试3: 原子操作包装器');
    const atomicResult = await atomicOperationWrapper.executeAtomicSync(
      async () => {
        console.log('🔄 执行原子操作...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { message: '原子操作完成' };
      },
      {
        type: LockType.USER_OPERATION,
        operationId: 'atomic-test',
        description: '原子操作测试',
        timeout: 5000
      }
    );
    
    if (atomicResult.success) {
      console.log('✅ 原子操作成功:', atomicResult.result);
    } else {
      console.error('❌ 原子操作失败:', atomicResult.error);
    }
    
    // 测试4: 并发测试
    console.log('📝 测试4: 简单并发测试');
    const concurrentPromises = [
      atomicOperationWrapper.executeAtomicSync(
        async () => {
          console.log('🔄 并发操作1开始');
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('✅ 并发操作1完成');
          return { id: 1 };
        },
        {
          type: LockType.USER_OPERATION,
          operationId: 'concurrent-1',
          description: '并发操作1'
        }
      ),
      atomicOperationWrapper.executeAtomicSync(
        async () => {
          console.log('🔄 并发操作2开始');
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('✅ 并发操作2完成');
          return { id: 2 };
        },
        {
          type: LockType.USER_OPERATION,
          operationId: 'concurrent-2',
          description: '并发操作2'
        }
      )
    ];
    
    const concurrentResults = await Promise.all(concurrentPromises);
    console.log('✅ 并发测试结果:', concurrentResults);
    
    console.log('🎉 快速锁机制测试完成！');
    
  } catch (error) {
    console.error('❌ 快速锁机制测试失败:', error);
  }
}

/**
 * 检查锁状态
 */
export function checkLockStatus(): void {
  const lockStatus = distributedLockManager.getLockStatus();
  if (lockStatus) {
    console.log('🔒 当前锁状态:', {
      id: lockStatus.id,
      type: lockStatus.type,
      operationId: lockStatus.operationId,
      description: lockStatus.description,
      acquiredAt: new Date(lockStatus.acquiredAt).toLocaleTimeString(),
      expiresAt: new Date(lockStatus.expiresAt).toLocaleTimeString(),
      remainingTime: Math.max(0, lockStatus.expiresAt - Date.now()) + 'ms'
    });
  } else {
    console.log('🔓 当前没有活跃的锁');
  }
}

/**
 * 强制清理所有锁
 */
export function forceClearLocks(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('onetabplus_sync_lock');
      console.log('🧹 已强制清理所有锁');
    } else {
      console.log('⚠️ localStorage不可用，无法清理锁');
    }
  } catch (error) {
    console.error('❌ 清理锁失败:', error);
  }
}

// 导出到全局，方便在控制台中使用
if (typeof window !== 'undefined') {
  (window as any).quickLockTest = quickLockTest;
  (window as any).checkLockStatus = checkLockStatus;
  (window as any).forceClearLocks = forceClearLocks;
}

console.log('🔧 锁机制测试工具已加载，可在控制台中使用:');
console.log('  - quickLockTest(): 运行快速测试');
console.log('  - checkLockStatus(): 检查当前锁状态');
console.log('  - forceClearLocks(): 强制清理所有锁');
