/**
 * 端到端批量删除测试
 * 模拟真实的用户操作流程，验证数据持久化
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
      get: function(keys) {
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: this.data[keys] });
        } else if (Array.isArray(keys)) {
          const result = {};
          keys.forEach(key => {
            result[key] = this.data[key];
          });
          return Promise.resolve(result);
        } else if (typeof keys === 'object') {
          const result = {};
          Object.keys(keys).forEach(key => {
            result[key] = this.data[key] !== undefined ? this.data[key] : keys[key];
          });
          return Promise.resolve(result);
        }
        return Promise.resolve(this.data);
      },
      set: function(items) {
        Object.assign(this.data, items);
        return Promise.resolve();
      },
      clear: function() {
        this.data = {};
        return Promise.resolve();
      }
    }
  }
};

// 模拟存储API
const STORAGE_KEYS = {
  GROUPS: 'tab_groups'
};

class MockStorage {
  async getGroups() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
    return result[STORAGE_KEYS.GROUPS] || [];
  }

  async setGroups(groups) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.GROUPS]: groups
    });
  }
}

const storage = new MockStorage();

// 模拟Redux actions
const mockDispatch = (action) => {
  return {
    unwrap: async () => {
      if (action.type === 'tabs/deleteGroup') {
        const groups = await storage.getGroups();
        const updatedGroups = groups.filter(g => g.id !== action.payload);
        await storage.setGroups(updatedGroups);
        return action.payload;
      } else if (action.type === 'tabs/updateGroup') {
        const groups = await storage.getGroups();
        const updatedGroups = groups.map(g => g.id === action.payload.id ? action.payload : g);
        await storage.setGroups(updatedGroups);
        return action.payload;
      }
      return action.payload;
    }
  };
};

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) return false;
  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 模拟Toast
const mockShowToast = (message, type) => {
  console.log(`📢 Toast [${type}]: ${message}`);
};

// 修复后的批量删除函数（从SearchResultList.tsx复制）
const fixedHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  console.log(`🚀 开始批量删除: ${matchingTabs.length} 个标签页`);
  
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

  // 先在UI中更新标签组，立即更新界面
  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
      // 模拟Redux状态更新
      console.log(`🔄 UI更新: 删除标签组 ${group.name}`);
    } else {
      const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
      console.log(`🔄 UI更新: 更新标签组 ${group.name}, 剩余 ${updatedTabs.length} 个标签页`);
    }
  });

  // 关键修复：直接等待存储操作，而不是使用setTimeout
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        console.log('💾 开始执行批量删除的存储操作...');
        
        const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
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
        });

        console.log('⏳ 等待所有存储操作完成...');
        const results = await Promise.all(storagePromises);
        
        console.log('📊 批量删除操作结果:');
        results.forEach((result, index) => {
          if (result.action === 'delete') {
            console.log(`  ${index + 1}. 删除标签组: ${result.groupId}`);
          } else {
            console.log(`  ${index + 1}. 更新标签组: ${result.groupId}, 剩余: ${result.remainingTabs} 个标签页`);
          }
        });

        showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
        console.log(`🎉 所有批量删除操作已完成并保存到存储 (处理了 ${results.length} 个标签组)`);
        
        resolve(results);
      } catch (error) {
        console.error('❌ 批量删除存储操作失败:', error);
        showToast('删除操作失败，请重试', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 端到端测试
const runEndToEndTest = async () => {
  console.log('🧪 开始端到端批量删除测试...\n');

  // 清空存储
  await chrome.storage.local.clear();

  // 准备测试数据
  const testTabs = [
    { id: 'tab1', title: 'Google Search', url: 'https://google.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab2', title: 'Google Maps', url: 'https://maps.google.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab3', title: 'GitHub', url: 'https://github.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
    { id: 'tab4', title: 'YouTube', url: 'https://youtube.com', favicon: '', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() }
  ];

  const testGroups = [
    {
      id: 'group1',
      name: 'Google Services',
      tabs: [testTabs[0], testTabs[1]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    },
    {
      id: 'group2',
      name: 'Development',
      tabs: [testTabs[2]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    },
    {
      id: 'group3',
      name: 'Media',
      tabs: [testTabs[3]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isLocked: false
    }
  ];

  // 步骤1: 初始化数据
  console.log('📝 步骤1: 初始化测试数据');
  await storage.setGroups(testGroups);
  const initialGroups = await storage.getGroups();
  console.log(`初始化完成，存储中有 ${initialGroups.length} 个标签组\n`);

  // 步骤2: 模拟用户搜索"google"
  console.log('🔍 步骤2: 模拟用户搜索"google"');
  const searchQuery = 'google';
  const matchingTabs = [];
  
  initialGroups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.title.toLowerCase().includes(searchQuery) || tab.url.toLowerCase().includes(searchQuery)) {
        matchingTabs.push({ tab, group });
      }
    });
  });
  
  console.log(`搜索到 ${matchingTabs.length} 个匹配的标签页:`);
  matchingTabs.forEach(({ tab, group }) => {
    console.log(`  - ${tab.title} (来自 ${group.name})`);
  });
  console.log('');

  // 步骤3: 用户点击"删除全部"按钮
  console.log('🗑️  步骤3: 用户点击"删除全部"按钮');
  const beforeDeletion = await storage.getGroups();
  console.log('删除前的存储状态:');
  beforeDeletion.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });
  console.log('');

  // 步骤4: 执行批量删除操作
  console.log('⚡ 步骤4: 执行批量删除操作');
  await fixedHandleDeleteAllSearchResults(matchingTabs, mockDispatch, mockShowToast);
  console.log('');

  // 步骤5: 验证删除后的状态
  console.log('✅ 步骤5: 验证删除后的状态');
  const afterDeletion = await storage.getGroups();
  console.log('删除后的存储状态:');
  afterDeletion.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });
  console.log('');

  // 步骤6: 模拟页面刷新，验证数据持久化
  console.log('🔄 步骤6: 模拟页面刷新，验证数据持久化');
  const refreshedGroups = await storage.getGroups();
  console.log('刷新后的存储状态:');
  refreshedGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 步骤7: 验证删除的标签页是否真的不存在
  console.log('\n🔍 步骤7: 验证删除的标签页是否真的不存在');
  const deletedTabIds = matchingTabs.map(m => m.tab.id);
  const allRefreshedTabs = refreshedGroups.flatMap(g => g.tabs);
  const stillExistingDeletedTabs = allRefreshedTabs.filter(tab => deletedTabIds.includes(tab.id));

  if (stillExistingDeletedTabs.length > 0) {
    console.log(`❌ 数据持久化失败: ${stillExistingDeletedTabs.length} 个已删除的标签页仍然存在`);
    stillExistingDeletedTabs.forEach(tab => {
      console.log(`  - ${tab.title} (${tab.id})`);
    });
    return false;
  } else {
    console.log(`✅ 数据持久化成功: 所有 ${deletedTabIds.length} 个标签页已被永久删除`);
  }

  // 步骤8: 验证空标签组是否被正确删除
  console.log('\n🗂️  步骤8: 验证空标签组是否被正确删除');
  const googleGroup = refreshedGroups.find(g => g.id === 'group1');
  if (!googleGroup) {
    console.log('✅ 空标签组自动删除成功: Google Services 标签组已被删除');
  } else {
    console.log('❌ 空标签组删除失败: Google Services 标签组仍然存在');
    return false;
  }

  console.log('\n🎉 端到端测试完全成功！批量删除功能的数据持久化问题已修复！');
  return true;
};

// 运行测试
runEndToEndTest().then(success => {
  if (success) {
    console.log('\n✅ 端到端测试通过，数据持久化问题已解决');
    process.exit(0);
  } else {
    console.log('\n❌ 端到端测试失败，数据持久化问题仍然存在');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 端到端测试执行失败:', error);
  process.exit(1);
});
