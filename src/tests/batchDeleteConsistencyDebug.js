/**
 * 批量删除一致性问题调试工具
 * 详细追踪每个删除操作的执行情况，识别竞态条件和异步问题
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
      get: function(keys) {
        this.operationCount++;
        console.log(`📖 Storage GET #${this.operationCount}:`, keys);
        if (typeof keys === 'string') {
          const result = { [keys]: this.data[keys] };
          console.log(`   返回:`, Object.keys(result), result[keys] ? `(${result[keys].length} 个标签组)` : '(空)');
          return Promise.resolve(result);
        }
        return Promise.resolve(this.data);
      },
      set: function(items) {
        this.operationCount++;
        console.log(`💾 Storage SET #${this.operationCount}:`, Object.keys(items));
        if (items.tab_groups) {
          console.log(`   保存 ${items.tab_groups.length} 个标签组`);
        }
        Object.assign(this.data, items);
        return Promise.resolve();
      },
      clear: function() {
        this.data = {};
        this.operationCount = 0;
        return Promise.resolve();
      }
    }
  }
};

// 模拟存储API
const STORAGE_KEYS = { GROUPS: 'tab_groups' };

class DebugStorage {
  constructor() {
    this.operationId = 0;
  }

  async getGroups() {
    this.operationId++;
    const opId = this.operationId;
    console.log(`🔍 [${opId}] getGroups() 开始`);
    
    const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
    const groups = result[STORAGE_KEYS.GROUPS] || [];
    
    console.log(`🔍 [${opId}] getGroups() 完成: ${groups.length} 个标签组`);
    groups.forEach((g, i) => {
      console.log(`   ${i + 1}. ${g.name}: ${g.tabs.length} 个标签页`);
    });
    
    return groups;
  }

  async setGroups(groups) {
    this.operationId++;
    const opId = this.operationId;
    console.log(`💾 [${opId}] setGroups() 开始: ${groups.length} 个标签组`);
    
    await chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups });
    
    console.log(`💾 [${opId}] setGroups() 完成`);
    groups.forEach((g, i) => {
      console.log(`   ${i + 1}. ${g.name}: ${g.tabs.length} 个标签页`);
    });
  }
}

const storage = new DebugStorage();

// 模拟Redux actions with detailed logging
const createMockDispatch = () => {
  let actionId = 0;
  
  return (action) => {
    actionId++;
    const currentActionId = actionId;
    
    return {
      unwrap: async () => {
        console.log(`🎬 [Action-${currentActionId}] 开始执行: ${action.type}`);
        
        // 模拟网络延迟
        await new Promise(resolve => setTimeout(resolve, Math.random() * 20 + 10));
        
        if (action.type === 'tabs/deleteGroup') {
          console.log(`🗑️  [Action-${currentActionId}] 删除标签组: ${action.payload}`);
          const groups = await storage.getGroups();
          const beforeCount = groups.length;
          const updatedGroups = groups.filter(g => g.id !== action.payload);
          await storage.setGroups(updatedGroups);
          console.log(`🗑️  [Action-${currentActionId}] 删除完成: ${beforeCount} -> ${updatedGroups.length} 个标签组`);
          return action.payload;
        } else if (action.type === 'tabs/updateGroup') {
          console.log(`📝 [Action-${currentActionId}] 更新标签组: ${action.payload.id}`);
          const groups = await storage.getGroups();
          const updatedGroups = groups.map(g => g.id === action.payload.id ? action.payload : g);
          await storage.setGroups(updatedGroups);
          console.log(`📝 [Action-${currentActionId}] 更新完成: ${action.payload.name} (${action.payload.tabs.length} 个标签页)`);
          return action.payload;
        }
        
        console.log(`✅ [Action-${currentActionId}] 执行完成`);
        return action.payload;
      }
    };
  };
};

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) {
    console.log(`🔒 标签组 ${group.name} 已锁定，不会被删除`);
    return false;
  }
  
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  const shouldDelete = remainingTabsCount === 0;
  
  console.log(`🤔 标签组 ${group.name}: 删除 ${tabIdsToDelete.length} 个标签页后剩余 ${remainingTabsCount} 个 -> ${shouldDelete ? '删除标签组' : '保留标签组'}`);
  
  return shouldDelete;
};

// 当前有问题的批量删除函数（从SearchResultList.tsx复制）
const problematicHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  console.log(`\n🚀 [PROBLEMATIC] 开始批量删除: ${matchingTabs.length} 个标签页`);
  console.log('匹配的标签页:');
  matchingTabs.forEach((match, i) => {
    console.log(`  ${i + 1}. ${match.tab.title} (来自 ${match.group.name})`);
  });
  
  if (matchingTabs.length === 0) return;

  // 处理标签组更新
  const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
    if (group.isLocked) {
      console.log(`⚠️  跳过锁定标签组: ${group.name}`);
      return acc;
    }

    if (!acc[group.id]) {
      acc[group.id] = { group, tabsToRemove: [] };
    }
    acc[group.id].tabsToRemove.push(tab.id);
    return acc;
  }, {});

  console.log(`📋 需要处理 ${Object.keys(groupsToUpdate).length} 个标签组`);

  // 先在UI中更新标签组，立即更新界面
  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
      console.log(`🔄 UI更新: 标记删除标签组 ${group.name}`);
    } else {
      const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
      console.log(`🔄 UI更新: 标记更新标签组 ${group.name}, 剩余 ${updatedTabs.length} 个标签页`);
    }
  });

  // 问题所在：使用setTimeout但不等待
  console.log('⚠️  [PROBLEM] 使用setTimeout，函数将立即返回，不等待存储操作完成');
  
  setTimeout(async () => {
    try {
      console.log('💾 [DELAYED] 开始执行存储操作...');
      
      const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
        if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
          console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
          await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
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
          return { action: 'update', groupId: group.id, remainingTabs: updatedTabs.length };
        }
      });

      console.log('⏳ 等待所有存储操作完成...');
      const results = await Promise.all(storagePromises);
      
      console.log('📊 [DELAYED] 存储操作结果:');
      results.forEach((result, index) => {
        if (result.action === 'delete') {
          console.log(`  ${index + 1}. ✅ 删除标签组: ${result.groupId}`);
        } else {
          console.log(`  ${index + 1}. ✅ 更新标签组: ${result.groupId}, 剩余: ${result.remainingTabs} 个标签页`);
        }
      });

      showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
      console.log(`🎉 [DELAYED] 批量删除操作完成 (处理了 ${results.length} 个标签组)`);
      
    } catch (error) {
      console.error('❌ [DELAYED] 批量删除存储操作失败:', error);
      showToast('删除操作失败，请重试', 'error');
    }
  }, 50);
  
  console.log('🏃 [PROBLEMATIC] 函数立即返回，不等待setTimeout内的操作完成');
};

// 修复后的批量删除函数
const fixedHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  console.log(`\n🚀 [FIXED] 开始批量删除: ${matchingTabs.length} 个标签页`);
  
  if (matchingTabs.length === 0) return;

  // 处理标签组更新
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
    if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
      console.log(`🔄 UI更新: 标记删除标签组 ${group.name}`);
    } else {
      const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
      console.log(`🔄 UI更新: 标记更新标签组 ${group.name}, 剩余 ${updatedTabs.length} 个标签页`);
    }
  });

  // 修复：使用Promise包装setTimeout，确保等待完成
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        console.log('💾 [FIXED] 开始执行存储操作...');
        
        const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
          if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
            console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
            await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
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
            return { action: 'update', groupId: group.id, remainingTabs: updatedTabs.length };
          }
        });

        console.log('⏳ 等待所有存储操作完成...');
        const results = await Promise.all(storagePromises);
        
        console.log('📊 [FIXED] 存储操作结果:');
        results.forEach((result, index) => {
          if (result.action === 'delete') {
            console.log(`  ${index + 1}. ✅ 删除标签组: ${result.groupId}`);
          } else {
            console.log(`  ${index + 1}. ✅ 更新标签组: ${result.groupId}, 剩余: ${result.remainingTabs} 个标签页`);
          }
        });

        showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
        console.log(`🎉 [FIXED] 批量删除操作完成 (处理了 ${results.length} 个标签组)`);
        
        resolve(results);
      } catch (error) {
        console.error('❌ [FIXED] 批量删除存储操作失败:', error);
        showToast('删除操作失败，请重试', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 运行一致性测试
const runConsistencyTest = async () => {
  console.log('🧪 开始批量删除一致性测试...\n');

  // 清空存储
  await chrome.storage.local.clear();

  // 准备测试数据
  const testTabs = [
    { id: 'tab1', title: 'Google Search', url: 'https://google.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab2', title: 'Google Maps', url: 'https://maps.google.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab3', title: 'Google Drive', url: 'https://drive.google.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab4', title: 'GitHub', url: 'https://github.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab5', title: 'YouTube', url: 'https://youtube.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() }
  ];

  const testGroups = [
    {
      id: 'group1',
      name: 'Google Services',
      tabs: [testTabs[0], testTabs[1], testTabs[2]], // 3个Google标签页
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    },
    {
      id: 'group2',
      name: 'Development',
      tabs: [testTabs[3]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    },
    {
      id: 'group3',
      name: 'Media',
      tabs: [testTabs[4]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    }
  ];

  // 初始化数据
  console.log('📝 初始化测试数据...');
  await storage.setGroups(testGroups);

  // 模拟搜索"google"的结果（应该匹配3个标签页）
  const googleMatches = [
    { tab: testTabs[0], group: testGroups[0] },
    { tab: testTabs[1], group: testGroups[0] },
    { tab: testTabs[2], group: testGroups[0] }
  ];

  console.log('\n=== 测试有问题的实现 ===');
  const mockDispatch1 = createMockDispatch();
  const mockToast1 = (msg, type) => console.log(`📢 [PROBLEMATIC] Toast [${type}]: ${msg}`);
  
  // 测试有问题的实现
  console.log('🔴 测试有问题的实现...');
  await problematicHandleDeleteAllSearchResults(googleMatches, mockDispatch1, mockToast1);
  
  // 等待一段时间让setTimeout执行
  console.log('⏰ 等待setTimeout执行...');
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // 检查结果
  console.log('\n📊 检查有问题实现的结果:');
  const resultAfterProblematic = await storage.getGroups();
  console.log(`存储中剩余 ${resultAfterProblematic.length} 个标签组`);

  // 重新初始化数据
  console.log('\n📝 重新初始化测试数据...');
  await storage.setGroups(testGroups);

  console.log('\n=== 测试修复后的实现 ===');
  const mockDispatch2 = createMockDispatch();
  const mockToast2 = (msg, type) => console.log(`📢 [FIXED] Toast [${type}]: ${msg}`);
  
  // 测试修复后的实现
  console.log('🟢 测试修复后的实现...');
  await fixedHandleDeleteAllSearchResults(googleMatches, mockDispatch2, mockToast2);
  
  // 检查结果
  console.log('\n📊 检查修复后实现的结果:');
  const resultAfterFixed = await storage.getGroups();
  console.log(`存储中剩余 ${resultAfterFixed.length} 个标签组`);

  // 验证一致性
  console.log('\n🔍 一致性验证:');
  const allTabs = resultAfterFixed.flatMap(g => g.tabs);
  const deletedTabIds = googleMatches.map(m => m.tab.id);
  const stillExistingDeletedTabs = allTabs.filter(tab => deletedTabIds.includes(tab.id));
  
  if (stillExistingDeletedTabs.length === 0) {
    console.log('✅ 一致性测试通过：所有目标标签页都已删除');
    return true;
  } else {
    console.log(`❌ 一致性测试失败：${stillExistingDeletedTabs.length} 个标签页未被删除`);
    stillExistingDeletedTabs.forEach(tab => {
      console.log(`  - ${tab.title} (${tab.id})`);
    });
    return false;
  }
};

// 运行测试
runConsistencyTest().then(success => {
  if (success) {
    console.log('\n🎉 一致性测试通过！');
    process.exit(0);
  } else {
    console.log('\n💥 一致性测试失败！');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 测试执行失败:', error);
  process.exit(1);
});
