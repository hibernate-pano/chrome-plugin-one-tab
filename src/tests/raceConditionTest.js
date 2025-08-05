/**
 * 竞态条件测试
 * 模拟真实环境中可能出现的竞态条件和并发问题
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 模拟Chrome扩展环境
global.chrome = {
  storage: {
    local: {
      data: {},
      operationCount: 0,
      pendingOperations: new Set(),
      get: function(keys) {
        this.operationCount++;
        const opId = `GET-${this.operationCount}`;
        this.pendingOperations.add(opId);
        
        console.log(`📖 [${opId}] Storage GET 开始:`, keys);
        
        // 模拟随机延迟
        const delay = Math.random() * 50 + 10;
        
        return new Promise(resolve => {
          setTimeout(() => {
            if (typeof keys === 'string') {
              const result = { [keys]: this.data[keys] };
              console.log(`📖 [${opId}] Storage GET 完成 (延迟${delay.toFixed(1)}ms):`, result[keys] ? `${result[keys].length} 个标签组` : '空');
              this.pendingOperations.delete(opId);
              resolve(result);
            } else {
              console.log(`📖 [${opId}] Storage GET 完成 (延迟${delay.toFixed(1)}ms)`);
              this.pendingOperations.delete(opId);
              resolve(this.data);
            }
          }, delay);
        });
      },
      set: function(items) {
        this.operationCount++;
        const opId = `SET-${this.operationCount}`;
        this.pendingOperations.add(opId);
        
        console.log(`💾 [${opId}] Storage SET 开始:`, Object.keys(items));
        if (items.tab_groups) {
          console.log(`   准备保存 ${items.tab_groups.length} 个标签组`);
        }
        
        // 模拟随机延迟
        const delay = Math.random() * 100 + 20;
        
        return new Promise(resolve => {
          setTimeout(() => {
            Object.assign(this.data, items);
            console.log(`💾 [${opId}] Storage SET 完成 (延迟${delay.toFixed(1)}ms)`);
            this.pendingOperations.delete(opId);
            resolve();
          }, delay);
        });
      },
      clear: function() {
        this.data = {};
        this.operationCount = 0;
        this.pendingOperations.clear();
        return Promise.resolve();
      },
      getPendingOperations: function() {
        return Array.from(this.pendingOperations);
      }
    }
  }
};

// 模拟存储API
const STORAGE_KEYS = { GROUPS: 'tab_groups' };

class RaceConditionStorage {
  constructor() {
    this.operationId = 0;
  }

  async getGroups() {
    this.operationId++;
    const opId = this.operationId;
    
    const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
    const groups = result[STORAGE_KEYS.GROUPS] || [];
    
    return groups;
  }

  async setGroups(groups) {
    this.operationId++;
    const opId = this.operationId;
    
    await chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups });
  }
}

const storage = new RaceConditionStorage();

// 模拟Redux actions with race conditions
const createRaceConditionDispatch = () => {
  let actionId = 0;
  
  return (action) => {
    actionId++;
    const currentActionId = actionId;
    
    return {
      unwrap: async () => {
        console.log(`🎬 [Action-${currentActionId}] 开始: ${action.type}`);
        
        // 模拟更长的随机延迟来增加竞态条件的可能性
        const delay = Math.random() * 200 + 50;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        if (action.type === 'tabs/deleteGroup') {
          console.log(`🗑️  [Action-${currentActionId}] 执行删除标签组: ${action.payload}`);
          const groups = await storage.getGroups();
          const beforeCount = groups.length;
          const updatedGroups = groups.filter(g => g.id !== action.payload);
          await storage.setGroups(updatedGroups);
          console.log(`🗑️  [Action-${currentActionId}] 删除完成: ${beforeCount} -> ${updatedGroups.length} 个标签组 (延迟${delay.toFixed(1)}ms)`);
          return action.payload;
        } else if (action.type === 'tabs/updateGroup') {
          console.log(`📝 [Action-${currentActionId}] 执行更新标签组: ${action.payload.id}`);
          const groups = await storage.getGroups();
          const updatedGroups = groups.map(g => g.id === action.payload.id ? action.payload : g);
          await storage.setGroups(updatedGroups);
          console.log(`📝 [Action-${currentActionId}] 更新完成: ${action.payload.name} (${action.payload.tabs.length} 个标签页) (延迟${delay.toFixed(1)}ms)`);
          return action.payload;
        }
        
        return action.payload;
      }
    };
  };
};

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) return false;
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 当前有问题的实现
const problematicBatchDelete = async (matchingTabs, dispatch, showToast) => {
  console.log(`\n🚀 [PROBLEMATIC] 开始批量删除: ${matchingTabs.length} 个标签页`);
  
  if (matchingTabs.length === 0) return;

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

  // 问题：使用setTimeout但不等待
  setTimeout(async () => {
    try {
      console.log('💾 [PROBLEMATIC] 开始存储操作...');
      
      const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
        if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
          console.log(`🗑️  [PROBLEMATIC] 准备删除: ${group.name}`);
          await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
          return { action: 'delete', groupId: group.id };
        } else {
          const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
          const updatedGroup = { ...group, tabs: updatedTabs, updatedAt: new Date().toISOString() };
          console.log(`📝 [PROBLEMATIC] 准备更新: ${group.name} -> ${updatedTabs.length} 个标签页`);
          await dispatch({ type: 'tabs/updateGroup', payload: updatedGroup }).unwrap();
          return { action: 'update', groupId: group.id, remainingTabs: updatedTabs.length };
        }
      });

      const results = await Promise.all(storagePromises);
      console.log(`🎉 [PROBLEMATIC] 完成 (${results.length} 个操作)`);
      showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
      
    } catch (error) {
      console.error('❌ [PROBLEMATIC] 失败:', error);
      showToast('删除操作失败', 'error');
    }
  }, 50);
  
  console.log('🏃 [PROBLEMATIC] 函数立即返回');
};

// 修复后的实现
const fixedBatchDelete = async (matchingTabs, dispatch, showToast) => {
  console.log(`\n🚀 [FIXED] 开始批量删除: ${matchingTabs.length} 个标签页`);
  
  if (matchingTabs.length === 0) return;

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

  // 修复：使用Promise包装setTimeout
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        console.log('💾 [FIXED] 开始存储操作...');
        
        const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
          if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
            console.log(`🗑️  [FIXED] 准备删除: ${group.name}`);
            await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
            return { action: 'delete', groupId: group.id };
          } else {
            const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
            const updatedGroup = { ...group, tabs: updatedTabs, updatedAt: new Date().toISOString() };
            console.log(`📝 [FIXED] 准备更新: ${group.name} -> ${updatedTabs.length} 个标签页`);
            await dispatch({ type: 'tabs/updateGroup', payload: updatedGroup }).unwrap();
            return { action: 'update', groupId: group.id, remainingTabs: updatedTabs.length };
          }
        });

        const results = await Promise.all(storagePromises);
        console.log(`🎉 [FIXED] 完成 (${results.length} 个操作)`);
        showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
        
        resolve(results);
      } catch (error) {
        console.error('❌ [FIXED] 失败:', error);
        showToast('删除操作失败', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 竞态条件测试
const runRaceConditionTest = async () => {
  console.log('🧪 开始竞态条件测试...\n');

  // 准备复杂的测试数据
  const testTabs = [
    { id: 'tab1', title: 'Google Search', url: 'https://google.com' },
    { id: 'tab2', title: 'Google Maps', url: 'https://maps.google.com' },
    { id: 'tab3', title: 'Google Drive', url: 'https://drive.google.com' },
    { id: 'tab4', title: 'GitHub Issues', url: 'https://github.com/issues' },
    { id: 'tab5', title: 'GitHub Pull Requests', url: 'https://github.com/pulls' },
    { id: 'tab6', title: 'YouTube', url: 'https://youtube.com' }
  ];

  const testGroups = [
    {
      id: 'group1',
      name: 'Google Services',
      tabs: [testTabs[0], testTabs[1]], // 2个Google标签页，删除后还剩1个
      isLocked: false
    },
    {
      id: 'group2', 
      name: 'Development',
      tabs: [testTabs[3], testTabs[4]], // 2个GitHub标签页，删除后还剩1个
      isLocked: false
    },
    {
      id: 'group3',
      name: 'Mixed',
      tabs: [testTabs[2], testTabs[5]], // 1个Google + 1个YouTube，删除Google后剩YouTube
      isLocked: false
    }
  ];

  // 测试场景：搜索"google"，应该匹配3个标签页，来自3个不同的标签组
  const googleMatches = [
    { tab: testTabs[0], group: testGroups[0] }, // Google Search from Google Services
    { tab: testTabs[1], group: testGroups[0] }, // Google Maps from Google Services  
    { tab: testTabs[2], group: testGroups[2] }  // Google Drive from Mixed
  ];

  console.log('📝 测试场景：删除3个Google标签页，来自3个不同标签组');
  console.log('预期结果：');
  console.log('  - Google Services: 2个标签页 -> 0个标签页 (应该被删除)');
  console.log('  - Development: 2个标签页 -> 2个标签页 (不变)');
  console.log('  - Mixed: 2个标签页 -> 1个标签页 (保留YouTube)');

  // 运行多次测试来检测竞态条件
  for (let i = 1; i <= 3; i++) {
    console.log(`\n=== 第 ${i} 次测试 ===`);
    
    // 清空并初始化数据
    await chrome.storage.local.clear();
    await storage.setGroups(testGroups);
    
    const mockDispatch = createRaceConditionDispatch();
    const mockToast = (msg, type) => console.log(`📢 Toast [${type}]: ${msg}`);
    
    console.log(`🔴 测试有问题的实现 (第${i}次)...`);
    
    // 记录开始时间
    const startTime = Date.now();
    
    // 执行有问题的批量删除
    await problematicBatchDelete(googleMatches, mockDispatch, mockToast);
    
    // 等待一段时间让setTimeout执行
    console.log('⏰ 等待异步操作完成...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 检查是否还有待处理的操作
    const pendingOps = chrome.storage.local.getPendingOperations();
    if (pendingOps.length > 0) {
      console.log(`⚠️  仍有 ${pendingOps.length} 个待处理的存储操作:`, pendingOps);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // 验证结果
    const finalGroups = await storage.getGroups();
    console.log(`📊 第${i}次测试结果: ${finalGroups.length} 个标签组`);
    
    finalGroups.forEach(g => {
      console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
    });
    
    // 检查是否有Google标签页残留
    const allTabs = finalGroups.flatMap(g => g.tabs);
    const remainingGoogleTabs = allTabs.filter(tab => 
      tab.title.toLowerCase().includes('google') || tab.url.toLowerCase().includes('google')
    );
    
    if (remainingGoogleTabs.length > 0) {
      console.log(`❌ 第${i}次测试失败: 仍有 ${remainingGoogleTabs.length} 个Google标签页未被删除`);
      remainingGoogleTabs.forEach(tab => {
        console.log(`  - ${tab.title}`);
      });
      return false;
    } else {
      console.log(`✅ 第${i}次测试通过: 所有Google标签页已删除`);
    }
    
    const endTime = Date.now();
    console.log(`⏱️  第${i}次测试耗时: ${endTime - startTime}ms`);
  }

  console.log('\n🎉 所有竞态条件测试通过！');
  return true;
};

// 运行测试
runRaceConditionTest().then(success => {
  if (success) {
    console.log('\n✅ 竞态条件测试通过！');
    process.exit(0);
  } else {
    console.log('\n❌ 竞态条件测试失败！');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 测试执行失败:', error);
  process.exit(1);
});
