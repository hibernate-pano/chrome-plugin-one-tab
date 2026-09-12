const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 默认会话名：短格式时间戳（如「标签组 9月12日 19:51」）。
 * 不带秒与年份——列表里已有相对时间（今天/昨天/N 天前），
 * 完整时间戳在窄宽度下会先被截掉尾部的有效信息。
 */
export const buildTimestampSessionName = (now: string) => {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '标签组';
  return `标签组 ${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const deriveSessionNameFromChromeTabs = (
  _tabs: chrome.tabs.Tab[],
  now: string
) => {
  return buildTimestampSessionName(now);
};
