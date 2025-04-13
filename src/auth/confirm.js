document.addEventListener('DOMContentLoaded', async () => {
  // 获取完整URL
  const fullUrl = window.location.href;
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const type = urlParams.get('type');

  if (token && type === 'signup') {
    try {
      // 直接将用户重定向到Supabase的验证端点
      const verifyUrl = `https://reccclnaxadbuccsrwmg.supabase.co/auth/v1/verify?token=${token}&type=${type}&redirect_to=`;

      // 显示成功信息
      document.getElementById('loading').style.display = 'none';
      document.getElementById('success').style.display = 'block';

      // 设置打开扩展的按钮
      document.getElementById('openExtension').addEventListener('click', (e) => {
        e.preventDefault();
        // 尝试关闭当前标签页并打开扩展
        window.close();
      });
    } catch (error) {
      console.error('验证失败:', error);

      // 显示错误信息
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'block';

      // 设置重试按钮
      document.getElementById('tryAgain').addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = chrome.runtime.getURL('popup.html');
      });
    }
  } else {
    // 无效的参数
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
  }
});
