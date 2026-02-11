// 诊断脚本：检查收集固定页设置的状态
// 在扩展的popup页面控制台中运行此脚本

console.log('=== 开始诊断收集固定页设置 ===');

// 1. 检查 Chrome Storage 中的实际设置
chrome.storage.local.get('user_settings', (result) => {
  console.log('1. Chrome Storage 中的设置:');
  console.log('   完整设置对象:', result.user_settings);
  console.log('   collectPinnedTabs 值:', result.user_settings?.collectPinnedTabs);
  console.log('   collectPinnedTabs 类型:', typeof result.user_settings?.collectPinnedTabs);
});

// 2. 检查当前窗口的标签页状态
chrome.tabs.query({ currentWindow: true }, (tabs) => {
  const pinnedTabs = tabs.filter(t => t.pinned);
  const normalTabs = tabs.filter(t => !t.pinned);

  console.log('2. 当前窗口标签页状态:');
  console.log('   总标签页数:', tabs.length);
  console.log('   固定标签页数:', pinnedTabs.length);
  console.log('   普通标签页数:', normalTabs.length);
  console.log('   固定标签页列表:', pinnedTabs.map(t => ({ title: t.title, url: t.url })));
});

// 3. 模拟发送保存消息并监听响应
console.log('3. 模拟发送保存全部标签页消息...');
chrome.tabs.query({ currentWindow: true }, (tabs) => {
  const windowId = tabs[0]?.windowId;
  chrome.runtime.sendMessage({
    type: 'SAVE_ALL_TABS',
    data: { windowId }
  }, (response) => {
    console.log('   保存消息响应:', response);
  });
});

console.log('=== 诊断脚本执行完成，请查看上述输出 ===');