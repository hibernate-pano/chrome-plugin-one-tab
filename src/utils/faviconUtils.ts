import { logError, logInfo, logWarn } from './log';
/**
 * Favicon URL 处理工具
 * 用于确保 favicon URL 符合 CSP 安全策略
 *
 * ── 为什么 favicon 的协议策略与标签页的不同（别把它们合并）─────────────
 * 仓库里有三套「URL 协议策略」，它们回答的是三个不同的问题，合并成一张表
 * 就会改变行为：
 *  1. 标签页 URL（inputValidation.sanitizeTabUrl）：这个地址能不能被**重新打开**。
 *     放行 ftp:/about:/loading:，因为它们是合法的可导航地址；拒绝 file:/blob:
 *     因为恢复会话等于让扩展去读本地文件 / 造同源 blob。
 *  2. favicon URL（本文件）：这个地址能不能被当成 <img src> 交给浏览器渲染。
 *     放行 data:（图标本身就是内联的，省一次网络往返），拒绝 ftp:（浏览器不会
 *     把 ftp 当图片源，只会白屏 + 一条无意义的告警）。所以这里 ftp 与标签页
 *     的答案相反——这是有意的，不是分叉事故。
 *  3. 内部 URL（domain/tabGroup/filters.isInternalUrl）：这是不是浏览器/扩展
 *     自己的页面（不保存、会话恢复也开不出来）。见该文件的注释。
 *
 * 单一真相源：
 * - 策略谓词只有 {@link isFaviconUrlSafe} 一份（纯函数，不打日志）。
 * - {@link sanitizeFaviconUrl} 是它上面的一层「清理 + 留痕」包装。
 *   此前这两份是逐字相同的拷贝（只差返回 boolean 与不返回），改一处漏一处
 *   就会出现「列表里过滤了、渲染时没过滤」的不一致。
 */

/** favicon 允许的协议：https、http、data、chrome-extension */
const ALLOWED_FAVICON_PROTOCOLS: readonly string[] = ['https:', 'http:', 'data:', 'chrome-extension:'];

/** favicon 危险协议：javascript、vbscript、file、ftp */
const DANGEROUS_FAVICON_PROTOCOLS: readonly string[] = ['javascript:', 'vbscript:', 'file:', 'ftp:'];

/**
 * favicon URL 协议策略的唯一实现（纯谓词，不打日志、不 trim）。
 *
 * 调用方要日志就自己打（sanitizeFaviconUrl 会打；SafeFavicon 组件在
 * useEffect 里已经自己 logWarn，再叠一层只会双写）。
 * @param faviconUrl 原始 favicon URL（不预先 trim，与既有行为一致）
 * @returns 是否允许作为图片源
 */
export function isFaviconUrlSafe(faviconUrl: string | undefined | null): boolean {
  if (!faviconUrl) return false;

  try {
    const url = new URL(faviconUrl);
    if (DANGEROUS_FAVICON_PROTOCOLS.includes(url.protocol)) return false;
    return ALLOWED_FAVICON_PROTOCOLS.includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * 清理和验证 favicon URL，确保符合 CSP 策略
 * @param faviconUrl 原始 favicon URL
 * @returns 安全的 favicon URL（已 trim）或空字符串
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

  if (isFaviconUrlSafe(cleanUrl)) {
    return cleanUrl;
  }

  // 不安全：区分「已知危险」与「未知协议」两类打日志，排查时能一眼看出是哪种
  try {
    const { protocol } = new URL(cleanUrl);
    if (DANGEROUS_FAVICON_PROTOCOLS.includes(protocol)) {
      logWarn(`危险的 favicon 协议，已过滤: ${protocol} - ${cleanUrl}`);
    } else {
      logWarn(`未知的 favicon 协议，已过滤: ${protocol} - ${cleanUrl}`);
    }
  } catch (error) {
    // URL 格式无效
    logWarn(`无效的 favicon URL 格式，已过滤: ${cleanUrl}`, error);
  }
  return '';
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
 * 迁移现有数据，清理不安全的 favicon URLs
 * 这个函数应该在应用启动时调用一次
 */
export async function migrateFaviconUrls(): Promise<void> {
  try {
    // 这里需要导入storage，但为了避免循环依赖，我们将在调用处处理
    logInfo('开始迁移 favicon URLs...');

    // 注意：实际的迁移逻辑将在调用此函数的地方实现
    // 这里只是一个占位符函数

  } catch (error) {
    logError('迁移 favicon URLs 失败:', error);
  }
}
