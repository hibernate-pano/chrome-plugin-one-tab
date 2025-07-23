/**
 * 数据覆盖问题测试
 * 专门测试原始问题场景：用户保存操作与定时同步的并发冲突
 */

import { distributedLockManager, LockType } from '../DistributedLockManager';
import { atomicOperationWrapper } from '../AtomicOperationWrapper';
import { pullFirstSyncService } from '../PullFirstSyncService';
import { storage } from '@/shared/utils/storage';
import { TabGroup } from '@/types/tab';

/**
 * 模拟原始问题场景的测试
 */
export async function testDataOverwriteScenario(): Promise<void> {
  console.log('🧪 开始数据覆盖问题测试...');
  console.log('📋 测试场景：用户保存10个新标签组时，定时同步被触发');
  
  try {
    // 步骤1: 准备初始数据（10个标签组）
    console.log('📝 步骤1: 准备初始数据（10个标签组）');
    const initialGroups = await createTestGroups(10, 'initial');
    await storage.setGroups(initialGroups);
    console.log(`✅ 初始数据准备完成，共${initialGroups.length}个标签组`);
    
    // 步骤2: 模拟用户保存操作（添加10个新标签组）
    console.log('📝 步骤2: 开始用户保存操作（添加10个新标签组）');
    
    const userSavePromise = simulateUserSaveOperation();
    
    // 步骤3: 在用户保存过程中触发定时同步
    console.log('📝 步骤3: 延迟500ms后触发定时同步');
    const periodicSyncPromise = new Promise(resolve => {
      setTimeout(async () => {
        console.log('🔄 触发定时同步...');
        const result = await pullFirstSyncService.performPeriodicSync();
        console.log('📊 定时同步结果:', result.success ? '成功' : '失败', result.message);
        resolve(result);
      }, 500);
    });
    
    // 步骤4: 等待两个操作完成
    console.log('📝 步骤4: 等待操作完成...');
    const [userResult, syncResult] = await Promise.all([
      userSavePromise,
      periodicSyncPromise
    ]);
    
    // 步骤5: 验证结果
    console.log('📝 步骤5: 验证结果...');
    const finalGroups = await storage.getGroups();
    const expectedCount = 20; // 初始10个 + 新增10个
    
    console.log('📊 测试结果:');
    console.log(`  - 用户保存操作: ${userResult.success ? '成功' : '失败'}`);
    console.log(`  - 定时同步操作: ${syncResult.success ? '成功' : '失败'}`);
    console.log(`  - 最终标签组数量: ${finalGroups.length}`);
    console.log(`  - 期望标签组数量: ${expectedCount}`);
    
    if (finalGroups.length === expectedCount) {
      console.log('🎉 测试通过！用户数据没有被覆盖');
      return;
    } else {
      console.error('❌ 测试失败！数据被覆盖了');
      console.log('🔍 详细分析:');
      
      const initialGroupIds = initialGroups.map(g => g.id);
      const finalGroupIds = finalGroups.map(g => g.id);
      
      const lostGroups = initialGroupIds.filter(id => !finalGroupIds.includes(id));
      const newGroups = finalGroupIds.filter(id => !initialGroupIds.includes(id));
      
      console.log(`  - 丢失的标签组: ${lostGroups.length}个`);
      console.log(`  - 新增的标签组: ${newGroups.length}个`);
      
      if (lostGroups.length > 0) {
        console.log(`  - 丢失的标签组ID: ${lostGroups.slice(0, 5).join(', ')}${lostGroups.length > 5 ? '...' : ''}`);
      }
    }
    
  } catch (error) {
    console.error('❌ 数据覆盖问题测试异常:', error);
  }
}

/**
 * 模拟用户保存操作
 */
