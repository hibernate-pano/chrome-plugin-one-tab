import { nanoid } from '@reduxjs/toolkit';
import { Tab, TabGroup } from '@/types/tab';
import { sanitizeFaviconUrl } from '@/utils/faviconUtils';
import { filterValidTabs } from './filters';

export interface CreateTabGroupOptions {
  name?: string;
  now?: string;
}

export function createTabGroupFromChromeTabs(
  tabs: chrome.tabs.Tab[],
  options: CreateTabGroupOptions = {}
): TabGroup {
  const validTabs = filterValidTabs(tabs);
  const now = options.now ?? new Date().toISOString();
  const name = options.name ?? `标签组 ${new Date(now).toLocaleString()}`;

  const formattedTabs: Tab[] = validTabs.map(tab => ({
    id: nanoid(),
    url: tab.url || 'about:blank',
    title: tab.title || '未命名标签页',
    favicon: sanitizeFaviconUrl(tab.favIconUrl),
    createdAt: now,
    lastAccessed: now,
  }));

  return {
    id: nanoid(),
    name,
    tabs: formattedTabs,
    createdAt: now,
    updatedAt: now,
    isLocked: false,
  };
}
