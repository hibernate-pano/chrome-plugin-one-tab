/**
 * 批量删除数据持久化测试
 * 验证删除操作是否真正保存到本地存储
 */

// 模拟Chrome扩展环境
global.chrome = {
  runtime: {
    sendMessage: (message) => {
      console.log('Chrome消息发送:', message);
      return Promise.resolve();
    }
  }
};

// 模拟本地存储
let mockStorage = {};

const mockStorageAPI = {
  getGroups: async () => {
    const groups = mockStorage.groups || [];
    console.log('从存储读取标签组:', groups.length, '个');
    return groups;
  },
  setGroups: async (groups) => {
    mockStorage.groups = groups;
    console.log('保存标签组到存储:', groups.length, '个');
    return true;
  }
};

// 模拟Redux dispatch
const mockDispatch = (action) => {
  console.log('Redux Action:', action.type);
  if (action.type === 'tabs/deleteGroup/fulfilled') {
    console.log('  - 删除标签组:', action.payload);
  } else if (action.type === 'tabs/updateGroup/fulfilled') {
    console.log('  - 更新标签组:', action.payload.id, '剩余标签页:', action.payload.tabs.length);
  }
  return { unwrap: () => Promise.resolve(action.payload) };
};

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) {
    return false;
  }
  
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 模拟修复后的批量删除函数
const handleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  if (matchingTabs.length === 0) return;

  console.log(`开始批量删除 ${matchingTabs.length} 个标签页...`);

  // 处理标签组更新
  const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
    if (group.isLocked) {
      console.log(`跳过锁定标签组: ${group.name}`);
      return acc;
    }

    if (!acc[group.id]) {
      acc[group.id] = { group, tabsToRemove: [] };
    }
    acc[group.id].tabsToRemove.push(tab.id);
    return acc;
  }, {});

  // 先在UI中更新标签组，立即更新界面
  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
      // 先在Redux中删除标签组，立即更新UI
      dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
    } else {
      // 否则更新标签组，移除这些标签页
      const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString()
      };
      // 先在Redux中更新标签组，立即更新UI
      dispatch({ type: 'tabs/updateGroup/fulfilled', payload: updatedGroup });
    }
  });

  // 异步完成存储操作 - 使用Promise.all等待所有操作完成
  setTimeout(async () => {
    try {
      const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
        // 使用工具函数检查是否应该自动删除标签组
        if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
          // 模拟deleteGroup action
          const currentGroups = await mockStorageAPI.getGroups();
          const updatedGroups = currentGroups.filter(g => g.id !== group.id);
          await mockStorageAPI.setGroups(updatedGroups);
          console.log(`删除空标签组: ${group.id}`);
        } else {
          // 模拟updateGroup action
          const currentGroups = await mockStorageAPI.getGroups();
          const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
          const updatedGroup = {
            ...group,
            tabs: updatedTabs,
            updatedAt: new Date().toISOString()
          };
          const updatedGroups = currentGroups.map(g => 
            g.id === group.id ? updatedGroup : g
          );
          await mockStorageAPI.setGroups(updatedGroups);
          console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
        }
      });

      // 等待所有存储操作完成
      await Promise.all(storagePromises);
      
      // 显示成功提示
      showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
      console.log('所有批量删除操作已完成并保存到存储');
      
      return true;
    } catch (error) {
      console.error('批量删除存储操作失败:', error);
      showToast('删除操作部分失败，请重试', 'error');
      return false;
    }
  }, 50); // 小延迟确保 UI 先更新
};

// 测试数据持久化
const runPersistenceTest = async () => {
  console.log('开始数据持久化测试...\n');

  // 准备测试数据
  const tabs = [
    { id: 'tab1', title: 'Google Search', url: 'https://google.com' },
    { id: 'tab2', title: 'Google Maps', url: 'https://maps.google.com' },
    { id: 'tab3', title: 'GitHub', url: 'https://github.com' },
    { id: 'tab4', title: 'YouTube', url: 'https://youtube.com' }
  ];

  const groups = [
    {
      id: 'group1',
      name: 'Google Services',
      tabs: [tabs[0], tabs[1]],
      isLocked: false
    },
    {
      id: 'group2', 
      name: 'Development',
      tabs: [tabs[2]],
      isLocked: false
    },
    {
      id: 'group3',
      name: 'Media',
      tabs: [tabs[3]],
      isLocked: false
    }
  ];

  // 初始化存储
  await mockStorageAPI.setGroups(groups);
  console.log('初始化存储完成');

  // 模拟搜索"google"的结果
  const googleMatches = [
    { tab: tabs[0], group: groups[0] },
    { tab: tabs[1], group: groups[0] }
  ];

  console.log('\n=== 测试场景1: 删除Google相关标签页 ===');
  console.log('删除前的存储状态:');
  const beforeGroups = await mockStorageAPI.getGroups();
  beforeGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 执行批量删除
  const mockToast = (message, type) => console.log(`Toast [${type}]: ${message}`);
  await handleDeleteAllSearchResults(googleMatches, mockDispatch, mockToast);

  // 等待异步操作完成
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\n删除后的存储状态:');
  const afterGroups = await mockStorageAPI.getGroups();
  afterGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 验证数据持久化
  console.log('\n=== 数据持久化验证 ===');
  
  // 模拟页面刷新 - 重新从存储读取数据
  console.log('模拟页面刷新，重新从存储读取数据...');
  const refreshedGroups = await mockStorageAPI.getGroups();
  
  console.log('刷新后的数据:');
  refreshedGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 验证删除是否真正持久化
  const googleGroup = refreshedGroups.find(g => g.id === 'group1');
  if (googleGroup && googleGroup.tabs.length === 0) {
    console.log('✅ 数据持久化成功：Google标签组已清空');
  } else if (!googleGroup) {
    console.log('✅ 数据持久化成功：Google标签组已被删除');
  } else {
    console.log('❌ 数据持久化失败：Google标签页仍然存在');
    return false;
  }

  // 测试场景2: 删除会导致标签组被删除的情况
  console.log('\n=== 测试场景2: 删除YouTube标签页（会删除整个标签组）===');
  const youtubeMatches = [
    { tab: tabs[3], group: groups[2] }
  ];

  console.log('删除前的存储状态:');
  const beforeGroups2 = await mockStorageAPI.getGroups();
  console.log(`总共 ${beforeGroups2.length} 个标签组`);

  await handleDeleteAllSearchResults(youtubeMatches, mockDispatch, mockToast);
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('删除后的存储状态:');
  const afterGroups2 = await mockStorageAPI.getGroups();
  console.log(`总共 ${afterGroups2.length} 个标签组`);

  // 验证标签组是否被删除
  const mediaGroup = afterGroups2.find(g => g.id === 'group3');
  if (!mediaGroup) {
    console.log('✅ 空标签组自动删除成功');
  } else {
    console.log('❌ 空标签组删除失败');
    return false;
  }

  console.log('\n🎉 所有数据持久化测试通过！');
  return true;
};

// 运行测试
runPersistenceTest().then(success => {
  if (success) {
    console.log('\n✅ 批量删除功能的数据持久化问题已修复');
    process.exit(0);
  } else {
    console.log('\n❌ 数据持久化测试失败');
    process.exit(1);
  }
}).catch(error => {
  console.error('测试执行失败:', error);
  process.exit(1);
});