async function simulateUserSaveOperation(): Promise<any> {
  console.log('👤 开始模拟用户保存操作...');
  
  return atomicOperationWrapper.executeAtomicDataOperation(
    // Pull操作 - 获取最新数据
    async () => {
      console.log('📥 用户操作: 拉取最新数据');
      const groups = await storage.getGroups();
      console.log(`📥 用户操作: 获取到${groups.length}个标签组`);
      return groups;
    },
    
    // Process操作 - 添加新标签组
    async (groups: TabGroup[]) => {
      console.log('⚙️ 用户操作: 处理数据（添加10个新标签组）');
      
      // 模拟一些处理时间
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const newGroups = await createTestGroups(10, 'user_added');
      const updatedGroups = [...groups, ...newGroups];
      
      console.log(`⚙️ 用户操作: 处理完成，总共${updatedGroups.length}个标签组`);
      
      return {
        success: true,
        updatedData: updatedGroups,
        result: { addedCount: newGroups.length }
      };
    },
    
    // Push操作 - 保存数据
    async (groups: TabGroup[]) => {
      console.log('🚀 用户操作: 保存数据到本地和云端');
      await storage.setGroups(groups);
      console.log(`🚀 用户操作: 保存完成，共${groups.length}个标签组`);
    },
    
    // 配置
    {
      type: LockType.USER_OPERATION,
      operationId: 'user_save_test',
      description: '用户保存操作测试',
      timeout: 30000,
      retryOnLockFailure: true,
      maxRetries: 3
    }
  );
}

/**
 * 创建测试标签组
 */
async function createTestGroups(count: number, prefix: string): Promise<TabGroup[]> {
  const groups: TabGroup[] = [];
  
  for (let i = 0; i < count; i++) {
    groups.push({
      id: `${prefix}_${Date.now()}_${i}`,
      name: `${prefix}标签组 ${i + 1}`,
      tabs: [
        {
          id: `tab_${Date.now()}_${i}`,
          title: `测试标签 ${i + 1}`,
          url: `https://example.com/test-${i}`,
          favIconUrl: '',
          index: 0
        }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      isLocked: false
    });
  }
  
  return groups;
}

/**
 * 压力测试：多个并发用户操作
 */
export async function testConcurrentUserOperations(): Promise<void> {
  console.log('🧪 开始并发用户操作压力测试...');
  
  try {
    // 准备初始数据
    const initialGroups = await createTestGroups(5, 'initial');
    await storage.setGroups(initialGroups);
    
    // 创建多个并发用户操作
    const operations = Array.from({ length: 5 }, (_, i) => 
      atomicOperationWrapper.executeAtomicDataOperation(
        () => storage.getGroups(),
        async (groups: TabGroup[]) => {
          const newGroup = (await createTestGroups(1, `concurrent_${i}`))[0];
          return {
            success: true,
            updatedData: [...groups, newGroup],
            result: { operationId: i }
          };
        },
        async (groups: TabGroup[]) => {
          await storage.setGroups(groups);
        },
        {
          type: LockType.USER_OPERATION,
          operationId: `concurrent_op_${i}`,
          description: `并发操作${i}`,
          timeout: 10000,
          retryOnLockFailure: true,
          maxRetries: 3
        }
      )
    );
    
    // 等待所有操作完成
    const results = await Promise.all(operations);
    
    // 验证结果
    const finalGroups = await storage.getGroups();
    const expectedCount = initialGroups.length + operations.length;
    
    console.log('📊 并发测试结果:');
    console.log(`  - 成功操作数: ${results.filter(r => r.success).length}/${results.length}`);
    console.log(`  - 最终标签组数量: ${finalGroups.length}`);
    console.log(`  - 期望标签组数量: ${expectedCount}`);
    
    if (finalGroups.length === expectedCount) {
      console.log('🎉 并发测试通过！所有操作都成功执行');
    } else {
      console.error('❌ 并发测试失败！数据不一致');
    }
    
  } catch (error) {
    console.error('❌ 并发测试异常:', error);
  }
}

/**
 * 运行所有测试
 */
export async function runAllDataOverwriteTests(): Promise<void> {
  console.log('🚀 开始运行所有数据覆盖测试...');
  console.log('='.repeat(60));
  
  await testDataOverwriteScenario();
  
  console.log('\n' + '='.repeat(60));
  
  await testConcurrentUserOperations();
  
  console.log('\n🎯 所有测试完成！');
}

// 导出到全局，方便在控制台中使用
if (typeof window !== 'undefined') {
  (window as any).testDataOverwriteScenario = testDataOverwriteScenario;
  (window as any).testConcurrentUserOperations = testConcurrentUserOperations;
  (window as any).runAllDataOverwriteTests = runAllDataOverwriteTests;
}

console.log('🔧 数据覆盖测试工具已加载，可在控制台中使用:');
console.log('  - testDataOverwriteScenario(): 测试原始问题场景');
console.log('  - testConcurrentUserOperations(): 测试并发用户操作');
console.log('  - runAllDataOverwriteTests(): 运行所有测试');
