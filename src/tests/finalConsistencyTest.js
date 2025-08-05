/**
 * 最终一致性测试
 * 验证修复后的批量删除功能是否解决了竞态条件问题
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
      get: function (keys) {
        this.operationCount++;
        const opId = `GET-${this.operationCount}`;
        console.log(`📖 [${opId}] Storage GET:`, keys);

        // 模拟随机延迟
        const delay = Math.random() * 30 + 10;

        return new Promise(resolve => {
          setTimeout(() => {
            if (typeof keys === 'string') {
              const result = { [keys]: this.data[keys] };
              console.log(`📖 [${opId}] GET完成 (${delay.toFixed(1)}ms):`, result[keys] ? `${result[keys].length} 个标签组` : '空');
              resolve(result);
            } else {
              resolve(this.data);
            }
          }, delay);
        });
      },
      set: function (items) {
        this.operationCount++;
        const opId = `SET-${this.operationCount}`;
        console.log(`💾 [${opId}] Storage SET:`, Object.keys(items));

        // 模拟随机延迟
        const delay = Math.random() * 50 + 20;

        return new Promise(resolve => {
          setTimeout(() => {
            Object.assign(this.data, items);
            console.log(`💾 [${opId}] SET完成 (${delay.toFixed(1)}ms)`);
            resolve();
          }, delay);
        });
      },
      clear: function () {
        this.data = {};
        this.operationCount = 0;
        return Promise.resolve();
      }
    }
  }
};

// 模拟存储API
const STORAGE_KEYS = { GROUPS: 'tab_groups' };

class TestStorage {
  async getGroups() {
    const result = await chrome.storage.local.get(STORAGE_KEYS.GROUPS);
    return result[STORAGE_KEYS.GROUPS] || [];
  }

  async setGroups(groups) {
    await chrome.storage.local.set({ [STORAGE_KEYS.GROUPS]: groups });
  }
}

const storage = new TestStorage();

// 模拟Redux actions
const createMockDispatch = () => {
  let actionId = 0;

  return (action) => {
    actionId++;
    const currentActionId = actionId;

    return {
      unwrap: async () => {
        console.log(`🎬 [Action-${currentActionId}] 开始: ${action.type}`);

        // 模拟随机延迟
        const delay = Math.random() * 100 + 30;
        await new Promise(resolve => setTimeout(resolve, delay));

        if (action.type === 'tabs/deleteGroup') {
          console.log(`🗑️  [Action-${currentActionId}] 删除标签组: ${action.payload}`);
          const groups = await storage.getGroups();
          const updatedGroups = groups.filter(g => g.id !== action.payload);
          await storage.setGroups(updatedGroups);
          console.log(`🗑️  [Action-${currentActionId}] 删除完成 (${delay.toFixed(1)}ms)`);
          return action.payload;
        } else if (action.type === 'tabs/updateGroup') {
          console.log(`📝 [Action-${currentActionId}] 更新标签组: ${action.payload.id}`);
          const groups = await storage.getGroups();
          const updatedGroups = groups.map(g => g.id === action.payload.id ? action.payload : g);
          await storage.setGroups(updatedGroups);
          console.log(`📝 [Action-${currentActionId}] 更新完成 (${delay.toFixed(1)}ms)`);
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

// 修复后的批量删除函数（从修复后的SearchResultList.tsx复制）
const fixedHandleDeleteAllSearchResults = async (matchingTabs, dispatch, showToast) => {
  if (matchingTabs.length === 0) return;

  console.log(`🚀 开始批量删除 ${matchingTabs.length} 个标签页`);
  console.log('匹配的标签页:', matchingTabs.map(m => `${m.tab.title} (来自 ${m.group.name})`));

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
        console.log('💾 开始执行批量删除的存储操作...');

        // 关键修复：串行执行存储操作，避免竞态条件
        const results = [];
        console.log('⏳ 开始串行执行存储操作...');

        for (const { group, tabsToRemove } of Object.values(groupsToUpdate)) {
          if (shouldAutoDeleteAfterMultipleTabRemoval(group, tabsToRemove)) {
            console.log(`🗑️  准备删除空标签组: ${group.name} (${group.id})`);
            await dispatch({ type: 'tabs/deleteGroup', payload: group.id }).unwrap();
            console.log(`✅ 删除空标签组完成: ${group.id}`);
            results.push({ action: 'delete', groupId: group.id });
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
            results.push({ action: 'update', groupId: group.id, remainingTabs: updatedTabs.length });
          }
        }

        console.log('✅ 所有存储操作串行执行完成');

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

        resolve();
      } catch (error) {
        console.error('❌ 批量删除存储操作失败:', error);
        showToast('删除操作失败，请重试', 'error');
        reject(error);
      }
    }, 50);
  });
};

// 最终一致性测试
const runFinalConsistencyTest = async () => {
  console.log('🧪 开始最终一致性测试...\n');

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
      tabs: [testTabs[0], testTabs[1]], // 2个Google标签页，删除后标签组应该被删除
      isLocked: false
    },
    {
      id: 'group2',
      name: 'Development',
      tabs: [testTabs[3], testTabs[4]], // 2个GitHub标签页，不受影响
      isLocked: false
    },
    {
      id: 'group3',
      name: 'Mixed',
      tabs: [testTabs[2], testTabs[5]], // 1个Google + 1个YouTube，删除Google后剩YouTube
      isLocked: false
    }
  ];

  // 测试场景：搜索"google"，应该匹配3个标签页
  const googleMatches = [
    { tab: testTabs[0], group: testGroups[0] }, // Google Search from Google Services
    { tab: testTabs[1], group: testGroups[0] }, // Google Maps from Google Services  
    { tab: testTabs[2], group: testGroups[2] }  // Google Drive from Mixed
  ];

  console.log('📝 测试场景：删除3个Google标签页');
  console.log('预期结果：');
  console.log('  - Google Services: 2个标签页 -> 删除整个标签组');
  console.log('  - Development: 2个标签页 -> 保持不变');
  console.log('  - Mixed: 2个标签页 -> 1个标签页 (保留YouTube)');

  // 运行多次测试确保一致性
  let allTestsPassed = true;

  for (let i = 1; i <= 5; i++) {
    console.log(`\n=== 第 ${i} 次一致性测试 ===`);

    // 清空并初始化数据
    await chrome.storage.local.clear();
    await storage.setGroups(testGroups);

    const mockDispatch = createMockDispatch();
    const mockToast = (msg, type) => console.log(`📢 Toast [${type}]: ${msg}`);

    console.log(`🟢 测试修复后的实现 (第${i}次)...`);

    const startTime = Date.now();

    // 执行修复后的批量删除，等待完成
    await fixedHandleDeleteAllSearchResults(googleMatches, mockDispatch, mockToast);

    const endTime = Date.now();
    console.log(`⏱️  第${i}次测试耗时: ${endTime - startTime}ms`);

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
      allTestsPassed = false;
      break;
    } else {
      console.log(`✅ 第${i}次测试通过: 所有Google标签页已删除`);
    }

    // 验证标签组数量
    if (finalGroups.length !== 2) {
      console.log(`❌ 第${i}次测试失败: 预期2个标签组，实际${finalGroups.length}个`);
      allTestsPassed = false;
      break;
    }

    // 验证Google Services标签组是否被删除
    const googleServicesGroup = finalGroups.find(g => g.id === 'group1');
    if (googleServicesGroup) {
      console.log(`❌ 第${i}次测试失败: Google Services标签组应该被删除但仍然存在`);
      allTestsPassed = false;
      break;
    }

    // 验证Mixed标签组是否正确更新
    const mixedGroup = finalGroups.find(g => g.id === 'group3');
    if (!mixedGroup || mixedGroup.tabs.length !== 1) {
      console.log(`❌ 第${i}次测试失败: Mixed标签组应该剩余1个标签页`);
      allTestsPassed = false;
      break;
    }
  }

  if (allTestsPassed) {
    console.log('\n🎉 所有一致性测试通过！批量删除功能已修复！');
    return true;
  } else {
    console.log('\n💥 一致性测试失败！仍存在问题！');
    return false;
  }
};

// 运行测试
runFinalConsistencyTest().then(success => {
  if (success) {
    console.log('\n✅ 批量删除一致性问题已完全修复！');
    process.exit(0);
  } else {
    console.log('\n❌ 批量删除一致性问题仍然存在！');
    process.exit(1);
  }
}).catch(error => {
  console.error('\n💥 测试执行失败:', error);
  process.exit(1);
});
