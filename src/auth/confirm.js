document.addEventListener('DOMContentLoaded', async () => {
  // 获取完整URL
  const fullUrl = window.location.href;
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const type = urlParams.get('type');

  // 验证输入参数
  if (!token || !type) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    return;
  }

  // 验证 token 格式（简单检查）
  if (token.length < 10 || !/^[a-zA-Z0-9._-]+$/.test(token)) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    return;
  }

  // 验证 type 参数
  if (!['signup', 'recovery', 'email_change'].includes(type)) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    return;
  }

  try {
    // 安全地构造验证URL
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://reccclnaxadbuccsrwmg.supabase.co';
    const verifyUrl = new URL(`${supabaseUrl}/auth/v1/verify`);
    verifyUrl.searchParams.append('token', token);
    verifyUrl.searchParams.append('type', type);
    verifyUrl.searchParams.append('redirect_to', '');

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
});
