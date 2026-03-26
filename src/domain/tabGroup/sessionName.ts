const SESSION_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const SESSION_DAY_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
});

const formatDomainLabel = (hostname: string) => {
  const normalizedHostname = hostname.replace(/^www\./, '');
  const [primarySegment = normalizedHostname] = normalizedHostname.split('.');

  if (!primarySegment) {
    return '浏览器';
  }

  return primarySegment.charAt(0).toUpperCase() + primarySegment.slice(1);
};

const getDominantDomain = (tabs: chrome.tabs.Tab[]) => {
  const domainCounts = new Map<string, number>();

  tabs.forEach(tab => {
    if (!tab.url) {
      return;
    }

    try {
      const hostname = new URL(tab.url).hostname.replace(/^www\./, '');
      if (!hostname) {
        return;
      }

      domainCounts.set(hostname, (domainCounts.get(hostname) ?? 0) + 1);
    } catch {
      // Ignore invalid tab URLs when deriving a session name.
    }
  });

  const [domain, count] =
    [...domainCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];

  if (!domain || !count) {
    return null;
  }

  return {
    label: formatDomainLabel(domain),
    count,
  };
};

const getSessionTraitLabel = (tabs: chrome.tabs.Tab[]) => {
  const pinnedCount = tabs.filter(tab => tab.pinned).length;

  if (tabs.length >= 10) {
    return '深度工作会话';
  }

  if (pinnedCount >= 2) {
    return '固定标签会话';
  }

  if (tabs.length >= 4) {
    return '研究会话';
  }

  return '快速整理会话';
};

const formatSessionTime = (now: string) => {
  const date = new Date(now);
  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  const prefix = isToday ? '今天' : SESSION_DAY_FORMATTER.format(date);
  return `${prefix} ${SESSION_TIME_FORMATTER.format(date)}`;
};

export const deriveSessionNameFromChromeTabs = (
  tabs: chrome.tabs.Tab[],
  now: string
) => {
  const dominantDomain = getDominantDomain(tabs);
  const label =
    dominantDomain && dominantDomain.count >= Math.max(2, Math.ceil(tabs.length / 2))
      ? `${dominantDomain.label} 会话`
      : getSessionTraitLabel(tabs);

  return `${label} · ${formatSessionTime(now)}`;
};
