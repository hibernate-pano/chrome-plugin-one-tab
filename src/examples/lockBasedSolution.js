/**
 * 基于锁机制的批量删除解决方案示例
 * 仅作为技术对比，当前项目使用串行执行方案
 */

// 简单的互斥锁实现
class Mutex {
  constructor() {
    this.locked = false;
    this.waitQueue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  release() {
    if (this.waitQueue.length > 0) {
      const nextResolve = this.waitQueue.shift();
      nextResolve();
    } else {
      this.locked = false;
    }
  }
}

// 全局存储锁
const storageMutex = new Mutex();

// 基于锁的批量删除实现
const lockBasedHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  if (matchingTabs.length === 0) return;

  console.log(`🚀 开始基于锁的批量删除: ${matchingTabs.length} 个标签页`);

  const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
    if (group.isLocked) return acc;
    if (!acc[group.id]) {
      acc[group.id] = { group, tabsToRemove: [] };
    }
    acc[group.id].tabsToRemove.push(tab.id);
    return acc;
  }, {});

  console.log(`📋 需要处理 ${Object.keys(groupsToUpdate).length} 个标签组`);

  // 先在UI中更新标签组
  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    console.log(`🔄 UI更新: ${group.name}`);
  });

  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        console.log('💾 开始基于锁的并行存储操作...');
        
        // 使用锁保护的并行操作
        const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
          // 获取存储锁
          await storageMutex.acquire();
          console.log(`🔒 获取锁: ${group.name}`);
          
          try {
            if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
              console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
              await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
              console.log(`✅ 删除空标签组完成: ${group.id}`);
              return { action: 'delete', groupId: group.id };
            } else {
              const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
              const updatedGroup = {
                ...group,
                tabs: updatedTabs,
                updatedAt: new Date().toISOString()
              };
              console.log(`📝 准备更新标签组: ${group.name} (${group.id}), 剩余标签页: ${updatedTabs.length}`);
              await dispatch({ type: 'tabs/updateGroup', payload: updatedGroup }).unwrap();
              console.log(`✅ 更新标签组完成: ${group.id}, 剩余标签页: ${updatedTabs.length}`);
              return { action: 'update', groupId: group.id, remainingTabs: updatedTabs.length };
            }
          } finally {
            // 释放存储锁
            storageMutex.release();
            console.log(`🔓 释放锁: ${group.name}`);
          }
        });

        console.log('⏳ 等待所有锁保护的操作完成...');
        const results = await Promise.all(storagePromises);
        
        console.log('📊 基于锁的批量删除操作结果:');
        results.forEach((result, index) => {
          if (result.action === 'delete') {
            console.log(`  ${index + 1}. 删除标签组: ${result.groupId}`);
          } else {
            console.log(`  ${index + 1}. 更新标签组: ${result.groupId}, 剩余: ${result.remainingTabs} 个标签页`);
          }
        });

        showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
        console.log(`🎉 基于锁的批量删除操作完成 (处理了 ${results.length} 个标签组)`);
        
        resolve(results);
      } catch (error) {
        console.error('❌ 基于锁的批量删除操作失败:', error);
        showToast('删除操作失败，请重试', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) return false;
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 对比测试
const compareSolutions = async () => {
  console.log('🧪 对比串行执行 vs 锁机制解决方案\n');

  // 测试数据
  const testTabs = [
    { id: 'tab1', title: 'Google Search', url: 'https://google.com' },
    { id: 'tab2', title: 'Google Maps', url: 'https://maps.google.com' },
    { id: 'tab3', title: 'Google Drive', url: 'https://drive.google.com' }
  ];

  const testGroups = [
    {
      id: 'group1',
      name: 'Google Services',
      tabs: [testTabs[0], testTabs[1]],
      isLocked: false
    },
    {
      id: 'group2',
      name: 'Mixed',
      tabs: [testTabs[2]],
      isLocked: false
    }
  ];

  const googleMatches = [
    { tab: testTabs[0], group: testGroups[0] },
    { tab: testTabs[1], group: testGroups[0] },
    { tab: testTabs[2], group: testGroups[1] }
  ];

  const mockDispatch = (action) => ({
    unwrap: async () => {
      // 模拟随机延迟
      await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
      console.log(`📝 Mock dispatch: ${action.type}`);
      return action.payload;
    }
  });

  const mockToast = (msg, type) => console.log(`📢 Toast [${type}]: ${msg}`);

  console.log('=== 锁机制方案测试 ===');
  const startTime = Date.now();
  
  try {
    await lockBasedHandleDeleteAllSearchResults(googleMatches, mockDispatch, mockToast);
    const endTime = Date.now();
    console.log(`⏱️  锁机制方案耗时: ${endTime - startTime}ms`);
  } catch (error) {
    console.error('锁机制方案失败:', error);
  }
};

// 方案对比总结
console.log(`
📊 串行执行 vs 锁机制对比

┌─────────────────┬─────────────────┬─────────────────┐
│     特性        │    串行执行     │    锁机制       │
├─────────────────┼─────────────────┼─────────────────┤
│ 实现复杂度      │      简单       │      复杂       │
│ 性能表现        │      较低       │      较高       │
│ 可靠性          │      很高       │      中等       │
│ 维护成本        │      很低       │      较高       │
│ 死锁风险        │      无         │      有         │
│ 调试难度        │      简单       │      困难       │
│ 适用场景        │   小规模操作    │   大规模操作    │
└─────────────────┴─────────────────┴─────────────────┘

🎯 结论：
对于Chrome扩展的批量删除场景，串行执行是更好的选择：
1. 操作规模小（通常<10个标签组）
2. 用户体验要求稳定性 > 性能
3. 开发维护成本要求低
4. 单线程环境，不需要真正的并发控制
`);

export { lockBasedHandleDeleteAllSearchResults, Mutex, compareSolutions };
