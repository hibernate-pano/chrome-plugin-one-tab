// OAuth回调处理页面
// 此页面仅用于显示，实际的OAuth回调处理在background.ts中完成
// 页面会在background.ts中处理完OAuth回调后自动关闭

// 显示加载状态
document.addEventListener('DOMContentLoaded', () => {
  const statusElement = document.getElementById('status');
  if (statusElement) {
    statusElement.textContent = '正在处理登录回调，请稍候...';
  }
});

// 导出空对象以确保这是一个模块
export {};