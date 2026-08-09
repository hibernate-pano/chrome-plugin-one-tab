document.addEventListener('DOMContentLoaded', async () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const type = urlParams.get('type');

  if (token && type === 'signup' && supabaseUrl) {
    try {
      // 保持验证页与当前配置的 Supabase 项目一致，避免 host 配置漂移。
      const verifyUrl = new URL('/auth/v1/verify', supabaseUrl);
      verifyUrl.searchParams.set('token', token);
      verifyUrl.searchParams.set('type', type);
      verifyUrl.searchParams.set('redirect_to', '');

      // 显示成功信息
      document.getElementById('loading').style.display = 'none';
      document.getElementById('success').style.display = 'block';

      window.location.replace(verifyUrl.toString());

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
