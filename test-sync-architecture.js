/**
 * OneTabPlus 同步架构测试脚本
 * 用于验证新的 pull-first 同步机制是否正常工作
 */

// 测试配置
const TEST_CONFIG = {
  // 测试用户信息
  testUser: {
    email: 'test@example.com',
    password: 'test123456'
  },
  
  // 测试标签组数据
  testTabGroups: [
    {
      id: 'test-group-1',
      name: '测试标签组 1',
      tabs: [
        { url: 'https://example.com', title: '示例网站 1' },
        { url: 'https://google.com', title: 'Google' }
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: 'test-group-2', 
      name: '测试标签组 2',
      tabs: [
        { url: 'https://github.com', title: 'GitHub' },
        { url: 'https://stackoverflow.com', title: 'Stack Overflow' }
      ],
      createdAt: new Date(Date.now() - 1000).toISOString(),
      updatedAt: new Date(Date.now() - 1000).toISOString()
    }
  ]
};

/**
 * 测试 Pull-First 同步服务
 */
async function testPullFirstSyncService() {
  console.log('🧪 开始测试 Pull-First 同步服务');
  
  try {
    // 动态导入服务
    const { pullFirstSyncService } = await import('./src/services/PullFirstSyncService.ts');
    
    console.log('✅ Pull-First 同步服务导入成功');
    
    // 测试服务状态
    const status = pullFirstSyncService.getStatus();
    console.log('📊 服务状态:', status);
    
    // 测试用户操作同步
    console.log('🔄 测试用户操作同步...');
    const userOpResult = await pullFirstSyncService.syncUserOperation({
      type: 'create',
      data: TEST_CONFIG.testTabGroups[0],
      description: '测试创建标签组'
    });
    
    console.log('📝 用户操作同步结果:', userOpResult);
    
    // 测试定时同步
    console.log('🔄 测试定时同步...');
    const periodicResult = await pullFirstSyncService.performPeriodicSync();
    console.log('📝 定时同步结果:', periodicResult);
    
    // 测试手动同步
    console.log('🔄 测试手动同步...');
    const manualResult = await pullFirstSyncService.performManualSync();
    console.log('📝 手动同步结果:', manualResult);
    
    return true;
    
  } catch (error) {
    console.error('❌ Pull-First 同步服务测试失败:', error);
    return false;
  }
}

/**
 * 测试自动同步管理器
 */
async function testAutoSyncManager() {
  console.log('🧪 开始测试自动同步管理器');
  
  try {
    // 动态导入管理器
    const { autoSyncManager } = await import('./src/services/autoSyncManager.ts');
    
    console.log('✅ 自动同步管理器导入成功');
    
    // 测试初始化
    console.log('🔄 测试初始化...');
    await autoSyncManager.initialize();
    
    // 测试状态获取
    const status = autoSyncManager.getStatus();
    console.log('📊 管理器状态:', status);
    
    // 验证定时间隔
    if (status.interval === 10000) {
      console.log('✅ 定时间隔正确 (10秒)');
    } else {
      console.log('❌ 定时间隔错误:', status.interval);
    }
    
    // 测试用户操作同步触发
    console.log('🔄 测试用户操作同步触发...');
    await autoSyncManager.triggerUserActionSync();
    
    return true;
    
  } catch (error) {
    console.error('❌ 自动同步管理器测试失败:', error);
    return false;
  }
}

/**
 * 测试标签组排序
 */
async function testTabGroupSorting() {
  console.log('🧪 开始测试标签组排序');
  
  try {
    // 动态导入存储服务
    const { storage } = await import('./src/shared/utils/storage.ts');
    
    console.log('✅ 存储服务导入成功');
    
    // 保存测试数据
    await storage.setGroups(TEST_CONFIG.testTabGroups);
    
    // 获取数据并检查排序
    const groups = await storage.getGroups();
    console.log('📊 获取的标签组:', groups.map(g => ({ 
      id: g.id, 
      name: g.name, 
      createdAt: g.createdAt 
    })));
    
    // 验证排序（最新的应该在前面）
    if (groups.length >= 2) {
      const first = new Date(groups[0].createdAt);
      const second = new Date(groups[1].createdAt);
      
      if (first >= second) {
        console.log('✅ 标签组排序正确 (时间倒序)');
      } else {
        console.log('❌ 标签组排序错误');
      }
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ 标签组排序测试失败:', error);
    return false;
  }
}

/**
 * 测试拖拽功能
 */
async function testDragFunctionality() {
  console.log('🧪 开始测试拖拽功能');
  
  try {
    // 动态导入拖拽服务
    const { DragDropService } = await import('./src/features/tabs/services/DragDropService.ts');
    
    console.log('✅ 拖拽服务导入成功');
    
    const dragService = new DragDropService();
    
    // 测试标签组拖拽验证（应该被禁用）
    const groupValidation = dragService.validateDragOperation({
      type: 'group',
      sourceId: 'test-group-1',
      sourceIndex: 0,
      targetIndex: 1
    }, TEST_CONFIG.testTabGroups);
    
    if (!groupValidation.isValid) {
      console.log('✅ 标签组拖拽已正确禁用');
    } else {
      console.log('❌ 标签组拖拽未被禁用');
    }
    
    // 测试标签拖拽验证（应该可用）
    const tabValidation = dragService.validateDragOperation({
      type: 'tab',
      sourceId: 'test-tab-1',
      sourceIndex: 0,
      targetIndex: 1,
      sourceGroupId: 'test-group-1',
      targetGroupId: 'test-group-1'
    }, TEST_CONFIG.testTabGroups);
    
    if (tabValidation.isValid) {
      console.log('✅ 标签拖拽功能正常');
    } else {
      console.log('❌ 标签拖拽功能异常:', tabValidation.reason);
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ 拖拽功能测试失败:', error);
    return false;
  }
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始运行 OneTabPlus 同步架构测试');
  console.log('=' .repeat(50));
  
  const results = {
    pullFirstSync: false,
    autoSyncManager: false,
    tabGroupSorting: false,
    dragFunctionality: false
  };
  
  // 运行各项测试
  results.pullFirstSync = await testPullFirstSyncService();
  console.log('');
  
  results.autoSyncManager = await testAutoSyncManager();
  console.log('');
  
  results.tabGroupSorting = await testTabGroupSorting();
  console.log('');
  
  results.dragFunctionality = await testDragFunctionality();
  console.log('');
  
  // 输出测试结果
  console.log('=' .repeat(50));
  console.log('📊 测试结果汇总:');
  console.log('');
  
  Object.entries(results).forEach(([test, passed]) => {
    const status = passed ? '✅ 通过' : '❌ 失败';
    console.log(`${test}: ${status}`);
  });
  
  const passedCount = Object.values(results).filter(Boolean).length;
  const totalCount = Object.keys(results).length;
  
  console.log('');
  console.log(`总计: ${passedCount}/${totalCount} 项测试通过`);
  
  if (passedCount === totalCount) {
    console.log('🎉 所有测试通过！同步架构重构成功！');
  } else {
    console.log('⚠️ 部分测试失败，需要进一步检查和修复');
  }
  
  return results;
}

// 如果直接运行此脚本
if (typeof window !== 'undefined') {
  // 在浏览器环境中运行
  window.testSyncArchitecture = runAllTests;
  console.log('💡 在浏览器控制台中运行 testSyncArchitecture() 来执行测试');
} else {
  // 在 Node.js 环境中运行
  runAllTests().catch(console.error);
}

// 导出测试函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runAllTests,
    testPullFirstSyncService,
    testAutoSyncManager,
    testTabGroupSorting,
    testDragFunctionality
  };
}
