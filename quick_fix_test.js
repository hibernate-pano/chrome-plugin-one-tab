// 快速诊断和修复脚本
// 在扩展popup控制台中运行

console.log('=== 快速诊断收集固定页问题 ===');

// 步骤1：检查当前设置
chrome.storage.local.get('user_settings', (result) => {
  console.log('步骤1 - 当前存储的设置:');
  console.log('完整设置:', result.user_settings);
  console.log('collectPinnedTabs:', result.user_settings?.collectPinnedTabs);

  // 步骤2：如果设置不正确，手动修复
  if (result.user_settings) {
    const settings = result.user_settings;

    // 检查当前UI状态（假设你想要开启收集固定页）
    console.log('\n步骤2 - 手动设置测试:');

    // 测试开启收集固定页
    console.log('设置 collectPinnedTabs = true (收集固定页)');
    settings.collectPinnedTabs = true;

    chrome.storage.local.set({ user_settings: settings }, () => {
      console.log('✅ 已设置 collectPinnedTabs = true');

      // 步骤3：验证设置
      chrome.storage.local.get('user_settings', (newResult) => {
        console.log('\n步骤3 - 验证设置:');
        console.log('新的 collectPinnedTabs 值:', newResult.user_settings?.collectPinnedTabs);

        // 步骤4：测试保存功能
        console.log('\n步骤4 - 测试保存功能:');
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          const windowId = tabs[0]?.windowId;
          const pinnedCount = tabs.filter(t => t.pinned).length;

          console.log('当前窗口固定页数量:', pinnedCount);
          console.log('即将发送保存消息...');

          chrome.runtime.sendMessage({
            type: 'SAVE_ALL_TABS',
            data: { windowId }
          }, (response) => {
            console.log('保存响应:', response);
            console.log('\n请检查Service Worker控制台查看详细日志');
            console.log('如果固定页被正确保存，说明修复成功！');
          });
        });
      });
    });
  }
});

console.log('\n注意：请同时打开Service Worker控制台查看详细日志');