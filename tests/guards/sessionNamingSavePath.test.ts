/**
 * 保存路径的**端到端**命名守卫：真调 `tabManager.saveAllTabs()`，读落盘的会话，
 * 断言它拿到的是**规则算出来的那个名字**。
 *
 * ── 为什么还要这一条（⑤ 只钉到 factory）────────────────────────────────────
 *
 * ⑤（`sessionNaming.test.ts`）钉的是「factory 造出来的会话叫什么」。
 * 这一条钉的是**更前面那一段**：用户点「保存并关闭」⇒ SW 的 `TabManager`
 * ⇒ factory ⇒ 落盘 ⇒ 会话出现在列表里。中间任何一段**绕过**命名判据
 * （比如 SW 自己塞了个名字、或者 factory 被改成走别的规则），
 * ⑤ 都看不见 —— 它测的是函数，不是**产品动作**。
 *
 * ⚠️ 判据钉的是**落盘后的数据**（`localStorage` 里的 `tab_groups`），
 * 不是「源码里出现了某个函数名」—— 后者在被绕开时仍然是绿的。
 *
 * ── 为什么在 Node 里跑就够，不必真机 ───────────────────────────────────────
 *
 * 保存路径的**命名**没有任何浏览器行为参与（纯函数 + 一次落盘）；
 * 真机才能证明的是「点击 → 通知 → 关标签」那一段，那由
 * `saveAllTabsWindowScope` / `iconClickSavesWindow` 那些守卫负责。
 * ⇒ 这里用 chrome mock + localStorage 桩，把 SW 的保存流程**真跑一遍**，
 * 断言**落盘的数据**符合规则 —— 确定、快、不 flaky。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimestampSessionName } from '@/domain/tabGroup/sessionName';

interface StoredGroup {
  name?: string;
  tabs?: Array<{ url?: string }>;
}

/**
 * 装一套 chrome mock + localStorage 桩。
 *
 * ⚠️ **localStorage 桩必须在 import TabManager 之前装好** ——
 * KV 层在模块初始化时选驱动（无 indexedDB ⇒ 降级到 localStorage 兜底），
 * 桩装晚了就会选到别的驱动 ⇒ 落盘的数据读不到 ⇒ 判据失声。
 */
function installEnv() {
  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => lsData.get(k) ?? null,
    setItem: (k: string, v: string) => {
      lsData.set(k, String(v));
    },
    removeItem: (k: string) => {
      lsData.delete(k);
    },
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
        async get() {
          return {};
        },
        async set() {
          /* noop */
        },
        async remove() {
          /* noop */
        },
      },
    },
    notifications: {
      create() {
        return Promise.resolve('generated-id');
      },
    },
    action: {
      async setBadgeText() {
        /* noop */
      },
      async setBadgeBackgroundColor() {
        /* noop */
      },
      async setTitle() {
        /* noop */
      },
    },
    alarms: {
      create() {
        /* noop */
      },
      async clear() {
        return true;
      },
    },
    tabs: {
      async query() {
        return [];
      },
      async create() {
        return { id: 999 };
      },
      async remove() {
        /* noop */
      },
    },
  };

  return {
    /** 读出落盘的会话。 */
    readGroups: (): StoredGroup[] => {
      const raw = localStorageStub.getItem('tab_groups');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredGroup[]) : [];
    },
    /** 清空落盘数据（下一段用例从干净状态开始）。 */
    clearGroups: () => {
      lsData.delete('tab_groups');
    },
  };
}

const makeTab = (id: number, url: string) =>
  ({
    id,
    url,
    title: `Tab ${id}`,
    pinned: false,
    windowId: 42,
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

describe('保存路径的端到端命名：落盘的会话必须拿到规则算出来的名字', () => {
  const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

  it('同站 ⇒ 落盘的会话名**也是**保存时刻（不按内容猜）', async () => {
    const env = installEnv();
    const { tabManager } = await import('@/background/TabManager');

    const saved = await tabManager.saveAllTabs([
      makeTab(1, 'https://example.com/a'),
      makeTab(2, 'https://example.com/b'),
    ]);
    assert.ok(saved, '前置：这两个标签是可保存的 ⇒ 必须真的存成会话');

    const groups = env.readGroups();
    assert.equal(groups.length, 1, `前置：应当正好落盘 1 个会话（实际 ${groups.length}）`);
    assert.match(
      groups[0].name ?? '',
      TIMESTAMP_SHAPE,
      `同站保存出来的会话名不是保存时刻（实际 "${groups[0].name}"）—— ` +
        '保存路径给「全都来自同一个网站」开了后门，默认名必须一律是保存时刻'
    );
  });

  it('跨站 ⇒ 落盘的会话名也是保存时刻（形状 `YYYY-MM-DD HH:mm`）', async () => {
    const env = installEnv();
    const { tabManager } = await import('@/background/TabManager');

    const saved = await tabManager.saveAllTabs([
      makeTab(3, 'https://alpha.example.com/a'),
      makeTab(4, 'https://beta.example.com/b'),
    ]);
    assert.ok(saved, '前置：这两个标签是可保存的 ⇒ 必须真的存成会话');

    const groups = env.readGroups();
    assert.ok(groups.length >= 1, '前置：应当落盘了会话');
    const newest = groups[0];
    assert.match(
      newest.name ?? '',
      TIMESTAMP_SHAPE,
      `跨站保存出来的会话名不是保存时刻（实际 "${newest.name}"）—— ` +
        '保存路径没有按「默认名 = 保存时刻」命名'
    );
  });

  it('落盘的会话名与它自己的保存时刻**一致**（不许两个时钟打架）', async () => {
    const env = installEnv();
    const { tabManager } = await import('@/background/TabManager');

    const saved = await tabManager.saveAllTabs([makeTab(5, 'https://gamma.example.com/a')]);
    assert.ok(saved, '前置：这个标签是可保存的 ⇒ 必须真的存成会话');

    const groups = env.readGroups();
    const newest = groups[0];
    const createdAt = (newest as { createdAt?: string }).createdAt;
    assert.ok(createdAt, '前置：落盘的会话应当带 createdAt');
    // 用落盘的 createdAt 反推名字 ⇒ 两者必须对得上
    const expected = buildTimestampSessionName(createdAt);
    assert.equal(
      newest.name,
      expected,
      `落盘的名字（"${newest.name}"）与落盘的保存时刻（"${createdAt}" ⇒ "${expected}"）对不上`
    );
  });
});
