/**
 * 测试 SearchResultList 组件的批量删除功能
 * 这是一个功能测试文件，用于验证批量删除搜索结果的逻辑
 */

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

// 模拟搜索匹配逻辑
const getMatchingTabs = (groups, searchQuery) => {
  const matchingTabs = [];

  if (searchQuery) {
    const query = searchQuery.toLowerCase();

    groups.forEach(group => {
      group.tabs.forEach(tab => {
        if (
          tab.title.toLowerCase().includes(query) ||
          tab.url.toLowerCase().includes(query)
        ) {
          matchingTabs.push({ tab, group });
        }
      });
    });
  }

  return matchingTabs;
};

// 模拟批量删除逻辑
const simulateBatchDelete = (matchingTabs) => {
  const groupsToUpdate = matchingTabs.reduce((acc, { tab, group }) => {
    if (group.isLocked) return acc; // 如果标签组已锁定，不删除标签页

    if (!acc[group.id]) {
      acc[group.id] = { group, tabsToRemove: [] };
    }
    acc[group.id].tabsToRemove.push(tab.id);
    return acc;
  }, {});

  const results = {
    groupsDeleted: [],
    groupsUpdated: [],
    tabsDeleted: 0
  };

  Object.values(groupsToUpdate).forEach(({ group, tabsToRemove }) => {
    // 使用工具函数检查是否应该自动删除标签组
    const remainingTabsCount = group.tabs.filter(tab => !tabsToRemove.includes(tab.id)).length;

    if (remainingTabsCount === 0 && !group.isLocked) {
      results.groupsDeleted.push(group.id);
    } else {
      const updatedTabs = group.tabs.filter(t => !tabsToRemove.includes(t.id));
      results.groupsUpdated.push({
        groupId: group.id,
        originalTabCount: group.tabs.length,
        remainingTabCount: updatedTabs.length
      });
    }

    results.tabsDeleted += tabsToRemove.length;
  });

  return results;
};

