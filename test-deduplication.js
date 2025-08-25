/**
 * 去重功能测试脚本
 * 用于验证新的去重功能是否正常工作
 */

// 测试数据 - 包含重复标签的标签组
const testTabGroupsWithDuplicates = [
  {
    id: 'group-1',
    name: '测试组 1',
    tabs: [
      { id: 'tab-1', url: 'https://example.com', title: '示例网站' },
      { id: 'tab-2', url: 'https://google.com', title: 'Google' },
      { id: 'tab-3', url: 'https://example.com', title: '示例网站 (重复)' }, // 重复
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false,
    order: 0
  },
  {
    id: 'group-2',
    name: '测试组 2',
    tabs: [
      { id: 'tab-4', url: 'https://github.com', title: 'GitHub' },
      { id: 'tab-5', url: 'https://google.com', title: 'Google (重复)' }, // 重复
      { id: 'tab-6', url: 'https://stackoverflow.com', title: 'Stack Overflow' },
    ],
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    isLocked: false,
    order: 1
  },
  {
    id: 'group-3',
    name: '测试组 3 (全部重复)',
    tabs: [
      { id: 'tab-7', url: 'https://example.com', title: '示例网站 (重复2)' }, // 重复
      { id: 'tab-8', url: 'https://github.com', title: 'GitHub (重复)' }, // 重复
    ],
    createdAt: new Date(Date.now() - 2000).toISOString(),
    updatedAt: new Date(Date.now() - 2000).toISOString(),
    isLocked: false,
    order: 2
  }
];

/**
 * 测试去重功能
 */
async function testDeduplication() {
  console.log('🧪 开始测试去重功能');
  console.log('=' .repeat(50));

  try {
    // 1. 准备测试数据
    console.log('📝 准备测试数据...');
    const { storage } = await import('./src/shared/utils/storage.ts');
    
    // 保存包含重复标签的测试数据
    await storage.setGroups(testTabGroupsWithDuplicates);
    
    console.log('✅ 测试数据已保存');
    console.log('📊 原始数据统计:');
    console.log(`  - 标签组数量: ${testTabGroupsWithDuplicates.length}`);
    console.log(`  - 总标签数量: ${testTabGroupsWithDuplicates.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    
    // 统计重复标签
    const allUrls = [];
    testTabGroupsWithDuplicates.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) allUrls.push(tab.url);
      });
    });
    
    const uniqueUrls = new Set(allUrls);
    const duplicateCount = allUrls.length - uniqueUrls.size;
    console.log(`  - 重复标签数量: ${duplicateCount}`);
    console.log(`  - 唯一URL数量: ${uniqueUrls.size}`);
    
    console.log('');

    // 2. 执行去重操作
    console.log('🔄 执行去重操作...');
    
    // 动态导入 Redux store 和 action
    const { store } = await import('./src/app/store/index.ts');
    const { cleanDuplicateTabs } = await import('./src/features/tabs/store/tabGroupsSlice.ts');
    
    // 执行去重
    const result = await store.dispatch(cleanDuplicateTabs());
    
    if (cleanDuplicateTabs.fulfilled.match(result)) {
      console.log('✅ 去重操作成功');
      console.log('📊 去重结果:');
      console.log(`  - 移除的重复标签数量: ${result.payload.removedCount}`);
      console.log(`  - 剩余标签组数量: ${result.payload.updatedGroups.length}`);
      
      const remainingTabCount = result.payload.updatedGroups.reduce((sum, g) => sum + g.tabs.length, 0);
      console.log(`  - 剩余标签数量: ${remainingTabCount}`);
      
      // 验证结果
      console.log('');
      console.log('🔍 验证去重结果...');
      
      // 检查是否还有重复URL
      const remainingUrls = [];
      result.payload.updatedGroups.forEach(group => {
        group.tabs.forEach(tab => {
          if (tab.url) remainingUrls.push(tab.url);
        });
      });
      
      const remainingUniqueUrls = new Set(remainingUrls);
      const hasNoDuplicates = remainingUrls.length === remainingUniqueUrls.size;
      
      if (hasNoDuplicates) {
        console.log('✅ 验证通过：没有重复URL');
      } else {
        console.log('❌ 验证失败：仍存在重复URL');
        console.log(`  - 剩余URL总数: ${remainingUrls.length}`);
        console.log(`  - 唯一URL数量: ${remainingUniqueUrls.size}`);
      }
      
      // 检查空标签组是否被删除
      const emptyGroups = result.payload.updatedGroups.filter(g => g.tabs.length === 0);
      if (emptyGroups.length === 0) {
        console.log('✅ 验证通过：空标签组已被删除');
      } else {
        console.log(`❌ 验证失败：仍有 ${emptyGroups.length} 个空标签组`);
      }
      
      // 显示最终结果
      console.log('');
      console.log('📋 最终标签组详情:');
      result.payload.updatedGroups.forEach((group, index) => {
        console.log(`  ${index + 1}. ${group.name} (${group.tabs.length} 个标签)`);
        group.tabs.forEach((tab, tabIndex) => {
          console.log(`     ${tabIndex + 1}. ${tab.title} - ${tab.url}`);
        });
      });
      
      return {
        success: true,
        removedCount: result.payload.removedCount,
        remainingGroups: result.payload.updatedGroups.length,
        remainingTabs: remainingTabCount,
        hasNoDuplicates
      };
      
    } else {
      console.log('❌ 去重操作失败');
      console.error('错误信息:', result.error);
      return {
        success: false,
        error: result.error
      };
    }

  } catch (error) {
    console.error('❌ 测试过程中发生错误:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 测试边界情况
 */
async function testEdgeCases() {
  console.log('🧪 测试边界情况');
  console.log('=' .repeat(50));

  const edgeCases = [
    {
      name: '空标签组',
      groups: []
    },
    {
      name: '只有一个标签组',
      groups: [{
        id: 'single-group',
        name: '单个组',
        tabs: [
          { id: 'tab-1', url: 'https://example.com', title: '示例' }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: false,
        order: 0
      }]
    },
    {
      name: '没有URL的标签',
      groups: [{
        id: 'no-url-group',
        name: '无URL组',
        tabs: [
          { id: 'tab-1', url: '', title: '无URL标签1' },
          { id: 'tab-2', url: null, title: '无URL标签2' },
          { id: 'tab-3', url: 'https://example.com', title: '有URL标签' }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: false,
        order: 0
      }]
    }
  ];

  const results = [];

  for (const testCase of edgeCases) {
    console.log(`\n🔍 测试: ${testCase.name}`);
    
    try {
      const { storage } = await import('./src/shared/utils/storage.ts');
      await storage.setGroups(testCase.groups);
      
      const { store } = await import('./src/app/store/index.ts');
      const { cleanDuplicateTabs } = await import('./src/features/tabs/store/tabGroupsSlice.ts');
      
      const result = await store.dispatch(cleanDuplicateTabs());
      
      if (cleanDuplicateTabs.fulfilled.match(result)) {
        console.log(`✅ ${testCase.name} - 测试通过`);
        console.log(`   移除: ${result.payload.removedCount} 个重复标签`);
        console.log(`   剩余: ${result.payload.updatedGroups.length} 个标签组`);
        
        results.push({
          name: testCase.name,
          success: true,
          removedCount: result.payload.removedCount,
          remainingGroups: result.payload.updatedGroups.length
        });
      } else {
        console.log(`❌ ${testCase.name} - 测试失败`);
        results.push({
          name: testCase.name,
          success: false,
          error: result.error
        });
      }
      
    } catch (error) {
      console.log(`❌ ${testCase.name} - 测试异常:`, error.message);
      results.push({
        name: testCase.name,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始运行去重功能测试');
  console.log('时间:', new Date().toLocaleString());
  console.log('');

  // 基础功能测试
  const basicResult = await testDeduplication();
  console.log('');

  // 边界情况测试
  const edgeResults = await testEdgeCases();
  console.log('');

  // 汇总结果
  console.log('=' .repeat(50));
  console.log('📊 测试结果汇总');
  console.log('');

  console.log('基础功能测试:', basicResult.success ? '✅ 通过' : '❌ 失败');
  if (basicResult.success) {
    console.log(`  - 移除重复标签: ${basicResult.removedCount} 个`);
    console.log(`  - 剩余标签组: ${basicResult.remainingGroups} 个`);
    console.log(`  - 剩余标签: ${basicResult.remainingTabs} 个`);
    console.log(`  - 无重复验证: ${basicResult.hasNoDuplicates ? '✅' : '❌'}`);
  }

  console.log('');
  console.log('边界情况测试:');
  edgeResults.forEach(result => {
    console.log(`  - ${result.name}: ${result.success ? '✅ 通过' : '❌ 失败'}`);
  });

  const allPassed = basicResult.success && edgeResults.every(r => r.success);
  console.log('');
  console.log(`总体结果: ${allPassed ? '🎉 所有测试通过' : '⚠️ 部分测试失败'}`);

  return {
    basicResult,
    edgeResults,
    allPassed
  };
}

// 如果在浏览器环境中运行
if (typeof window !== 'undefined') {
  window.testDeduplication = runAllTests;
  console.log('💡 在浏览器控制台中运行 testDeduplication() 来执行测试');
}

// 导出测试函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runAllTests,
    testDeduplication,
    testEdgeCases
  };
}
