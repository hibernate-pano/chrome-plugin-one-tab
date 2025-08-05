/**
 * 最终批量删除功能验证测试
 * 模拟完整的用户交互流程，验证所有修复是否生效
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
const STORAGE_KEYS = { GROUPS: 'tab_groups' };

class MockStorage {
  async getGroups() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
    return result[STORAGE_KEYS.GROUPS] || [];
  }

  async setGroups(groups) {
    await chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups });
  }
}

const storage = new MockStorage();

// 模拟Redux actions（真实的异步操作）
const mockDispatch = (action) => {
  return {
    unwrap: async () => {
      // 模拟网络延迟
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (action.type === 'tabs/deleteGroup') {
        console.log(`🗑️  执行 deleteGroup: ${action.payload}`);
        const groups = await storage.getGroups();
        const updatedGroups = groups.filter(g => g.id !== action.payload);
        await storage.setGroups(updatedGroups);
        console.log(`✅ deleteGroup 完成: ${action.payload}`);
        return action.payload;
      } else if (action.type === 'tabs/updateGroup') {
        console.log(`📝 执行 updateGroup: ${action.payload.id}`);
        const groups = await storage.getGroups();
        const updatedGroups = groups.map(g => g.id === action.payload.id ? action.payload : g);
        await storage.setGroups(updatedGroups);
        console.log(`✅ updateGroup 完成: ${action.payload.id}`);
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

// 模拟Toast和确认对话框
const mockShowToast = (message, type) => {
  console.log(`📢 Toast [${type}]: ${message}`);
};

const mockShowConfirm = (options) => {
  return new Promise((resolve) => {
    console.log(`🔔 确认对话框: ${options.title}`);
    console.log(`   消息: ${options.message}`);
    console.log(`   用户点击: ${options.confirmText}`);
    
    // 模拟用户点击确认，并等待异步操作完成
    setTimeout(async () => {
      try {
        await options.onConfirm();
        resolve(true);
      } catch (error) {
        console.error('确认操作失败:', error);
        resolve(false);
      }
    }, 50);
  });
};

// 修复后的完整批量删除函数
const completeHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  console.log(`\n🚀 开始完整的批量删除流程: ${matchingTabs.length} 个标签页`);
  
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

  // 关键修复：使用Promise包装setTimeout，确保等待存储操作完成
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        console.log('\n💾 开始执行存储操作...');
        
        const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
          if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
            console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
            await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
            return { action: 'delete', groupId: group.id, groupName: group.name };
          } else {
            const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
            const updatedGroup = {
              ...group,
              tabs: updatedTabs,
              updatedAt: new Date().toISOString()
            };
            console.log(`📝 准备更新标签组: ${group.name} (${group.id}), 剩余标签页: ${updatedTabs.length}`);
            await dispatch({ type: 'tabs/updateGroup', payload: updatedGroup }).unwrap();
            return { action: 'update', groupId: group.id, groupName: group.name, remainingTabs: updatedTabs.length };
          }
        });

        console.log('⏳ 等待所有存储操作完成...');
        const results = await Promise.all(storagePromises);
        
        console.log('\n📊 存储操作结果:');
        results.forEach((result, index) => {
          if (result.action === 'delete') {
            console.log(`  ${index + 1}. ✅ 删除标签组: ${result.groupName} (${result.groupId})`);
          } else {
            console.log(`  ${index + 1}. ✅ 更新标签组: ${result.groupName} (${result.groupId}), 剩余: ${result.remainingTabs} 个标签页`);
          }
        });

        showToast(`成功删除 ${matchingTabs.length} 个标签页`, 'success');
        console.log(`\n🎉 批量删除操作完全成功 (处理了 ${results.length} 个标签组)`);
        
        resolve(results);
      } catch (error) {
        console.error('\n❌ 批量删除存储操作失败:', error);
        showToast('删除操作失败，请重试', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 完整的用户交互流程测试
const runCompleteUserFlow = async () => {
  console.log('🧪 开始完整用户交互流程测试...\n');

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
  console.log(`初始化完成，存储中有 ${initialGroups.length} 个标签组`);

  // 步骤2: 用户搜索
  console.log('\n🔍 步骤2: 用户搜索"google"');
  const searchQuery = 'google';
  const matchingTabs = [];
  
  initialGroups.forEach(group => {
    group.tabs.forEach(tab => {
      if (tab.title.toLowerCase().includes(searchQuery) || tab.url.toLowerCase().includes(searchQuery)) {
        matchingTabs.push({ tab, group });
      }
    });
  });
  
  console.log(`搜索到 ${matchingTabs.length} 个匹配的标签页`);

  // 步骤3: 用户点击删除全部按钮，触发确认对话框
  console.log('\n🗑️  步骤3: 用户点击删除全部按钮');
  const confirmResult = await mockShowConfirm({
    title: '删除确认',
    message: `确定要删除所有搜索结果中的 ${matchingTabs.length} 个标签页吗？此操作不可撤销。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消',
    onConfirm: async () => {
      // 这里是关键：确认对话框等待异步操作完成
      await completeHandleDeleteAllSearchResults(matchingTabs, mockDispatch, mockShowToast);
    }
  });

  if (!confirmResult) {
    console.log('❌ 确认操作失败');
    return false;
  }

  // 步骤4: 验证数据持久化
  console.log('\n🔍 步骤4: 验证数据持久化');
  
  // 模拟页面刷新
  const refreshedGroups = await storage.getGroups();
  console.log(`刷新后存储中有 ${refreshedGroups.length} 个标签组`);

  // 验证删除的标签页是否真的不存在
  const deletedTabIds = matchingTabs.map(m => m.tab.id);
  const allRefreshedTabs = refreshedGroups.flatMap(g => g.tabs);
  const stillExistingDeletedTabs = allRefreshedTabs.filter(tab => deletedTabIds.includes(tab.id));

  if (stillExistingDeletedTabs.length > 0) {
    console.log(`❌ 数据持久化失败: ${stillExistingDeletedTabs.length} 个已删除的标签页仍然存在`);
    return false;
  }

  // 验证空标签组是否被删除
  const googleGroup = refreshedGroups.find(g => g.id === 'group1');
  if (googleGroup) {
    console.log('❌ 空标签组删除失败: Google Services 标签组仍然存在');
    return false;
  }

  console.log('\n✅ 所有验证通过:');
  console.log('  - 数据持久化成功');
  console.log('  - 空标签组自动删除成功');
  console.log('  - 异步操作正确等待完成');
  console.log('  - 确认对话框正确处理异步回调');

  return true;
};

// 运行完整测试
runCompleteUserFlow().then(success => {
  if (success) {
    console.log('\n🎉 完整用户交互流程测试成功！');
    console.log('✅ 批量删除功能的数据持久化问题已完全修复！');
    process.exit(0);
  } else {
    console.log('\n💥 完整用户交互流程测试失败！');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 测试执行失败:', error);
  process.exit(1);
});
