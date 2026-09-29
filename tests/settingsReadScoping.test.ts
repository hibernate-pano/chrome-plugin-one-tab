// 回归：设置读取的 fail-closed 只能约束上云路径，不能打死本地保存。
//
// 背景：v1.22.0 的删除模型重写顺带把 storage.getSettings() 改成了 fail-closed
// （读失败抛错，不再降级返回 DEFAULT_SETTINGS）。这个方向是对的——
// uploadSettings 是无 stamp / 无 version / 无 LWW 的无条件 upsert，
// 把降级值当真值推上去会覆盖用户真实的云端设置。
//
// 但同一个 getter 被纯本地路径调用了：TabManager.saveAllTabs / saveCurrentTab
// 读 collectPinnedTabs 来决定要不要一并保存固定标签页。那只是一次本地行为开关，
// 永远不会上传。一次瞬时的 IndexedDB 读错误，却会让「保存全部标签 / 保存当前标签」
// 整条中止（saveAllTabs 走 catch 弹「保存标签页时发生错误，请重试」，
// saveCurrentTab 直接 rethrow）。为一个只影响云端的隐患赔上本地保存功能，不成比例。
//
// 修法按「结果会不会被上传」分流：
//   会 → getSettings（抛错，fail-closed）
//   不会 → getSettingsForLocalUse（降级为 DEFAULT_SETTINGS，且该值不参与任何上传）
// 本用例锁住这个分流，以及「本地降级不会污染云端」这条边界。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────────
const lsData = new Map<string, string>();
// 桩先起成具名常量再挂到 globalThis：否则要回读 window.localStorage 就得再断一次
// （globalThis 被断言成 Record<string, unknown>，属性取出来是 unknown）。
const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

let storage: typeof import('../src/utils/storage.ts').storage;
let invalidateGroupsCache: typeof import('../src/utils/storage.ts').invalidateGroupsCache;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage, invalidateGroupsCache } = await import('../src/utils/storage.ts'));
});

beforeEach(() => {
  invalidateGroupsCache();
});

/** 让 kvGet 在读 settings 时抛错——模拟一次瞬时 IndexedDB 读错误。 */
function breakSettingsReads(): void {
  const settingsKey = 'user_settings';
  const original = (globalThis as Record<string, unknown>).localStorage as {
    getItem(k: string): string | null;
  };
  original.getItem = (k: string) => {
    if (k === settingsKey) throw new Error('IndexedDB 瞬时读错误');
    return null;
  };
}

function restoreSettingsReads(): void {
  const lsData2 = new Map<string, string>();
  const original = (globalThis as Record<string, unknown>).localStorage as {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
  };
  original.getItem = (k: string) => (lsData2.has(k) ? (lsData2.get(k) as string) : null);
  original.setItem = (k: string, v: string) => { lsData2.set(k, String(v)); };
}

describe('getSettings 的 fail-closed 只约束上云路径', () => {
  it('getSettings 读失败时抛错（守住了不把降级值推上云端这条线）', async () => {
    breakSettingsReads();
    try {
      await assert.rejects(
        () => storage.getSettings(),
        /IndexedDB 瞬时读错误/,
        'getSettings 必须 fail-closed：uploadSettings 是无条件 upsert，降级值会被当真值写上云端',
      );
    } finally {
      restoreSettingsReads();
    }
  });

  it('getSettingsForLocalUse 读失败时降级为默认值，不抛错（本地保存路径不被拖死）', async () => {
    breakSettingsReads();
    try {
      const settings = await storage.getSettingsForLocalUse();
      assert.equal(typeof settings, 'object');
      // 降级值必须是一份**完整可用**的设置对象：collectPinnedTabs 有明确取值 false，
      // 这样 TabManager 的 `settings.collectPinnedTabs ?? false` 不会拿到 undefined。
      assert.equal(settings.collectPinnedTabs, false);
      assert.notEqual(settings, undefined);
    } finally {
      restoreSettingsReads();
    }
  });

  it('getSettingsForLocalUse 读成功时返回真实设置，不被降级路径污染', async () => {
    await storage.setSettings({ collectPinnedTabs: true } as never);
    const settings = await storage.getSettingsForLocalUse();
    assert.equal(settings.collectPinnedTabs, true);
  });
});
