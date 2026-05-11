export const buildTimestampSessionName = (now: string) => {
  return `标签组 ${new Date(now).toLocaleString()}`;
};

export const deriveSessionNameFromChromeTabs = (
  _tabs: chrome.tabs.Tab[],
  now: string
) => {
  return buildTimestampSessionName(now);
};