// 测试用例
const runTests = () => {
  console.log('开始测试 SearchResultList 批量删除功能...');

  // 准备测试数据
  const tab1 = createMockTab('tab1', 'Google Search', 'https://google.com');
  const tab2 = createMockTab('tab2', 'GitHub Repository', 'https://github.com');
  const tab3 = createMockTab('tab3', 'Stack Overflow', 'https://stackoverflow.com');
  const tab4 = createMockTab('tab4', 'Google Maps', 'https://maps.google.com');
  const tab5 = createMockTab('tab5', 'YouTube', 'https://youtube.com');

  const group1 = createMockTabGroup('group1', 'Search Group', [tab1, tab4, tab2]); // 包含2个Google相关标签和1个其他标签
  const group2 = createMockTabGroup('group2', 'Dev Group', [tab3]); // 包含开发相关标签
  const group3 = createMockTabGroup('group3', 'Media Group', [tab5]); // 包含1个标签
  const lockedGroup = createMockTabGroup('group4', 'Locked Group', [tab1], true); // 锁定的标签组

  const allGroups = [group1, group2, group3, lockedGroup];

  // 测试 1: 搜索 "google" 并批量删除
  console.log('\n测试 1: 搜索 "google" 并批量删除');
  const googleMatches = getMatchingTabs(allGroups, 'google');
  console.log(`搜索到 ${googleMatches.length} 个匹配的标签页`);

  const googleDeleteResult = simulateBatchDelete(googleMatches);
  console.log('删除结果:', googleDeleteResult);
  console.assert(googleDeleteResult.tabsDeleted === 2, '应该删除2个Google相关标签页');
  console.assert(googleDeleteResult.groupsDeleted.length === 0, '不应该删除任何标签组（因为group1还有其他标签）');
  console.assert(googleDeleteResult.groupsUpdated.length === 1, '应该更新1个标签组');

  // 测试 2: 搜索 "youtube" 并批量删除（会导致标签组被删除）
  console.log('\n测试 2: 搜索 "youtube" 并批量删除');
  const youtubeMatches = getMatchingTabs(allGroups, 'youtube');
  console.log(`搜索到 ${youtubeMatches.length} 个匹配的标签页`);

  const youtubeDeleteResult = simulateBatchDelete(youtubeMatches);
  console.log('删除结果:', youtubeDeleteResult);
  console.assert(youtubeDeleteResult.tabsDeleted === 1, '应该删除1个YouTube标签页');
  console.assert(youtubeDeleteResult.groupsDeleted.length === 1, '应该删除1个空标签组');
  console.assert(youtubeDeleteResult.groupsDeleted[0] === 'group3', '应该删除group3');

  // 测试 3: 搜索 "com" 并批量删除（匹配多个标签组）
  console.log('\n测试 3: 搜索 "com" 并批量删除');
  const comMatches = getMatchingTabs(allGroups, 'com');
  console.log(`搜索到 ${comMatches.length} 个匹配的标签页`);

  const comDeleteResult = simulateBatchDelete(comMatches);
  console.log('删除结果:', comDeleteResult);
  console.assert(comDeleteResult.tabsDeleted >= 4, '应该删除至少4个标签页（不包括锁定标签组中的）');

  // 测试 4: 锁定标签组的处理
  console.log('\n测试 4: 锁定标签组的处理');
  const lockedGroupMatches = getMatchingTabs([lockedGroup], 'google');
  console.log(`在锁定标签组中搜索到 ${lockedGroupMatches.length} 个匹配的标签页`);

  const lockedDeleteResult = simulateBatchDelete(lockedGroupMatches);
  console.log('删除结果:', lockedDeleteResult);
  console.assert(lockedDeleteResult.tabsDeleted === 0, '锁定标签组中的标签页不应该被删除');
  console.assert(lockedDeleteResult.groupsDeleted.length === 0, '锁定的标签组不应该被删除');
  console.assert(lockedDeleteResult.groupsUpdated.length === 0, '锁定的标签组不应该被更新');

  // 测试 5: 空搜索结果的处理
  console.log('\n测试 5: 空搜索结果的处理');
  const emptyMatches = getMatchingTabs(allGroups, 'nonexistent');
  console.log(`搜索到 ${emptyMatches.length} 个匹配的标签页`);

  const emptyDeleteResult = simulateBatchDelete(emptyMatches);
  console.log('删除结果:', emptyDeleteResult);
  console.assert(emptyDeleteResult.tabsDeleted === 0, '空搜索结果不应该删除任何标签页');
  console.assert(emptyDeleteResult.groupsDeleted.length === 0, '空搜索结果不应该删除任何标签组');

  // 测试 6: 混合场景 - 部分标签组被完全清空，部分被部分清空
  console.log('\n测试 6: 混合场景测试');
  const mixedTab1 = createMockTab('mix1', 'Test Page 1', 'https://test1.com');
  const mixedTab2 = createMockTab('mix2', 'Test Page 2', 'https://test2.com');
  const mixedTab3 = createMockTab('mix3', 'Other Page', 'https://other.com');

  const mixedGroup1 = createMockTabGroup('mixGroup1', 'Mixed Group 1', [mixedTab1, mixedTab2]); // 全部匹配
  const mixedGroup2 = createMockTabGroup('mixGroup2', 'Mixed Group 2', [mixedTab1, mixedTab3]); // 部分匹配

  const mixedMatches = getMatchingTabs([mixedGroup1, mixedGroup2], 'test');
  console.log(`混合场景搜索到 ${mixedMatches.length} 个匹配的标签页`);

  const mixedDeleteResult = simulateBatchDelete(mixedMatches);
  console.log('删除结果:', mixedDeleteResult);
  console.assert(mixedDeleteResult.tabsDeleted === 3, '应该删除3个test相关标签页');
  console.assert(mixedDeleteResult.groupsDeleted.length === 1, '应该删除1个完全清空的标签组');
  console.assert(mixedDeleteResult.groupsUpdated.length === 1, '应该更新1个部分清空的标签组');

  console.log('\n所有测试完成！');
};

// 运行测试
runTests();
