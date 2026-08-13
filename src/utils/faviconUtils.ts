/**
 * Favicon URL 处理工具
 * 用于确保 favicon URL 符合 CSP 安全策略
 */

/**
 * 允许的 favicon 协议白名单 —— 与 manifest.json CSP `img-src 'self' data: https:` 严格对齐。
 *
 * 之前列表里包含 `http:` 和 `chrome-extension:`，但 manifest CSP 不允许这两个
 * scheme（'self' 只匹配当前扩展自身，非任意 chrome-extension://）。结果是
 * sanitize 通过的 URL 在浏览器实际加载时仍被 CSP 拦截，console 刷出大量
 * "Loading the image violates CSP" 错误（每条 favicon 一行）。
 *
 * 现在收紧到 manifest 白名单本身：
 *   - https:   —— 站点 favicon，常见
 *   - data:    —— 内联 base64 图，常见于扩展自己生成的占位图标
 *   - 'self'   —— chrome-extension://[this-ext-id]/...；协议层无法表达，依赖
 *                 Chrome CSP 自己匹配（'self' 自动包含当前扩展 origin），
 *                 因此不在 allowedProtocols 里。
 *
 * 如果用户真的需要把 chrome-extension:// 资源当 favicon，应该用 chrome.runtime.getURL
 * 构造的 URL（'self' 命中）——而不是任意外部扩展的资源。
 */
const ALLOWED_FAVICON_PROTOCOLS = ['https:', 'data:'] as const;

const DANGEROUS_FAVICON_PROTOCOLS = [
  'javascript:',
  'vbscript:',
  'file:',
  'ftp:',
  // Chrome 内部 scheme：扩展 manifest CSP 不允许这些 protocol，
  // 即使 sanitize 通过也只会被浏览器拦截 + console 报错。
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'view-source:',
  'about:',
] as const;

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

    // 危险协议 → 直接过滤（不 log，避免 console 噪音）
    if ((DANGEROUS_FAVICON_PROTOCOLS as readonly string[]).includes(url.protocol)) {
      return '';
    }

    // 只允许 manifest CSP 白名单内的 protocol
    if ((ALLOWED_FAVICON_PROTOCOLS as readonly string[]).includes(url.protocol)) {
      return cleanUrl;
    }

    // 其他未知协议（如 ws: blob: 等）→ 过滤
    return '';
  } catch {
    // URL 格式无效
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
 * 与 sanitizeFaviconUrl 保持同样的白名单（manifest CSP 对齐）。
 * @param faviconUrl favicon URL
 * @returns 是否安全
 */
export function isFaviconUrlSafe(faviconUrl: string | undefined | null): boolean {
  if (!faviconUrl) return false;

  try {
    const url = new URL(faviconUrl);

    if ((DANGEROUS_FAVICON_PROTOCOLS as readonly string[]).includes(url.protocol)) {
      return false;
    }

    return (ALLOWED_FAVICON_PROTOCOLS as readonly string[]).includes(url.protocol);
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
