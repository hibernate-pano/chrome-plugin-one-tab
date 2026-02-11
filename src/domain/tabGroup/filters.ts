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

  console.log(`[DEBUG filterValidTabs] ========== 过滤标签页 ==========`);
  console.log(`[DEBUG filterValidTabs] options 参数:`, options);
  console.log(`[DEBUG filterValidTabs] includePinned 值: ${includePinned}`);
  console.log(`[DEBUG filterValidTabs] includePinned 类型: ${typeof includePinned}`);
  console.log(`[DEBUG filterValidTabs] 输入标签页数量: ${tabs.length}`);
  console.log(`[DEBUG filterValidTabs] 固定标签页数量: ${tabs.filter(t => t.pinned).length}`);

  const filtered = tabs.filter(tab => {
    if (!isValidTab(tab)) {
      console.log(`[DEBUG filterValidTabs] 跳过无效标签页: ${tab.title}`);
      return false;
    }
    if (!includePinned && tab.pinned) {
      console.log(`[DEBUG filterValidTabs] 跳过固定标签页: ${tab.title} (includePinned=${includePinned})`);
      return false;
    }
    return true;
  });

  console.log(`[DEBUG filterValidTabs] 过滤后标签页数量: ${filtered.length}`);
  console.log(`[DEBUG filterValidTabs] 过滤后的标签页:`, filtered.map(t => ({ title: t.title, pinned: t.pinned })));

  return filtered;
};
