// 临时修复方案：强制清除设置缓存
// 在扩展popup控制台中运行

// 1. 清除设置缓存（如果storage.ts中有缓存机制）
console.log('清除设置缓存...');

// 2. 强制重新读取设置
chrome.storage.local.get('user_settings', (result) => {
  console.log('当前存储的设置:', result.user_settings);

  // 3. 如果设置不正确，手动修复
  if (result.user_settings) {
    const currentSettings = result.user_settings;
    console.log('当前 collectPinnedTabs 值:', currentSettings.collectPinnedTabs);

    // 如果你想手动设置为 false（不收集固定页）
    // currentSettings.collectPinnedTabs = false;
    // chrome.storage.local.set({ user_settings: currentSettings }, () => {
    //   console.log('已手动设置 collectPinnedTabs 为 false');
    // });

    // 如果你想手动设置为 true（收集固定页）
    // currentSettings.collectPinnedTabs = true;
    // chrome.storage.local.set({ user_settings: currentSettings }, () => {
    //   console.log('已手动设置 collectPinnedTabs 为 true');
    // });
  }
});

console.log('请根据需要取消注释上面的代码来手动修复设置');