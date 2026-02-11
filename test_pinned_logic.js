// 测试脚本：验证收集固定页功能
// 在扩展popup控制台中运行

console.log('=== 测试收集固定页功能 ===');

// 1. 检查当前设置
chrome.storage.local.get('user_settings', (result) => {
  const collectPinnedTabs = result.user_settings?.collectPinnedTabs;
  console.log('1. 当前设置状态:');
  console.log('   collectPinnedTabs:', collectPinnedTabs);
  console.log('   类型:', typeof collectPinnedTabs);

  // 2. 检查当前标签页
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    const allTabs = tabs.length;
    const pinnedTabs = tabs.filter(t => t.pinned);
    const normalTabs = tabs.filter(t => !t.pinned);

    console.log('2. 当前标签页状态:');
    console.log('   总数:', allTabs);
    console.log('   固定页数:', pinnedTabs.length);
    console.log('   普通页数:', normalTabs.length);

    // 3. 模拟 filterValidTabs 逻辑
    console.log('3. 模拟过滤逻辑:');
    console.log('   includePinned 参数:', collectPinnedTabs);

    const shouldIncludePinned = collectPinnedTabs ?? false;
    console.log('   实际 includePinned 值:', shouldIncludePinned);

    // 模拟过滤
    const filteredTabs = tabs.filter(tab => {
      // 跳过内部页面
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) {
        return false;
      }
      // 固定页逻辑
      if (!shouldIncludePinned && tab.pinned) {
        console.log('   跳过固定页:', tab.title);
        return false;
      }
      return true;
    });

    const filteredPinned = filteredTabs.filter(t => t.pinned);

    console.log('4. 过滤结果:');
    console.log('   过滤后总数:', filteredTabs.length);
    console.log('   过滤后固定页数:', filteredPinned.length);
    console.log('   过滤后固定页列表:', filteredPinned.map(t => t.title));

    console.log('5. 预期行为:');
    if (collectPinnedTabs) {
      console.log('   ✅ 应该包含固定页');
      console.log('   ✅ 固定页应该被保存和关闭');
    } else {
      console.log('   ❌ 不应该包含固定页');
      console.log('   ❌ 固定页应该保持打开');
    }
  });
});

console.log('=== 测试完成 ===');