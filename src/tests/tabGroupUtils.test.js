/**
 * 测试 tabGroupUtils 工具函数
 * 这是一个简单的测试文件，用于验证批量删除功能的核心逻辑
 */

// 模拟 TabGroup 和 Tab 类型
const createMockTab = (id, title = 'Test Tab', url = 'https://example.com') => ({
  id,
  title,
  url,
  favicon: '',
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString()
});

const createMockTabGroup = (id, name, tabs, isLocked = false) => ({
  id,
  name,
  tabs,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isLocked
});

// 导入要测试的函数（在实际环境中需要适当的模块导入）
// 这里我们直接复制函数实现进行测试
const shouldAutoDeleteAfterTabRemoval = (group, tabIdToDelete) => {
  if (group.isLocked) {
    return false;
  }
  
  const remainingTabsCount = group.tabs.filter(tab => tab.id !== tabIdToDelete).length;
  return remainingTabsCount === 0;
};

const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) {
    return false;
  }
  
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 测试用例
const runTests = () => {
  console.log('开始测试 tabGroupUtils...');
  
  // 测试 1: shouldAutoDeleteAfterTabRemoval - 正常删除单个标签页
  console.log('\n测试 1: shouldAutoDeleteAfterTabRemoval - 正常删除单个标签页');
  const tab1 = createMockTab('tab1');
  const tab2 = createMockTab('tab2');
  const group1 = createMockTabGroup('group1', 'Test Group', [tab1, tab2]);
  
  const result1 = shouldAutoDeleteAfterTabRemoval(group1, 'tab1');
  console.log(`删除一个标签页后是否应该删除标签组: ${result1} (期望: false)`);
  console.assert(result1 === false, '删除一个标签页后不应该删除标签组');
  
  // 测试 2: shouldAutoDeleteAfterTabRemoval - 删除最后一个标签页
  console.log('\n测试 2: shouldAutoDeleteAfterTabRemoval - 删除最后一个标签页');
  const singleTabGroup = createMockTabGroup('group2', 'Single Tab Group', [tab1]);
  
  const result2 = shouldAutoDeleteAfterTabRemoval(singleTabGroup, 'tab1');
  console.log(`删除最后一个标签页后是否应该删除标签组: ${result2} (期望: true)`);
  console.assert(result2 === true, '删除最后一个标签页后应该删除标签组');
  
  // 测试 3: shouldAutoDeleteAfterTabRemoval - 锁定的标签组
  console.log('\n测试 3: shouldAutoDeleteAfterTabRemoval - 锁定的标签组');
  const lockedGroup = createMockTabGroup('group3', 'Locked Group', [tab1], true);
  
  const result3 = shouldAutoDeleteAfterTabRemoval(lockedGroup, 'tab1');
  console.log(`删除锁定标签组的最后一个标签页后是否应该删除标签组: ${result3} (期望: false)`);
  console.assert(result3 === false, '锁定的标签组不应该被自动删除');
  
  // 测试 4: shouldAutoDeleteAfterMultipleTabRemoval - 批量删除部分标签页
  console.log('\n测试 4: shouldAutoDeleteAfterMultipleTabRemoval - 批量删除部分标签页');
  const tab3 = createMockTab('tab3');
  const multiTabGroup = createMockTabGroup('group4', 'Multi Tab Group', [tab1, tab2, tab3]);
  
  const result4 = shouldAutoDeleteAfterMultipleTabRemoval(multiTabGroup, ['tab1', 'tab2']);
  console.log(`批量删除部分标签页后是否应该删除标签组: ${result4} (期望: false)`);
  console.assert(result4 === false, '批量删除部分标签页后不应该删除标签组');
  
  // 测试 5: shouldAutoDeleteAfterMultipleTabRemoval - 批量删除所有标签页
  console.log('\n测试 5: shouldAutoDeleteAfterMultipleTabRemoval - 批量删除所有标签页');
  const result5 = shouldAutoDeleteAfterMultipleTabRemoval(multiTabGroup, ['tab1', 'tab2', 'tab3']);
  console.log(`批量删除所有标签页后是否应该删除标签组: ${result5} (期望: true)`);
  console.assert(result5 === true, '批量删除所有标签页后应该删除标签组');
  
  // 测试 6: shouldAutoDeleteAfterMultipleTabRemoval - 锁定标签组的批量删除
  console.log('\n测试 6: shouldAutoDeleteAfterMultipleTabRemoval - 锁定标签组的批量删除');
  const lockedMultiTabGroup = createMockTabGroup('group5', 'Locked Multi Tab Group', [tab1, tab2], true);
  
  const result6 = shouldAutoDeleteAfterMultipleTabRemoval(lockedMultiTabGroup, ['tab1', 'tab2']);
  console.log(`批量删除锁定标签组的所有标签页后是否应该删除标签组: ${result6} (期望: false)`);
  console.assert(result6 === false, '锁定的标签组不应该被自动删除');
  
  // 测试 7: 边界情况 - 空标签组
  console.log('\n测试 7: 边界情况 - 空标签组');
  const emptyGroup = createMockTabGroup('group6', 'Empty Group', []);
  
  const result7 = shouldAutoDeleteAfterMultipleTabRemoval(emptyGroup, []);
  console.log(`空标签组批量删除空数组后是否应该删除标签组: ${result7} (期望: true)`);
  console.assert(result7 === true, '空标签组应该被自动删除');
  
  // 测试 8: 边界情况 - 删除不存在的标签页
  console.log('\n测试 8: 边界情况 - 删除不存在的标签页');
  const result8 = shouldAutoDeleteAfterMultipleTabRemoval(multiTabGroup, ['nonexistent']);
  console.log(`删除不存在的标签页后是否应该删除标签组: ${result8} (期望: false)`);
  console.assert(result8 === false, '删除不存在的标签页不应该影响标签组');
  
  console.log('\n所有测试完成！');
};

// 运行测试
runTests();
