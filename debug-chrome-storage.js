// 数据调试脚本 - 检查Chrome存储中的实际数据
(async function debugStorage() {
  console.log('=== Chrome存储调试开始 ===');
  
  try {
    // 获取所有存储的数据
    const allData = await chrome.storage.local.get(null);
    console.log('所有存储的键:', Object.keys(allData));
    console.log('完整存储数据:', allData);
    
    // 检查标签组数据
    if (allData.tab_groups) {
      console.log('✅ 找到标签组数据');
      console.log('标签组数量:', allData.tab_groups.length);
      allData.tab_groups.forEach((group, index) => {
        console.log(`标签组 ${index + 1}:`, {
          id: group.id,
          name: group.name,
          tabCount: group.tabs?.length || 0,
          createdAt: group.createdAt
        });
      });
    } else {
      console.log('❌ 没有找到标签组数据');
    }
    
    // 检查设置数据
    if (allData.user_settings) {
      console.log('✅ 找到用户设置');
      console.log('设置数据:', allData.user_settings);
    } else {
      console.log('❌ 没有找到用户设置');
    }
    
    // 检查认证缓存
    if (allData.auth_cache) {
      console.log('✅ 找到认证缓存');
      console.log('认证缓存:', allData.auth_cache);
      
      // 检查缓存是否过期
      const now = Date.now();
      const cacheAge = now - allData.auth_cache.timestamp;
      const cacheExpired = cacheAge > 30 * 24 * 60 * 60 * 1000;
      console.log('缓存年龄（天）:', Math.floor(cacheAge / (24 * 60 * 60 * 1000)));
      console.log('缓存是否过期:', cacheExpired);
    } else {
      console.log('❌ 没有找到认证缓存');
    }
    
  } catch (error) {
    console.error('调试脚本错误:', error);
  }
  
  console.log('=== Chrome存储调试结束 ===');
})();