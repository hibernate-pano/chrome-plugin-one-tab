/**
 * 并发测试运行器
 * 用于在开发环境中运行并发测试
 */

import { concurrencyTest } from './ConcurrencyTest';
import { lockMonitor } from '../LockMonitor';

/**
 * 运行并发测试
 */
export async function runConcurrencyTests(): Promise<void> {
  console.log('🚀 启动OneTabPlus并发测试...');
  console.log('测试目标: 验证分布式锁机制能够正确防止数据覆盖问题');
  console.log('='.repeat(60));
  
  try {
    // 启动锁监控
    console.log('📊 启动锁状态监控...');
    
    // 运行所有并发测试
    await concurrencyTest.runAllTests();
    
    console.log('\n🎉 并发测试完成!');
    
  } catch (error) {
    console.error('❌ 并发测试运行失败:', error);
  }
}

/**
 * 在浏览器控制台中运行测试的便捷函数
 */
(window as any).runConcurrencyTests = runConcurrencyTests;

// 如果在Node.js环境中直接运行
if (typeof window === 'undefined') {
  runConcurrencyTests().catch(console.error);
}
