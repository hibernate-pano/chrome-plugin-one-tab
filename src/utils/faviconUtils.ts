/**
 * Favicon URL 处理工具
 * 用于确保 favicon URL 符合 CSP 安全策略
 */

/**
 * 清理和验证 favicon URL，确保符合 CSP 策略
 * @param faviconUrl 原始 favicon URL
 * @returns 安全的 favicon URL 或空字符串
 */
export function sanitizeFaviconUrl(faviconUrl: string | undefined | null): string {
  // 如果没有 favicon URL，返回空字符串
  if (!faviconUrl || typeof faviconUrl !== 'string') {
    return '';
  }

  // 移除首尾空格
  const cleanUrl = faviconUrl.trim();
  
  // 如果是空字符串，返回空
  if (!cleanUrl) {
    return '';
  }

  try {
    const url = new URL(cleanUrl);
    
    // 允许的协议：https、data、chrome-extension
    const allowedProtocols = ['https:', 'data:', 'chrome-extension:'];
    
    if (allowedProtocols.includes(url.protocol)) {
      return cleanUrl;
    }
    
    // 如果是 http 协议，尝试转换为 https
    if (url.protocol === 'http:') {
      const httpsUrl = cleanUrl.replace(/^http:/, 'https:');
      console.log(`将 favicon URL 从 http 转换为 https: ${cleanUrl} -> ${httpsUrl}`);
      return httpsUrl;
    }
    
    // 其他不安全的协议，返回空字符串
    console.warn(`不安全的 favicon 协议，已过滤: ${url.protocol} - ${cleanUrl}`);
    return '';
    
  } catch (error) {
    // URL 格式无效
    console.warn(`无效的 favicon URL 格式，已过滤: ${cleanUrl}`, error);
    return '';
  }
}

/**
 * 批量处理 favicon URLs
 * @param faviconUrls favicon URL 数组
 * @returns 清理后的 favicon URL 数组
 */
export function sanitizeFaviconUrls(faviconUrls: (string | undefined | null)[]): string[] {
  return faviconUrls.map(sanitizeFaviconUrl).filter(url => url !== '');
}

/**
 * 检查 favicon URL 是否安全
 * @param faviconUrl favicon URL
 * @returns 是否安全
 */
export function isFaviconUrlSafe(faviconUrl: string | undefined | null): boolean {
  if (!faviconUrl) return false;

  try {
    const url = new URL(faviconUrl);
    const allowedProtocols = ['https:', 'data:', 'chrome-extension:'];
    return allowedProtocols.includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * 迁移现有数据，清理不安全的 favicon URLs
 * 这个函数应该在应用启动时调用一次
 */
export async function migrateFaviconUrls(): Promise<void> {
  try {
    // 这里需要导入storage，但为了避免循环依赖，我们将在调用处处理
    console.log('开始迁移 favicon URLs...');

    // 注意：实际的迁移逻辑将在调用此函数的地方实现
    // 这里只是一个占位符函数

  } catch (error) {
    console.error('迁移 favicon URLs 失败:', error);
  }
}
