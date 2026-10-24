/**
 * 「保存整窗」必须作用在**点的那一个窗口**里（2026-10-24 恢复旧交互的配套钉）。
 *
 * ── 为什么要有这个守卫 ──────────────────────────────────────────────────
 *
 * 产品负责人反馈：「在单独的 Chrome APP 实例里点击，标签页和标签管理器
 * 并未成功展示」—— 多 Chrome 实例并存时，旧交互（点图标 = 把这一窗收起来）
 * 才是对的，但**前提是动作真的发生在你点的那一边**。
 *
 * 旧实现里有一处破坏这个前提的地方：
 *
 *   `chrome.tabs.create({ url: 'chrome://newtab' })`  ← 关标签前的占位新标签
 *
 * 不带 `windowId` 的 `tabs.create` 开在「**最后被聚焦的窗口**」，而不是
 * 「被关标签所在的那个窗口」。多窗口 / 多实例时后果是：
 *
 *   · 用户点的那一边：标签被清空、窗口**整个消失**（Chrome 会关掉空窗口）；
 *   · 另一个窗口：凭空多出一个空白新标签。
 *
 * ⇒ 用户的观感就是「点了，标签没了，窗口没了，也没看到管理器」。
 *
 * 守卫判据是**行为**：`tabManager.saveAllTabs([窗口 42 的标签])` 之后，
 * 占位新标签必须开在窗口 42，被关的必须是那批标签的 id。
 * 「源码里出现了 windowId」= 零检测力，本文件不做那种检查。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface CreatedTab {
  url?: string;
  windowId?: number;
}

interface RemovedTabs {
  ids: number[];
}

/**
 * 装一套 chrome mock：只关心 `tabs.create` / `tabs.remove` 这两个副作用，
 * 其余按「什么都不做」处理（本地存储是 no-op ⇒ 落盘不影响被观测的行为）。
 */
function installChromeMock() {
  const created: CreatedTab[] = [];
  const removed: RemovedTabs[] = [];

  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length() { return lsData.size; },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => lsData.get(k) ?? null,
    setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
    removeItem: (k: string) => { lsData.delete(k); },
    clear: () => lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;
  lsData.set('user_settings', JSON.stringify({ showNotifications: false }));

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = undefined;
          return out;
        },
        async set() { /* noop */ },
        async remove() { /* noop */ },
      },
    },
    notifications: {
      create() { return Promise.resolve('generated-id'); },
    },
    action: {
      async setBadgeText() { /* noop */ },
      async setBadgeBackgroundColor() { /* noop */ },
      async setTitle() { /* noop */ },
    },
    alarms: {
      create() { /* noop */ },
      async clear() { return true; },
    },
    tabs: {
      async query() { return []; },
      async create(props: CreatedTab) { created.push(props); return { id: 999 }; },
      async remove(ids: number | number[]) {
        removed.push({ ids: Array.isArray(ids) ? ids : [ids] });
      },
    },
  };

  return { created, removed };
}

const WINDOW_ID = 42;

const makeTab = (id: number, windowId: number) =>
  ({
    id,
    url: `https://example.com/${id}`,
    title: `Tab ${id}`,
    pinned: false,
    windowId,
    index: id,
    active: false,
    highlighted: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: 0,
  }) as unknown as chrome.tabs.Tab;

describe('保存整窗：占位新标签必须开在被关标签所在的那个窗口', () => {
  it('占位新标签带着那个窗口的 windowId', async () => {
    const handles = installChromeMock();
    const { tabManager } = await import('@/background/TabManager');

    const saved = await tabManager.saveAllTabs([makeTab(1, WINDOW_ID), makeTab(2, WINDOW_ID)]);

    assert.ok(saved, '这两个标签是可保存的 ⇒ 必须真的存成会话（否则下面什么都没发生）');
    const placeholder = handles.created.find(tab => tab.url === 'chrome://newtab');
    assert.ok(placeholder, '关标签前必须先开一个占位新标签 —— 否则 Chrome 会把空窗口整个关掉');
    assert.equal(
      placeholder.windowId,
      WINDOW_ID,
      '占位新标签必须开在被关标签所在的那个窗口 —— 不带 windowId 会开在' +
        '「最后被聚焦的窗口」，多实例时用户在自己这边看着窗口消失、别的窗口凭空多出空白页'
    );
  });

  it('被关掉的正是传进来的那批标签', async () => {
    const handles = installChromeMock();
    const { tabManager } = await import('@/background/TabManager');

    await tabManager.saveAllTabs([makeTab(1, WINDOW_ID), makeTab(2, WINDOW_ID)]);

    assert.equal(handles.removed.length, 1, '只该关一次');
    assert.deepEqual(
      [...handles.removed[0].ids].sort((a, b) => a - b),
      [1, 2],
      '关掉的必须是传进来的那批标签 —— 关错了窗口就是「A 实例的标签被 B 实例收走」'
    );
  });
});
