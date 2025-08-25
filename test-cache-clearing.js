/**
 * 缓存清理测试脚本
 * 验证去重操作后缓存是否被正确清理
 */

// 测试数据 - 包含重复标签的标签组
const testDataWithDuplicates = [
  {
    id: 'test-group-1',
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
    id: 'test-group-2',
    name: '测试组 2',
    tabs: [
      { id: 'tab-4', url: 'https://github.com', title: 'GitHub' },
      { id: 'tab-5', url: 'https://google.com', title: 'Google (重复)' }, // 重复
    ],
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    isLocked: false,
    order: 1
  }
];

/**
 * 测试缓存清理功能
 */
async function testCacheClearing() {
  console.log('🧪 开始测试缓存清理功能');
  console.log('=' .repeat(50));

  try {
    // 1. 准备测试数据
    console.log('📝 准备测试数据...');
    const { storage } = await import('./src/shared/utils/storage.ts');
    
    // 保存测试数据
    await storage.setGroups(testDataWithDuplicates);
    
    // 验证数据已保存
    const savedGroups = await storage.getGroups();
    console.log(`✅ 测试数据已保存: ${savedGroups.length} 个标签组`);
    console.log(`   总标签数: ${savedGroups.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    
    // 2. 获取初始 Redux 状态
    console.log('\n📊 获取初始 Redux 状态...');
    const { store } = await import('./src/app/store/index.ts');
    const initialState = store.getState().tabGroups;
    console.log(`   Redux 中的标签组数: ${initialState.groups.length}`);
    
    // 3. 执行去重操作
    console.log('\n🔄 执行去重操作...');
    const { cleanDuplicateTabs } = await import('./src/features/tabs/store/tabGroupsSlice.ts');
    
    const startTime = Date.now();
    const result = await store.dispatch(cleanDuplicateTabs());
    const endTime = Date.now();
    
    console.log(`⏱️  去重操作耗时: ${endTime - startTime}ms`);
    
    if (cleanDuplicateTabs.fulfilled.match(result)) {
      console.log('✅ 去重操作成功');
      console.log(`   移除的重复标签: ${result.payload.removedCount} 个`);
      console.log(`   剩余标签组: ${result.payload.updatedGroups.length} 个`);
      console.log(`   同步状态: ${result.payload.syncSuccess ? '成功' : '失败'}`);
    } else {
      console.log('❌ 去重操作失败');
      console.error('错误信息:', result.error);
      return false;
    }
    
    // 4. 等待缓存清理和重新加载完成
    console.log('\n⏳ 等待缓存清理和重新加载...');
    await new Promise(resolve => setTimeout(resolve, 500)); // 等待500ms
    
    // 5. 验证存储状态
    console.log('\n🔍 验证存储状态...');
    const storageGroups = await storage.getGroups();
    console.log(`   存储中的标签组数: ${storageGroups.length}`);
    console.log(`   存储中的总标签数: ${storageGroups.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    
    // 6. 验证 Redux 状态
    console.log('\n🔍 验证 Redux 状态...');
    const finalState = store.getState().tabGroups;
    console.log(`   Redux 中的标签组数: ${finalState.groups.length}`);
    console.log(`   Redux 中的总标签数: ${finalState.groups.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    
    // 7. 检查数据一致性
    console.log('\n✅ 检查数据一致性...');
    const storageConsistent = storageGroups.length === finalState.groups.length;
    const tabCountConsistent = 
      storageGroups.reduce((sum, g) => sum + g.tabs.length, 0) === 
      finalState.groups.reduce((sum, g) => sum + g.tabs.length, 0);
    
    if (storageConsistent && tabCountConsistent) {
      console.log('✅ 数据一致性检查通过');
      console.log('   存储和 Redux 状态完全一致');
    } else {
      console.log('❌ 数据一致性检查失败');
      console.log(`   存储标签组数: ${storageGroups.length}, Redux 标签组数: ${finalState.groups.length}`);
      console.log(`   存储标签数: ${storageGroups.reduce((sum, g) => sum + g.tabs.length, 0)}, Redux 标签数: ${finalState.groups.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    }
    
    // 8. 检查重复标签是否真的被移除
    console.log('\n🔍 检查重复标签移除效果...');
    const allUrls = [];
    finalState.groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) allUrls.push(tab.url);
      });
    });
    
    const uniqueUrls = new Set(allUrls);
    const hasNoDuplicates = allUrls.length === uniqueUrls.size;
    
    if (hasNoDuplicates) {
      console.log('✅ 重复标签已完全移除');
      console.log(`   唯一URL数量: ${uniqueUrls.size}`);
    } else {
      console.log('❌ 仍存在重复标签');
      console.log(`   总URL数: ${allUrls.length}, 唯一URL数: ${uniqueUrls.size}`);
    }
    
    // 9. 测试缓存管理器
    console.log('\n🧪 测试缓存管理器...');
    try {
      const { cacheManager } = await import('./src/shared/utils/cacheManager.ts');
      const stats = cacheManager.getCacheStats();
      console.log('📊 缓存统计:', stats);
      
      // 手动清理缓存
      await cacheManager.clearAll();
      console.log('✅ 手动缓存清理完成');
    } catch (error) {
      console.log('⚠️ 缓存管理器测试跳过:', error.message);
    }
    
    return {
      success: true,
      removedCount: result.payload.removedCount,
      finalGroupCount: finalState.groups.length,
      dataConsistent: storageConsistent && tabCountConsistent,
      noDuplicates: hasNoDuplicates,
      syncSuccess: result.payload.syncSuccess
    };
    
  } catch (error) {
    console.error('❌ 测试过程中发生错误:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 模拟页面刷新测试
 */
async function testPageRefresh() {
  console.log('\n🔄 模拟页面刷新测试');
  console.log('=' .repeat(30));
  
  try {
    // 重新加载 Redux store
    const { store } = await import('./src/app/store/index.ts');
    const { loadGroups } = await import('./src/features/tabs/store/tabGroupsSlice.ts');
    
    console.log('📥 重新加载数据...');
    await store.dispatch(loadGroups());
    
    const state = store.getState().tabGroups;
    console.log(`✅ 页面刷新后数据加载完成`);
    console.log(`   标签组数: ${state.groups.length}`);
    console.log(`   总标签数: ${state.groups.reduce((sum, g) => sum + g.tabs.length, 0)}`);
    
    // 检查是否还有重复
    const allUrls = [];
    state.groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.url) allUrls.push(tab.url);
      });
    });
    
    const uniqueUrls = new Set(allUrls);
    const hasNoDuplicates = allUrls.length === uniqueUrls.size;
    
    if (hasNoDuplicates) {
      console.log('✅ 页面刷新后仍无重复标签');
    } else {
      console.log('❌ 页面刷新后出现重复标签');
      console.log(`   总URL数: ${allUrls.length}, 唯一URL数: ${uniqueUrls.size}`);
    }
    
    return {
      success: true,
      groupCount: state.groups.length,
      noDuplicates: hasNoDuplicates
    };
    
  } catch (error) {
    console.error('❌ 页面刷新测试失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 运行完整测试
 */
async function runFullTest() {
  console.log('🚀 开始运行缓存清理完整测试');
  console.log('时间:', new Date().toLocaleString());
  console.log('');

  // 基础缓存清理测试
  const cacheResult = await testCacheClearing();
  
  // 页面刷新测试
  const refreshResult = await testPageRefresh();
  
  // 汇总结果
  console.log('\n' + '=' .repeat(50));
  console.log('📊 测试结果汇总');
  console.log('');
  
  console.log('缓存清理测试:', cacheResult.success ? '✅ 通过' : '❌ 失败');
  if (cacheResult.success) {
    console.log(`  - 移除重复标签: ${cacheResult.removedCount} 个`);
    console.log(`  - 最终标签组数: ${cacheResult.finalGroupCount} 个`);
    console.log(`  - 数据一致性: ${cacheResult.dataConsistent ? '✅' : '❌'}`);
    console.log(`  - 无重复标签: ${cacheResult.noDuplicates ? '✅' : '❌'}`);
    console.log(`  - 同步状态: ${cacheResult.syncSuccess ? '✅' : '❌'}`);
  }
  
  console.log('');
  console.log('页面刷新测试:', refreshResult.success ? '✅ 通过' : '❌ 失败');
  if (refreshResult.success) {
    console.log(`  - 刷新后标签组数: ${refreshResult.groupCount} 个`);
    console.log(`  - 刷新后无重复: ${refreshResult.noDuplicates ? '✅' : '❌'}`);
  }
  
  const allPassed = cacheResult.success && refreshResult.success && 
                   cacheResult.dataConsistent && cacheResult.noDuplicates && 
                   refreshResult.noDuplicates;
  
  console.log('');
  console.log(`总体结果: ${allPassed ? '🎉 所有测试通过' : '⚠️ 部分测试失败'}`);
  
  if (allPassed) {
    console.log('✅ 缓存清理机制工作正常，去重后数据保持一致');
  } else {
    console.log('❌ 缓存清理机制存在问题，需要进一步调试');
  }

  return {
    cacheResult,
    refreshResult,
    allPassed
  };
}

// 如果在浏览器环境中运行
if (typeof window !== 'undefined') {
  window.testCacheClearing = runFullTest;
  console.log('💡 在浏览器控制台中运行 testCacheClearing() 来执行测试');
}

// 导出测试函数
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    runFullTest,
    testCacheClearing,
    testPageRefresh
  };
}
