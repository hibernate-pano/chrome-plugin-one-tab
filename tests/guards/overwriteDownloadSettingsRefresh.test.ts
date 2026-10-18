// 覆盖下载后必须重读设置（2026-10-18 round 6）。
//
// 【本文件要防的回归类别】「覆盖模式下载」（forceRemote + syncSettings）在 **SW** 里
// 把云端设置合并进存储（syncEngine.mergeCloudSettingsIntoLocal）。而 popup / options
// 是两个独立执行上下文，各自持有一份 60s 的 settings 缓存与一份 Redux settings
// state —— 它们不会因为 SW 的那次写入而失效。后果有两层，第二层才是贵的那个：
//   ① 界面继续显示旧主题 / 旧布局，用户以为「以云端为准」没生效；
//   ② `saveSettings` 是**整份 state 盲写**（不是读-改-写）：用户接下来随便改一项设置
//      （连点几下主题都会）就把这份旧设置整份写回存储，并随自动上传推到云端 ——
//      刚从云端落下来的那批值被静默回滚，其它设备下次下载再复制一遍。
// 修法：覆盖下载成功后，本上下文「先失效设置缓存、再 loadSettings 重读」，
// 两个入口（popup 同步按钮 / 设置页「以云端为准」）同一口径。
//
// 覆盖面：
//   (a) 运行时：dispatchReloadSettings 真的能越过陈旧缓存读到新值（真跑代码）；
//   (b) 结构：两个入口都接上了这条重读，且只有带 syncSettings 的那两个动作接。

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 无 indexedDB 环境下的存储桩（与 settingsReadScoping 同一套）────────────
const lsData = new Map<string, string>();
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
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

describe('覆盖下载后重读设置：越过陈旧缓存', () => {
  let storage: typeof import('../../src/utils/storage.ts').storage;
  let slice: typeof import('../../src/store/slices/settingsSlice.ts');
  let configureStore: typeof import('@reduxjs/toolkit').configureStore;

  before(async () => {
    register(LOADER_PATH, import.meta.url);
    ({ storage } = await import('../../src/utils/storage.ts'));
    slice = await import('../../src/store/slices/settingsSlice.ts');
    ({ configureStore } = await import('@reduxjs/toolkit'));
  });

  beforeEach(() => {
    lsData.clear();
  });

  it('绕过缓存读到「另一个执行上下文」写进存储的新值', async () => {
    const stale: Record<string, unknown> = {
      ...(await storage.getSettingsForLocalUse()),
      themeStyle: 'legacy',
      layoutMode: 'single',
      syncIntervalMinutes: 5,
    };
    await storage.setSettings(stale as never);
    // 前置：本上下文缓存已被填上旧值（60s TTL）
    await storage.getSettings();

    // 模拟 SW 的 mergeCloudSettingsIntoLocal：直接改存储，不碰本上下文的缓存。
    localStorageStub.setItem(
      'user_settings',
      JSON.stringify({ ...stale, themeStyle: 'claude', layoutMode: 'double', syncIntervalMinutes: 30 }),
    );

    assert.equal(
      (await storage.getSettings()).themeStyle,
      'legacy',
      '前置：缓存未过期时普通读取本就该返回旧值 —— 这正是缺陷窗口的形状',
    );

    const store = configureStore({ reducer: { settings: slice.default } });
    const reloadError = await slice.dispatchReloadSettings(store.dispatch as never);
    assert.equal(reloadError, null, `重读应当成功，实到：${String(reloadError)}`);

    const state = store.getState().settings as unknown as Record<string, unknown>;
    assert.equal(state.themeStyle, 'claude', 'Redux 必须换成存储里的新值');
    assert.equal(state.layoutMode, 'double', '其余被云端改过的字段同样要换新');
    assert.equal(state.syncIntervalMinutes, 30, '数值型字段也要跟上，否则下次盲写会把旧值推回云端');
    assert.equal(
      (await storage.getSettings()).themeStyle,
      'claude',
      '缓存必须被刷新：否则下一次读又拿回旧值（等于没修）',
    );
  });

  it('读失败时如实回报原因（不是静默成功）', async () => {
    await storage.setSettings({ ...(await storage.getSettingsForLocalUse()) } as never);
    const store = configureStore({ reducer: { settings: slice.default } });
    const original = localStorageStub.getItem;
    localStorageStub.getItem = (k: string) => {
      if (k === 'user_settings') throw new Error('IndexedDB 瞬时读错误');
      return original.call(localStorageStub, k);
    };
    try {
      const reloadError = await slice.dispatchReloadSettings(store.dispatch as never);
      assert.ok(reloadError, '读失败必须把原因交出来 —— 静默返回 null 就是谎报重读成功');
    } finally {
      localStorageStub.getItem = original;
    }
  });
});

