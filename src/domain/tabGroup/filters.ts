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
  // 加载中的标签：url 为空但 pendingUrl 有值 —— 保留它，让 factory 用
  // pendingUrl 落盘（见 resolveStorableUrl）。两者都空才靠 title 兜底。
  if (tab.pendingUrl) {
    return isStorableTabUrl(tab.pendingUrl) && !isInternalUrl(tab.pendingUrl);
  }
  return !!tab.title && tab.title.trim().length > 0;
};

/**
 * 这个标签**真正**的网址是什么（2026-10-19 审计 F-2）。
 *
 * 【为什么需要这个函数】Chrome 在标签仍在加载时给出 `url: ''` +
 * `pendingUrl: 'https://…'`。原先 factory 写死 `tab.url || 'about:blank'`，
 * 于是恢复出来的会话里躺着一条空白页，真实网址**永久丢失** —— 而保存动作
 * 同时把原标签关掉了，用户连「那个页面是什么」都无从得知。
 *
 * 判据顺序（唯一口径，两个调用方共用）：
 *   1. `tab.url`  —— 正式地址
 *   2. `tab.pendingUrl` —— 加载中的目标地址
 *   3. 都没有 → **返回空串**，由调用方丢弃这条标签
 *
 * 【为什么第 3 步不兜底成 about:blank】about:blank 是能存、能同步、能恢复的
 * 假地址：它会出现在会话里、恢复时开出一个空白页，让用户以为那个网页还在。
 * 「这条标签没存下来」比「存了一条空的」诚实得多 —— 前者会少一条记录，
 * 后者会让用户反复去找一个已经找不到的页面。
 *
 * pendingUrl 也要过协议门：它是浏览器即将导航到的地址，与 url 同一套策略
 * （危险 schema / 内部页同样不存）。
 */
export const resolveStorableUrl = (tab: chrome.tabs.Tab): string => {
  const candidates = [tab.url, tab.pendingUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  for (const candidate of candidates) {
    if (isStorableTabUrl(candidate) && !isInternalUrl(candidate)) {
      return candidate;
    }
  }
  return '';
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

/**
 * 这批标签里**真正能被收集**的是哪些（= 会被存进会话的那些）。
 *
 * ── 为什么需要这个函数（2026-10-26 产品定案）──────────────────────────────
 *
 * 点扩展图标的契约变成了「**无论有没有可收集的标签，都打开标签管理器**」：
 * 有 ⇒ 先收集再打开；没有 ⇒ 直接打开。
 * ⇒ 调用方必须能**先判断**「有没有可收集的标签」——
 *   而这个判断必须与**保存路径**用的是**同一套**判据，
 *   否则会出现「图标说有、实际一个都存不下」（用户看到管理器打开却什么都没存，
 *   或者反过来：明明有标签，图标却说没有、直接跳过了收集）。
 *
 * ⇒ 判据 = `filterValidTabs`（内部页 / 危险 schema / 固定标签开关）
 *   **加上**「URL 解析得出来」（`resolveStorableUrl` 非空）——
 *   后者与 factory 里落盘用的 URL 是同一个判据：解析不出来的标签落盘就是
 *   一条空地址（`about:blank` 那种假记录）。
 *
 * ⚠️ `createTabGroupFromChromeTabs` 用的就是它 ⇒ 两条路**不可能**漂移。
 */
export const collectableTabs = (
  tabs: chrome.tabs.Tab[],
  options: FilterTabsOptions = {}
): chrome.tabs.Tab[] =>
  filterValidTabs(tabs, options).filter(tab => resolveStorableUrl(tab).length > 0);
