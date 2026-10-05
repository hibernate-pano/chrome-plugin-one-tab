import { logInfo } from '../../utils/log';
import { isStorableTabUrl } from '../../utils/inputValidation';

/**
 * 内部 URL = 浏览器 / 扩展自己的页面：保存下来没有意义（恢复时也开不出来），
 * 所以 filterValidTabs 直接丢掉。
 *
 * ── 这是本仓库的 URL 策略单源（2026-10-05 起）──────────────────────────
 * 本表答的是「这是不是我们自己的页面」，按**前缀**拒；下面引用的
 * isStorableTabUrl 答的是「这个 URL 能不能存进数据库」，按**协议**拒。
 * 两道门串联：先过协议表（拒 javascript:/vbscript:/data: 这类危险 schema），
 * 再过本表（拒 chrome:// / edge:// / chrome-extension:// / about:）。
 *
 * ⚠️ 别再加第三套表。历史上这里是「两套表对 about: 给出相反答案」的根源：
 * 本表判它内部（不保存）、旧版 sanitizeTabUrl 放行它（合法可导航）。
 * 现在 sanitizeTabUrl 已拆成 isStorableTabUrl（存） / isOpenableTabUrl（开），
 * about: 在**存储门**下不可存（about:blank 无内容），在本表下也判内部——
 * 两个问题各自的答案都由唯一一处给出。
 *
 * ⚠️ 2026-10-05 之前 isValidTab **只看本表**，于是 file: / blob: / devtools: /
 * view-source: 全部放行并入库，而当时的还原侧（sanitizeTabUrl 等价于
 * 「可打开」）会把它们滤掉——产生「存得下、回不来」的会话，且还原率判据
 * 按整组生效会把同组正常标签一起隐藏。现在协议由 isStorableTabUrl 统一裁决，
 * file:/blob: 这类「有保存价值但本设备打不开」的地址可以入库（打开与否由
 * isOpenableTabUrl 在渲染/点击时判定），危险 schema 则在入库前就拒。
 *
 * 若要增删内部协议，只改这里一处。
 */
const INTERNAL_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:'];

export const isInternalUrl = (url: string): boolean =>
  INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix));

export const isValidTab = (tab: chrome.tabs.Tab): boolean => {
  if (tab.url) {
    // 协议门 + 内部页门：任一不过即丢弃
    return isStorableTabUrl(tab.url) && !isInternalUrl(tab.url);
  }
  return !!tab.title && tab.title.trim().length > 0;
};

export interface FilterTabsOptions {
  /**
   * 是否包含固定标签页（pinned tabs）
   * - true：包含 pinned 标签页
   * - false：排除所有 pinned 标签页（默认）
   */
  includePinned?: boolean;
}

export const filterValidTabs = (
  tabs: chrome.tabs.Tab[],
  options: FilterTabsOptions = {}
): chrome.tabs.Tab[] => {
  const includePinned = options.includePinned ?? false;

  logInfo(`[DEBUG filterValidTabs] ========== 过滤标签页 ==========`);
  logInfo(`[DEBUG filterValidTabs] options 参数:`, options);
  logInfo(`[DEBUG filterValidTabs] includePinned 值: ${includePinned}`);
  logInfo(`[DEBUG filterValidTabs] includePinned 类型: ${typeof includePinned}`);
  logInfo(`[DEBUG filterValidTabs] 输入标签页数量: ${tabs.length}`);
  logInfo(`[DEBUG filterValidTabs] 固定标签页数量: ${tabs.filter(t => t.pinned).length}`);

  const filtered = tabs.filter(tab => {
    if (!isValidTab(tab)) {
      logInfo(`[DEBUG filterValidTabs] 跳过无效标签页: ${tab.title}`);
      return false;
    }
    if (!includePinned && tab.pinned) {
      logInfo(`[DEBUG filterValidTabs] 跳过固定标签页: ${tab.title} (includePinned=${includePinned})`);
      return false;
    }
    return true;
  });

  logInfo(`[DEBUG filterValidTabs] 过滤后标签页数量: ${filtered.length}`);
  logInfo(`[DEBUG filterValidTabs] 过滤后的标签页:`, filtered.map(t => ({ title: t.title, pinned: t.pinned })));

  return filtered;
};