describe('两个入口都接上重读，且只有带 syncSettings 的动作接', () => {
  it('syncEngine 的覆盖下载确实会合并云端设置（前提断言）', () => {
    const src = code('src/services/syncEngine.ts');
    assert.match(
      src,
      /opts\?\.forceRemote && opts\?\.syncSettings/,
      '前提变了：forceRemote+syncSettings 才合并云端设置，本组断言的接线点据此判定',
    );
    assert.match(src, /mergeCloudSettingsIntoLocal\(\)/, '前提变了：没有这步就无需重读');
  });

  it('popup 同步按钮：download.overwrite 声明 refreshSettings，且成功后真的重读', () => {
    const src = code('src/components/sync/SyncButton.tsx');
    const specStart = src.indexOf("'download.overwrite':");
    assert.ok(specStart !== -1, '找不到 download.overwrite 动作定义');
    const spec = src.slice(specStart, src.indexOf("'download.merge':", specStart));
    assert.match(spec, /refreshSettings:\s*true/, 'download.overwrite 必须声明重读设置');

    const mergeStart = src.indexOf("'download.merge':", specStart);
    const mergeSpec = src.slice(mergeStart, src.indexOf('} as const;', mergeStart));
    assert.match(
      mergeSpec,
      /refreshSettings:\s*false/,
      'download.merge 不带 syncSettings ⇒ 不该重读（多一次整表读，且掩盖真实差异）',
    );

    const okAt = src.indexOf('if (res.ok) {');
    const gateAt = src.indexOf('if (spec.refreshSettings) {', okAt);
    const callAt = src.indexOf('dispatchReloadSettings(dispatch)', okAt);
    assert.ok(gateAt !== -1, 'runSyncAction 必须按 spec.refreshSettings 分流');
    assert.ok(callAt !== -1, '成功后必须真的调用 dispatchReloadSettings');
    assert.ok(okAt < gateAt && gateAt < callAt, '重读只能发生在 res.ok 之后');
  });

  it('设置页「以云端为准」也重读（否则本页手里的旧值会整份写回）', () => {
    const src = code('src/components/sync/WebDavSettings.tsx');
    const head = src.indexOf("if (choice === 'cloud-wins') {");
    assert.ok(head !== -1, '找不到「以云端为准」分支');
    const branch = src.slice(head, src.indexOf('\n        }', head));
    assert.match(
      branch,
      /sendSyncCommand\('download',\s*\{\s*forceRemote:\s*true,\s*syncSettings:\s*true\s*\}\)/,
      '前提：这一支走的是带 syncSettings 的覆盖下载',
    );
    assert.match(branch, /dispatchReloadSettings\(dispatch\)/, '同一条命令在两个入口必须同一口径');
  });

  it('重读助手固定「先失效缓存、再读」的顺序', () => {
    const src = code('src/store/slices/settingsSlice.ts');
    const start = src.indexOf('export async function dispatchReloadSettings(');
    assert.ok(start !== -1, '找不到 dispatchReloadSettings');
    const body = src.slice(start, src.indexOf('\n}', start));
    const invalidateAt = body.indexOf('invalidateSettingsCache()');
    const loadAt = body.indexOf('dispatch(loadSettings())');
    assert.ok(invalidateAt !== -1, '必须先失效设置缓存 —— 否则 60s 内读回旧值（等于没修）');
    assert.ok(loadAt !== -1 && invalidateAt < loadAt, '顺序即语义：先失效，再读');
  });
});
