// 微信登录超时处理工具

// 微信登录超时时间（2分钟）
const WECHAT_LOGIN_TIMEOUT = 2 * 60 * 1000;

/**
 * 设置微信登录超时处理
 * @param tabId 微信登录标签页ID
 * @returns 超时处理器ID
 */
export const setWechatLoginTimeout = (tabId: number): number => {
  console.log('设置微信登录超时处理，标签页ID:', tabId);

  // 记录超时处理开始

  // 设置超时处理
  return window.setTimeout(async () => {
    try {
      // 检查标签页是否仍然存在
      const tabs = await chrome.tabs.query({});
      const tabExists = tabs.some(tab => tab.id === tabId);

      if (tabExists) {
        // 获取标签页信息
        const tab = await chrome.tabs.get(tabId);

        // 检查是否仍然是微信登录页面
        if (tab.url && tab.url.includes('wechat-login.html') && !tab.url.includes('access_token')) {
          console.log('微信登录超时，关闭标签页');

          // 显示登录超时通知
          chrome.notifications.create({
            type: 'basic',
            iconUrl: '/icons/icon128.png',
            title: '登录超时',
            message: '微信扫码登录超时，请重新尝试'
          });

          // 关闭标签页
          await chrome.tabs.remove(tabId);
        }
      }
    } catch (error) {
      console.error('处理微信登录超时出错:', error);
    }
  }, WECHAT_LOGIN_TIMEOUT);
};

/**
 * 清除微信登录超时处理
 * @param timeoutId 超时处理器ID
 */
export const clearWechatLoginTimeout = (timeoutId: number): void => {
  console.log('清除微信登录超时处理');
  window.clearTimeout(timeoutId);
};
