import { logInfo } from '../../utils/log';

/**
 * 内部 URL = 浏览器 / 扩展自己的页面：保存下来没有意义（恢复时也开不出来），
 * 所以 filterValidTabs 直接丢掉。
 *
 * ── 这是本仓库第三套 URL 策略，也是唯一的内部 URL 判定（单源）──────────
 * 另外两套答的是不同问题，不要合并：
 * - utils/inputValidation.sanitizeTabUrl：「这个地址能不能被重新打开」
 * - utils/faviconUtils.isFaviconUrlSafe：「这个地址能不能当 <img src> 渲染」
 *
 * 本表答的是「这是不是我们自己的页面」。它与前两表正交且串联：前者按协议拒
 * （utils/inputValidation.sanitizeTabUrl），本表按前缀拒。about: 是唯一被两表
 * 同时点名、答案相反的协议——sanitizeTabUrl 放行它（合法可导航），本表判它
 * 内部（不保存）。这不是分叉事故，是两道门问的两个问题。
 *
 * ⚠️ 单源的直接后果：background/TabManager.saveCurrentTab 原先内联了一份残缺
 * 列表（只认 chrome:// 与 chrome-extension://，漏了 edge:// 与 about:），
 * 与本表对「什么算自己的页面」给出不同答案。已改为引用本函数。
 * 该改动**不改变任何可观测行为**（残余的那份其实已是死代码）：saveCurrentTab
 * 紧接着调用的 createTabGroupFromChromeTabs 内部先走 filterValidTabs →
 * isValidTab → 本函数，残缺列表拦不住的 edge:// / about: 在那里已被全部丢弃。
 * 改成单一真相源消除的是「同一判断两处不同答案」这个隐患（下次往本表加协议时，
 * 旧代码会静默漏掉 saveCurrentTab 这条路径），不是修一个正在漏的数据 bug。
 * 若要增删内部协议，只改这里一处。
 */
const INTERNAL_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:'];

export const isInternalUrl = (url: string): boolean =>
  INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix));

export const isValidTab = (tab: chrome.tabs.Tab): boolean => {
  if (tab.url) {
    return !isInternalUrl(tab.url);
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
