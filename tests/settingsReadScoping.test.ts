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

describe('settingsSlice 的 fail-closed 门禁必须覆盖 pending 窗口（2026-10-12 P0-2）', () => {
  it('读请求在途（pending）时拒绝写入，真实设置不被 DEFAULT_SETTINGS 覆盖', async () => {
    // 缺陷链（修复前）：标记是 boolean 且只在 catch 置位 ⇒ 冷启动那段时间它恒为 false
    //   t0 冷启动 → loadSettings 发出（IndexedDB 冷读 / 死句柄看门狗 5s）
    //   t1 用户点任意设置项 → reducer 改了 Redux（state 此刻是 DEFAULT_SETTINGS）
    //   t2 dispatchSaveSettings → 门禁判 false → 放行
    //   t3 storage.setSettings(DEFAULT_SETTINGS 全量) → 用户真实设置被整份覆盖
    // 这里不模拟 timing，而是直接验**不变量**：模块刚被 import、loadSettings 还没跑过时
    // （= pending 态），saveSettings 必须抛错，且一个字节都不许落到盘上。
    const { configureStore } = await import('@reduxjs/toolkit');
    const settingsSlice = await import('../src/store/slices/settingsSlice.ts');
    const settingsReducer = settingsSlice.default;

    // 先把「用户真实设置」写进盘上，随后 pending 态下的写入尝试必须不碰它。
    const real: Record<string, unknown> = {
      ...(await storage.getSettingsForLocalUse()),
      syncEnabled: true,
      syncIntervalMinutes: 60,
      themeStyle: 'claude',
    };
    await storage.setSettings(real as never);

    // 真实 store，settings 停在 initialState（即 DEFAULT_SETTINGS —— 冷启动时的真实状态）。
    // autoSyncMiddleware 不挂：它只在有 chrome.runtime 时才发消息，本用例不关心调度。
    const testStore = configureStore({ reducer: { settings: settingsReducer } });

    // 用户点开关：reducer 照常改 Redux（用户意图不丢，调用方会回滚 + toast），
    // 但真正落盘的那一步必须在 pending 态失败。
    testStore.dispatch({ type: 'settings/setSyncEnabled', payload: false });
    assert.equal(
      testStore.getState().settings.syncEnabled,
      false,
      '前置：reducer 应当已改 Redux（这正是 pending 窗口的真实形状）',
    );
    // dispatch(thunk) 永远 resolve（这正是 dispatchSaveSettings 存在的理由），
    // 所以断言走那个把失败原因交出来的 helper —— 与 6 个真实调用点同一条路径。
    const saveError = await settingsSlice.dispatchSaveSettings(
      testStore.dispatch as never,
    );
    assert.ok(
      saveError && /设置还在读取中|设置读取失败/.test(saveError),
      `❌ pending 态下 saveSettings 放行了（saveError=${String(saveError)}）—— ` +
        'DEFAULT_SETTINGS 会整份覆盖用户真实设置',
    );

    // 落盘内容必须原封不动
    const after = await storage.getSettingsForLocalUse();
    assert.equal(after.syncEnabled, true, '❌ 用户的自动同步开关被默认值覆盖了');
    assert.equal(after.syncIntervalMinutes, 60, '❌ 用户的同步档位被默认值覆盖了');
    assert.equal(after.themeStyle, 'claude', '❌ 用户的主题被默认值覆盖了');
  });

  it('读到真值（ok）后写入恢复正常（不得把闸门整个关死）', async () => {
    const { configureStore } = await import('@reduxjs/toolkit');
    const settingsSlice = await import('../src/store/slices/settingsSlice.ts');
    const settingsReducer = settingsSlice.default;
    await storage.setSettings({ ...(await storage.getSettingsForLocalUse()), syncEnabled: false } as never);

    const testStore = configureStore({ reducer: { settings: settingsReducer } });
    // 先跑一次 loadSettings 把标记推进到 ok（= 真实世界「已读到真值」）
    await testStore.dispatch(settingsSlice.loadSettings());
    assert.equal(
      testStore.getState().settings.syncEnabled,
      false,
      '前置：loadSettings 应把真实设置水合进 Redux',
    );

    testStore.dispatch({ type: 'settings/setSyncEnabled', payload: true });
    await testStore.dispatch(settingsSlice.saveSettings());
    const after = await storage.getSettingsForLocalUse();
    assert.equal(after.syncEnabled, true, 'ok 态下用户意图必须真的落盘');
  });
});
