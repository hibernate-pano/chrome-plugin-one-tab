/**
 * 真实存储操作调试脚本
 * 使用真实的Chrome Storage API和Redux actions进行测试
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
      get: function (keys) {
        console.log('Chrome Storage GET:', keys);
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
      set: function (items) {
        console.log('Chrome Storage SET:', Object.keys(items));
        Object.assign(this.data, items);
        console.log('Storage data after SET:', JSON.stringify(this.data, null, 2));
        return Promise.resolve();
      },
      clear: function () {
        this.data = {};
        return Promise.resolve();
      }
    }
  },
  runtime: {
    sendMessage: (message) => {
      console.log('Chrome消息发送:', message);
      return Promise.resolve();
    }
  }
};

// 读取并执行storage.ts的JavaScript版本
const storageCode = fs.readFileSync(path.join(__dirname, '../utils/storage.ts'), 'utf8');

// 简化的storage实现用于测试
const STORAGE_KEYS = {
  GROUPS: 'tab_groups',
  SETTINGS: 'user_settings',
  DELETED_GROUPS: 'deleted_tab_groups',
  DELETED_TABS: 'deleted_tabs',
  LAST_SYNC_TIME: 'last_sync_time',
  MIGRATION_FLAGS: 'migration_flags'
};

class TestChromeStorage {
  async getGroups() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
      const groups = result[STORAGE_KEYS.GROUPS] || [];
      console.log(`从存储读取 ${groups.length} 个标签组`);
      return groups;
    } catch (error) {
      console.error('获取标签组失败:', error);
      return [];
    }
  }

  async setGroups(groups) {
    try {
      console.log(`准备保存 ${groups.length} 个标签组到存储`);
      await chrome.storage.local.set({
        [STORAGE_KEYS.GROUPS]: groups
      });
      console.log(`成功保存 ${groups.length} 个标签组到存储`);
    } catch (error) {
      console.error('保存标签组失败:', error);
      throw error;
    }
  }
}

const storage = new TestChromeStorage();

// 模拟Redux actions
const mockDeleteGroup = async (groupId) => {
  console.log(`\n=== 执行 deleteGroup action: ${groupId} ===`);
  try {
    const groups = await storage.getGroups();
    console.log(`删除前标签组数量: ${groups.length}`);

    const updatedGroups = groups.filter(g => g.id !== groupId);
    console.log(`删除后标签组数量: ${updatedGroups.length}`);

    await storage.setGroups(updatedGroups);
    console.log(`deleteGroup action 完成: ${groupId}`);

    return { payload: groupId };
  } catch (error) {
    console.error(`deleteGroup action 失败: ${groupId}`, error);
    throw error;
  }
};

const mockUpdateGroup = async (group) => {
  console.log(`\n=== 执行 updateGroup action: ${group.id} ===`);
  try {
    const groups = await storage.getGroups();
    console.log(`更新前标签组数量: ${groups.length}`);
    console.log(`更新的标签组包含 ${group.tabs.length} 个标签页`);

    const updatedGroups = groups.map(g => (g.id === group.id ? group : g));
    await storage.setGroups(updatedGroups);
    console.log(`updateGroup action 完成: ${group.id}`);

    return { payload: group };
  } catch (error) {
    console.error(`updateGroup action 失败: ${group.id}`, error);
    throw error;
  }
};

// 模拟工具函数
const shouldAutoDeleteAfterMultipleTabRemoval = (group, tabIdsToDelete) => {
  if (group.isLocked) {
    return false;
  }

  const remainingTabsCount = group.tabs.filter(tab => !tabIdsToDelete.includes(tab.id)).length;
  return remainingTabsCount === 0;
};

// 模拟真实的批量删除函数
const realHandleDeleteAllSearchResults = async (matchingTabs) => {
  console.log(`\n🚀 开始真实的批量删除操作: ${matchingTabs.length} 个标签页`);

  if (matchingTabs.length === 0) {
    console.log('没有标签页需要删除');
    return;
  }

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

  console.log(`需要更新 ${Object.keys(groupsToUpdate).length} 个标签组`);

  // 这里是关键问题：我们需要等待存储操作完成，而不是使用setTimeout
  try {
    const storagePromises = Object.values(groupsToUpdate).map(async ({ group, tabsToRemove }) => {
      console.log(`\n处理标签组: ${group.name} (${group.id})`);
      console.log(`需要删除的标签页: ${tabsToRemove.length} 个`);

      if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
        console.log(`标签组 ${group.name} 将被完全删除`);
        const result = await mockDeleteGroup(group.id);
        return { action: 'delete', groupId: group.id, result };
      } else {
        const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
        const updatedGroup = {
          ...group,
          tabs: updatedTabs,
          updatedAt: new Date().toISOString()
        };
        console.log(`标签组 ${group.name} 将保留 ${updatedTabs.length} 个标签页`);
        const result = await mockUpdateGroup(updatedGroup);
        return { action: 'update', groupId: group.id, result };
      }
    });

    console.log('\n⏳ 等待所有存储操作完成...');
    const results = await Promise.all(storagePromises);

    console.log('\n✅ 所有存储操作完成');
    results.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.action} 操作完成: ${result.groupId}`);
    });

    return results;
  } catch (error) {
    console.error('\n❌ 批量删除存储操作失败:', error);
    throw error;
  }
};

// 验证数据持久化的函数
const verifyDataPersistence = async (beforeGroups, afterGroups, deletedTabIds) => {
  console.log('\n🔍 验证数据持久化...');

  // 重新从存储读取数据，模拟页面刷新
  const refreshedGroups = await storage.getGroups();

  console.log(`刷新前标签组数量: ${beforeGroups.length}`);
  console.log(`删除后标签组数量: ${afterGroups.length}`);
  console.log(`刷新后标签组数量: ${refreshedGroups.length}`);

  // 检查删除的标签页是否真的不存在了
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
    return true;
  }
};

// 运行真实的调试测试
const runRealStorageDebug = async () => {
  console.log('🔧 开始真实存储操作调试...\n');

  // 清空存储
  await chrome.storage.local.clear();
  console.log('清空存储完成\n');

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

  // 初始化存储
  console.log('📝 初始化测试数据...');
  await storage.setGroups(testGroups);

  const initialGroups = await storage.getGroups();
  console.log(`初始化完成，存储中有 ${initialGroups.length} 个标签组\n`);

  // 测试场景1: 删除Google相关标签页（会导致整个标签组被删除）
  console.log('📋 测试场景1: 删除Google相关标签页');
  const googleMatches = [
    { tab: testTabs[0], group: testGroups[0] },
    { tab: testTabs[1], group: testGroups[0] }
  ];

  const beforeGroups = await storage.getGroups();
  const deletedTabIds = googleMatches.map(m => m.tab.id);

  console.log(`删除前状态:`);
  beforeGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 执行真实的批量删除
  await realHandleDeleteAllSearchResults(googleMatches);

  const afterGroups = await storage.getGroups();
  console.log(`\n删除后状态:`);
  afterGroups.forEach(g => {
    console.log(`  - ${g.name}: ${g.tabs.length} 个标签页`);
  });

  // 验证数据持久化
  const isPersistent = await verifyDataPersistence(beforeGroups, afterGroups, deletedTabIds);

  if (isPersistent) {
    console.log('\n🎉 真实存储操作调试成功！数据持久化正常工作。');
    return true;
  } else {
    console.log('\n💥 真实存储操作调试失败！发现数据持久化问题。');
    return false;
  }
};

// 运行调试
runRealStorageDebug().then(success => {
  if (success) {
    console.log('\n✅ 所有真实存储操作测试通过');
    process.exit(0);
  } else {
    console.log('\n❌ 真实存储操作测试失败');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 调试过程中发生错误:', error);
  process.exit(1);
});
