import { nanoid } from '@reduxjs/toolkit';
import { Tab, TabGroup } from '@/types/tab';
import { sanitizeFaviconUrl } from '@/utils/faviconUtils';
import { filterValidTabs, resolveStorableUrl } from './filters';
import { buildTimestampSessionName } from './sessionName';

export interface CreateTabGroupOptions {
  name?: string;
  now?: string;
  /**
   * 是否包含固定标签页（pinned tabs）
   * 默认 false，调用方可按用户设置传入 true
   */
  includePinned?: boolean;
}

export function createTabGroupFromChromeTabs(
  tabs: chrome.tabs.Tab[],
  options: CreateTabGroupOptions = {}
): TabGroup {
  const validTabs = filterValidTabs(tabs, {
    includePinned: options.includePinned ?? false,
  });
  const now = options.now ?? new Date().toISOString();
  // ── 默认会话名 = **保存时刻**（2026-10-25 产品定案，无例外）──────────────
  // 名字**不猜**：不按域名、不按页面标题，只给一个不会说谎的时间戳，
  // 想叫什么由用户点一下标题自己改。
  // ⚠️ 名字与 `createdAt`/`updatedAt` 用**同一个** `now` ⇒ 卡片上写的
  // 「保存时间」与名字里的时间**必然一致**（不一致就是两个时钟打架）。
  const name = options.name ?? buildTimestampSessionName(now);

  const formattedTabs: Tab[] = validTabs.map(tab => ({
    id: nanoid(),
    // ── 2026-10-19 审计 F-2：加载中的标签不能被存成 about:blank ─────────
    // Chrome 在标签仍在加载时给出 `url: ''` + `pendingUrl: 'https://…'`。
    // 原先这里写死 `tab.url || 'about:blank'` —— 于是恢复出来的会话里躺着
    // 一条空白页，真实网址**永久丢失**（而保存动作同时把原标签关掉了）。
    //
    // 判据顺序：正式 url → pendingUrl → 丢弃。
    // 「两者都空」时**不**兜底成 about:blank：那是一个能存、能同步、能恢复
    // 的假地址，比没有这条记录更糟（用户以为会话里有这个网页）。
    // 没有 url 的标签在 filters.isValidTab 里本就靠 title 存活，所以这里
    // 必须显式丢弃 —— 否则就是「保留了一条空地址」。
    url: resolveStorableUrl(tab),
    title: tab.title || '未命名标签页',
    favicon: sanitizeFaviconUrl(tab.favIconUrl),
    createdAt: now,
    lastAccessed: now,
    // 将 Chrome 标签页的固定状态持久化到应用数据中
    pinned: !!tab.pinned,
  })).filter(tab => tab.url.length > 0);

  return {
    id: nanoid(),
    name,
    tabs: formattedTabs,
    createdAt: now,
    updatedAt: now,
    isLocked: false,
  };
}
