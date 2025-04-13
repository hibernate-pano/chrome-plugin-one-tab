document.addEventListener('DOMContentLoaded', async () => {
  // 获取URL参数
  const urlParams = new URLSearchParams(window.location.search);
  const redirectUri = urlParams.get('redirect_uri');
  const state = urlParams.get('state');

  if (!redirectUri || !state) {
    document.getElementById('status-text').textContent = '参数错误，无法生成登录二维码';
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
  QRCode.toCanvas(document.getElementById('qrcode'), qrcodeContent, {
    width: 150,
    margin: 1,
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

  // 3. 模拟轮询检查扫码状态
  let pollingId;
  let scanStatus = 'waiting'; // waiting, scanned, confirmed, expired

  // 向背景脚本发送消息更新微信登录状态
  const updateLoginStatus = (status, error = null) => {
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
    // 实际应用中，这里应该调用微信API检查扫码状态
    // 这里我们模拟不同的状态变化

    if (scanStatus === 'waiting') {
      // 模拟用户扫码
      if (Math.random() < 0.3) { // 30%的概率扫码成功
        scanStatus = 'scanned';
        document.getElementById('status-text').textContent = '扫码成功，请在微信中确认';

        // 更新状态为扫码成功
        updateLoginStatus('scanning');
      }
    } else if (scanStatus === 'scanned') {
      // 模拟用户确认授权
      if (Math.random() < 0.5) { // 50%的概率确认授权
        scanStatus = 'confirmed';
        document.getElementById('status-text').textContent = '授权成功，正在登录...';

        // 更新状态为确认中
        updateLoginStatus('confirming');

        // 模拟登录成功后的回调
        // 在实际应用中，这里应该根据微信服务器的回调结果构造回调URL
        const code = 'simulated_wechat_auth_code_' + Date.now();
        const callbackUrl = `${decodeURIComponent(redirectUri)}#access_token=simulated_access_token&token_type=bearer&expires_in=3600&refresh_token=simulated_refresh_token&state=${state}`;

        // 清除轮询
        clearInterval(pollingId);

        // 跳转到回调URL
        setTimeout(() => {
          window.location.href = callbackUrl;
        }, 1500);
      }
    }
  };

  // 开始轮询
  pollingId = setInterval(checkScanStatus, 2000);

  // 设置二维码过期时间（2分钟）
  setTimeout(() => {
    if (scanStatus !== 'confirmed') {
      clearInterval(pollingId);
      scanStatus = 'expired';
      document.getElementById('status-text').textContent = '二维码已过期，请刷新页面重试';

      // 更新状态为过期
      updateLoginStatus('expired', '微信扫码登录超时');

      // 添加刷新按钮
      const refreshButton = document.createElement('button');
      refreshButton.textContent = '刷新二维码';
      refreshButton.className = 'button';
      refreshButton.style.marginLeft = '10px';
      refreshButton.addEventListener('click', () => {
        // 重置状态
        updateLoginStatus('pending');
        window.location.reload();
      });

      document.querySelector('.status').appendChild(refreshButton);
    }
  }, 120000); // 2分钟

  // 取消按钮
  document.getElementById('cancel-button').addEventListener('click', (e) => {
    e.preventDefault();
    clearInterval(pollingId);

    // 更新状态为失败
    updateLoginStatus('failed', '用户取消微信登录');

    // 关闭标签页
    window.close();
  });
});
