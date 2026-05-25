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

  return tabs.filter(tab => {
    if (!isValidTab(tab)) return false;
    if (!includePinned && tab.pinned) return false;
    return true;
  });
};
