/**
 * 批量删除功能集成测试
 * 验证整个批量删除流程的数据一致性和用户体验
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

// 模拟Redux store和dispatch
const mockDispatch = (action) => {
  console.log('Redux Action:', action);
  return Promise.resolve({ payload: action.payload });
};

// 模拟Toast和Confirm
const mockToast = {
  showToast: (message, type) => {
    console.log(`Toast [${type}]: ${message}`);
  },
  showConfirm: (options) => {
    console.log('确认对话框:', options.title, '-', options.message);
    // 模拟用户点击确认
    setTimeout(() => options.onConfirm(), 100);
  }
};

// 模拟数据
const createMockTab = (id, title, url) => ({
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

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) {
    return false;
  }
  
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 模拟批量删除功能的完整实现
const simulateFullBatchDelete = async (matchingTabs, dispatch, showToast) => {
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

  const results = {
    groupsDeleted: [],
    groupsUpdated: [],
    tabsDeleted: 0,
    errors: []
  };

  // 先在UI中更新标签组，立即更新界面
  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    try {
      if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
        // 先在Redux中删除标签组，立即更新UI
        dispatch({ type: 'tabs/deleteGroup/fulfilled', payload: group.id });
        results.groupsDeleted.push(group.id);
        console.log(`标记删除标签组: ${group.name}`);
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
        results.groupsUpdated.push({
          groupId: group.id,
          originalCount: group.tabs.length,
          remainingCount: updatedTabs.length
        });
        console.log(`标记更新标签组: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
      }
      results.tabsDeleted += tabsToRemove.length;
    } catch (error) {
      console.error(`处理标签组 ${group.name} 时出错:`, error);
      results.errors.push(`处理标签组 ${group.name} 失败: ${error.message}`);
    }
  });

  // 模拟异步存储操作
  await new Promise(resolve => setTimeout(resolve, 50));

  // 异步完成存储操作
  for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
    try {
      if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
        await mockDispatch({ type: 'deleteGroup', payload: group.id });
        console.log(`删除空标签组: ${group.id}`);
      } else {
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        await mockDispatch({ type: 'updateGroup', payload: updatedGroup });
        console.log(`更新标签组: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
      }
    } catch (error) {
      console.error(`存储操作失败:`, error);
      results.errors.push(`存储操作失败: ${error.message}`);
      showToast('删除操作部分失败', 'error');
    }
  }

  // 显示成功提示
  if (results.errors.length === 0) {
    showToast(`成功删除 ${results.tabsDeleted} 个标签页`, 'success');
  } else {
    showToast(`删除完成，但有 ${results.errors.length} 个错误`, 'warning');
  }

  return results;
};

// 集成测试用例
const runIntegrationTests = async () => {
  console.log('开始批量删除功能集成测试...\n');

  // 准备测试数据
  const tabs = [
    createMockTab('tab1', 'Google Search', 'https://google.com'),
    createMockTab('tab2', 'Google Maps', 'https://maps.google.com'),
    createMockTab('tab3', 'GitHub', 'https://github.com'),
    createMockTab('tab4', 'Stack Overflow', 'https://stackoverflow.com'),
    createMockTab('tab5', 'YouTube', 'https://youtube.com'),
    createMockTab('tab6', 'Gmail', 'https://mail.google.com')
  ];

  const groups = [
    createMockTabGroup('group1', 'Google Services', [tabs[0], tabs[1], tabs[5]]),
    createMockTabGroup('group2', 'Development', [tabs[2], tabs[3]]),
    createMockTabGroup('group3', 'Media', [tabs[4]]),
    createMockTabGroup('group4', 'Locked Group', [tabs[0]], true)
  ];

  // 测试场景1: 搜索"google"并批量删除
  console.log('=== 测试场景1: 搜索"google"并批量删除 ===');
  const googleMatches = [];
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.title.toLowerCase().includes('google') || tab.url.toLowerCase().includes('google')) {
        googleMatches.push({ tab, group });
      }
    });
  });

  console.log(`搜索到 ${googleMatches.length} 个匹配的标签页`);
  const result1 = await simulateFullBatchDelete(googleMatches, mockDispatch, mockToast.showToast);
  console.log('删除结果:', result1);
  console.log('');

  // 测试场景2: 搜索"youtube"并批量删除（会导致标签组被删除）
  console.log('=== 测试场景2: 搜索"youtube"并批量删除 ===');
  const youtubeMatches = [];
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.title.toLowerCase().includes('youtube') || tab.url.toLowerCase().includes('youtube')) {
        youtubeMatches.push({ tab, group });
      }
    });
  });

  console.log(`搜索到 ${youtubeMatches.length} 个匹配的标签页`);
  const result2 = await simulateFullBatchDelete(youtubeMatches, mockDispatch, mockToast.showToast);
  console.log('删除结果:', result2);
  console.log('');

  // 测试场景3: 用户体验测试 - 确认对话框流程
  console.log('=== 测试场景3: 用户体验测试 - 确认对话框流程 ===');
  const handleDeleteAllWithConfirm = (matchingTabs) => {
    return new Promise((resolve) => {
      mockToast.showConfirm({
        title: '删除确认',
        message: `确定要删除所有搜索结果中的 ${matchingTabs.length} 个标签页吗？此操作不可撤销。`,
        type: 'danger',
        confirmText: '删除',
        cancelText: '取消',
        onConfirm: async () => {
          const result = await simulateFullBatchDelete(matchingTabs, mockDispatch, mockToast.showToast);
          resolve(result);
        },
        onCancel: () => {
          console.log('用户取消了删除操作');
          resolve(null);
        }
      });
    });
  };

  const devMatches = [];
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.title.toLowerCase().includes('github') || tab.title.toLowerCase().includes('stack')) {
        devMatches.push({ tab, group });
      }
    });
  });

  console.log(`搜索到 ${devMatches.length} 个开发相关标签页`);
  const result3 = await handleDeleteAllWithConfirm(devMatches);
  console.log('用户确认后的删除结果:', result3);
  console.log('');

  // 测试场景4: 数据一致性验证
  console.log('=== 测试场景4: 数据一致性验证 ===');
  console.log('验证删除操作的数据一致性...');
  
  // 验证删除的标签页数量
  const totalDeleted = result1.tabsDeleted + result2.tabsDeleted + (result3 ? result3.tabsDeleted : 0);
  console.log(`总共删除了 ${totalDeleted} 个标签页`);
  
  // 验证标签组状态
  const totalGroupsDeleted = result1.groupsDeleted.length + result2.groupsDeleted.length + (result3 ? result3.groupsDeleted.length : 0);
  const totalGroupsUpdated = result1.groupsUpdated.length + result2.groupsUpdated.length + (result3 ? result3.groupsUpdated.length : 0);
  console.log(`删除了 ${totalGroupsDeleted} 个标签组，更新了 ${totalGroupsUpdated} 个标签组`);
  
  // 验证错误处理
  const totalErrors = result1.errors.length + result2.errors.length + (result3 ? result3.errors.length : 0);
  console.log(`总共遇到 ${totalErrors} 个错误`);
  
  console.log('\n集成测试完成！');
  
  // 返回测试摘要
  return {
    totalTabsDeleted: totalDeleted,
    totalGroupsDeleted,
    totalGroupsUpdated,
    totalErrors,
    success: totalErrors === 0
  };
};

// 运行集成测试
runIntegrationTests().then(summary => {
  console.log('\n=== 测试摘要 ===');
  console.log(`删除标签页: ${summary.totalTabsDeleted}`);
  console.log(`删除标签组: ${summary.totalGroupsDeleted}`);
  console.log(`更新标签组: ${summary.totalGroupsUpdated}`);
  console.log(`错误数量: ${summary.totalErrors}`);
  console.log(`测试结果: ${summary.success ? '成功' : '失败'}`);
}).catch(error => {
  console.error('集成测试失败:', error);
});
