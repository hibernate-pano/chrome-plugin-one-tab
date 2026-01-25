const INTERNAL_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:'];

export const isInternalUrl = (url: string): boolean =>
  INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix));

export const isValidTab = (tab: chrome.tabs.Tab): boolean => {
  if (tab.url) {
    return !isInternalUrl(tab.url);
  }
  return !!tab.title && tab.title.trim().length > 0;
};

export const filterValidTabs = (tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] =>
  tabs.filter(isValidTab);
