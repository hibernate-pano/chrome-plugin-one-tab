// 导入 QRCode 库
import QRCode from 'qrcode';

interface WechatLoginStatus {
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
  error?: string;
}

document.addEventListener('DOMContentLoaded', async () => {
  // 获取URL参数
  const urlParams = new URLSearchParams(window.location.search);
  const redirectUri = urlParams.get('redirect_uri');
  const state = urlParams.get('state');

  const statusTextElement = document.getElementById('status-text') as HTMLElement;
  const qrcodeElement = document.getElementById('qrcode') as HTMLCanvasElement;

  if (!redirectUri || !state) {
    if (statusTextElement) {
      statusTextElement.textContent = '参数错误，无法生成登录二维码';
    }
    return;
  }

  // 在实际应用中，这里应该调用微信开放平台的接口获取二维码内容
  // 这里我们模拟一个更真实的微信登录流程

  // 1. 构造一个模拟的微信授权URL（实际应用中应该从微信API获取）
  // 微信授权URL格式: https://open.weixin.qq.com/connect/qrconnect?appid=APPID&redirect_uri=REDIRECT_URI&response_type=code&scope=snsapi_login&state=STATE#wechat_redirect
  const appId = 'wx_simulated_app_id'; // 实际应用中应该使用真实的AppID
  const encodedRedirectUri = encodeURIComponent(redirectUri);
  const qrcodeContent = `https://open.weixin.qq.com/connect/qrconnect?appid=${appId}&redirect_uri=${encodedRedirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;

  // 2. 生成二维码
  if (qrcodeElement) {
    try {
      await QRCode.toCanvas(qrcodeElement, qrcodeContent, {
        width: 150,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
    } catch (error) {
      console.error('生成二维码失败:', error);
      if (statusTextElement) {
        statusTextElement.textContent = '生成二维码失败，请刷新页面重试';
      }
      return;
    }
  }

  // 3. 模拟轮询检查扫码状态
  let pollingId: number | undefined;
  let scanStatus: WechatLoginStatus['status'] = 'pending';

  // 向背景脚本发送消息更新微信登录状态
  const updateLoginStatus = (status: WechatLoginStatus['status'], error?: string) => {
    chrome.runtime.sendMessage({
      type: 'WECHAT_LOGIN_STATUS_UPDATE',
      payload: {
        status,
        error
      }
    });
  };

  // 初始化时设置状态为等待扫码
  updateLoginStatus('pending');

  const checkScanStatus = () => {
    // 完全禁用模拟微信登录
    if (statusTextElement) {
      statusTextElement.textContent = '微信登录功能暂未开放，请使用邮箱登录';
    }
    updateLoginStatus('error', '微信登录功能暂未开放');
    return;

    // 开发环境模拟扫码流程
    const now = Date.now();
    const startTime = parseInt(localStorage.getItem('wechat_login_start_time') || '0');
    const elapsed = now - startTime;

    // 模拟2分钟后过期
    if (elapsed > 120000) {
      scanStatus = 'expired';
      if (statusTextElement) {
        statusTextElement.textContent = '二维码已过期，请刷新页面重新获取';
      }
      updateLoginStatus('expired');
      if (pollingId) {
        clearInterval(pollingId);
      }
      return;
    }

    // 模拟扫码流程：5秒后模拟用户扫码，10秒后模拟确认登录
    if (elapsed > 10000 && scanStatus === 'scanned') {
      scanStatus = 'confirmed';
      if (statusTextElement) {
        statusTextElement.textContent = '登录成功，正在跳转...';
      }
      updateLoginStatus('confirmed');

      // 模拟登录成功，构造回调URL
      setTimeout(() => {
        const callbackUrl = `${window.location.origin}/oauth-callback.html#access_token=mock_access_token&refresh_token=mock_refresh_token&state=${state}&expires_in=3600`;
        window.location.href = callbackUrl;
      }, 1000);

      if (pollingId) {
        clearInterval(pollingId);
      }
    } else if (elapsed > 5000 && scanStatus === 'pending') {
      scanStatus = 'scanned';
      if (statusTextElement) {
        statusTextElement.textContent = '检测到扫码，请在手机上确认登录';
      }
      updateLoginStatus('scanned');
    }
  };

  // 设置扫码开始时间
  localStorage.setItem('wechat_login_start_time', Date.now().toString());

  // 开始轮询
  pollingId = window.setInterval(checkScanStatus, 1000);

  // 页面卸载时清理轮询
  window.addEventListener('beforeunload', () => {
    if (pollingId) {
      clearInterval(pollingId);
    }
  });

  // 模拟重试按钮功能
  const retryButton = document.getElementById('retry-button') as HTMLButtonElement;
  if (retryButton) {
    retryButton.addEventListener('click', () => {
      window.location.reload();
    });
  }
});

// 导出空对象以确保这是一个模块
export { };