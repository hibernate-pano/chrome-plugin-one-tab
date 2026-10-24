/**
 * GAP1-1：设置必须**按字段**落盘，且跨 realm 有失效通道（2026-10-24 审计）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 设置写方在**多个执行上下文**里（管理页标签、设置页标签、MV3 SW），每个 realm
 * 各持一份**挂载时的快照**。修复前落盘是**整份盲写**：
 * `storage.setSettings(本 realm 的整份快照)`。
 *
 * ⇒ 任何一个 realm 动一下开关，就把**整份**旧快照写回去，把别的 realm 刚写的
 * 值静默盖掉。真机可复现的两个方向：
 *
 *   · 设置页把后端切成「自带存储（WebDAV）」⇒ 管理页点一次「切换到深色主题」
 *     ⇒ 磁盘上的 `syncBackend` 被静默改回 `supabase`，界面**仍显示** WebDAV 选中
 *     ⇒ 而真正决定同步去向的 `sync-backend/index.ts` 直读磁盘
 *     ⇒ **界面显示 WebDAV、实际同步打向 TapStack 云端**，WebDAV 用户的同步静默失效；
 *   · 设置页挂着一个旧快照，用户随便拨一下「显示网站图标」⇒ 磁盘上刚被管理页
 *     改成深色的 `themeMode` 回到浅色，零提示。
 *
 * ── 为什么不能靠「和本 realm 的挂载快照比一比」────────────────────────────
 *
 * 挂载快照也会过期（别的 realm 改了磁盘而本 realm 还没收到失效通知）。
 * 用户在界面上点选的那个值**恰好等于旧快照里的值**时，「相对快照没变」
 * ⇒ 这个字段**不写** ⇒ 用户明明点了「切回 TapStack 云端」，磁盘却还是 WebDAV
 * ⇒ **静默无效的操作**，而且比盲写更难察觉（界面显示的就是他点的那一项）。
 *
 * ⇒ 意图表记的是**动作**（用户点了什么），不是**快照的差异**。
 *
 * ── 钉的是行为，不是字面量 ───────────────────────────────────────────────
 *
 * 本文件用**两个 store（两个 realm）共享一份磁盘**来演这件事，断言的都是
 * 磁盘上的事实：
 *   ① B 的写**不覆盖** A 刚写的字段；
 *   ② B 的**显式选择**一定写得下去（哪怕它恰好等于 B 界面上的旧值）；
 *   ③ 别的 realm 改了设置 ⇒ 本 realm 的状态会被刷新（失效通道真的通）。
 *
 * ── 自证检测力（改坏实现 ⇒ 对应用例变红）────────────────────────────────
 *
 *   M1 落盘改回「整份盲写」（写本 realm 的整份 state）⇒ ① 变红
 *   M2 落盘改成「磁盘真值 + 相对挂载快照的差值」⇒ ② 变红
 *   M3 落盘改成「磁盘真值 + 相对磁盘的差值」⇒ ① 变红
 *   M4 失效通道断掉（store 不订阅总线）⇒ ③ 变红
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { installKvEnv } from '../_helpers/kvEnv.ts';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

/** 让异步链（重读设置等）走完几个宏任务。 */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise(r => setTimeout(r, 0));
  }
}

describe('GAP1-1：设置按字段落盘（两个 realm 共享一份磁盘）', () => {
  let kv: ReturnType<typeof installKvEnv>;
  let chromeData: Map<string, unknown>;
  let sentMessages: Array<{ type?: string; originId?: string }>;

  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(() => {
    kv = installKvEnv();
    kv.reset();
    chromeData = new Map<string, unknown>();
    sentMessages = [];
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
          },
          remove: async (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) chromeData.delete(key);
          },
          clear: async () => {
            chromeData.clear();
          },
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      runtime: {
        getManifest: () => ({ version: 'test' }),
        sendMessage: async (msg: { type?: string; originId?: string }) => {
          sentMessages.push(msg);
        },
        onMessage: { addListener: () => undefined, removeListener: () => undefined },
      },
    };
  });

  it('① B 的写不覆盖 A 刚写的字段（盲写会把它盖回去）', async () => {
    const { createStore } = await import('@/store');
    const { dispatchSaveSettings, loadSettings, updateSettings } = await import(
      '@/store/slices/settingsSlice'
    );
    const { storage } = await import('@/utils/storage');
    const { __resetSettingsChangedBusForTests } = await import(
      '@/storage-kv/settingsChangedBus'
    );

    // 两个 realm（两个执行上下文各有一份 store），共享同一份磁盘。
    const realmA = createStore();
    const realmB = createStore();

    // 两个 realm 都在「改动发生之前」读过一次设置 ⇒ 两份快照都是旧的。
    await realmA.dispatch(loadSettings());
    await realmB.dispatch(loadSettings());

    // ── 建模「失效通知没送达」────────────────────────────────────────────
    // 正常情况下，A 写完会广播，B 的 store 收到后重读 ⇒ B 不再是旧快照。
    // 但通知是**尽力而为**的（IndexedDB 没有变更通知，跨上下文只有 runtime
    // 消息这一条通道，消息可能丢、SW 可能正在休眠）⇒ B 仍可能拿着旧快照
    // 面对用户的一次点击。
    // ⇒ 这里把总线上的订阅者清掉，等价于「通知丢了」。
    // 这正是写路径必须**按字段**落盘的原因：写路径的正确性**不能**依赖
    // 「对方一定刷新过」。
    __resetSettingsChangedBusForTests();

    // realm A 改主题并保存。
    realmA.dispatch(updateSettings({ themeMode: 'dark' }));
    assert.equal(await dispatchSaveSettings(realmA.dispatch), null, 'realm A 的保存必须成功');

    const afterA = await storage.getSettingsForWrite();
    assert.equal(afterA.themeMode, 'dark', '前提：realm A 的改动真的落盘了');

    // realm B 改**另一个**字段并保存（它的快照里 themeMode 仍是 light）。
    realmB.dispatch(updateSettings({ showFavicons: true }));
    assert.equal(await dispatchSaveSettings(realmB.dispatch), null, 'realm B 的保存必须成功');

    const afterB = await storage.getSettingsForWrite();
    assert.equal(
      afterB.showFavicons,
      true,
      'realm B 自己的改动必须落盘'
    );
    assert.equal(
      afterB.themeMode,
      'dark',
      'realm B 的写**不许**把 realm A 刚写的字段盖回旧值 —— 这就是整份盲写的老毛病：' +
        'B 手里那份 60s 前的快照会连 themeMode 一起写回去'
    );
  });

  it('② B 的显式选择一定写下去（哪怕它恰好等于 B 界面上的旧值）', async () => {
    const { createStore } = await import('@/store');
    const { dispatchSaveSettings, loadSettings, updateSettings } = await import(
      '@/store/slices/settingsSlice'
    );
    const { storage } = await import('@/utils/storage');
    const { __resetSettingsChangedBusForTests } = await import(
      '@/storage-kv/settingsChangedBus'
    );

    const realmA = createStore();
    const realmB = createStore();
    await realmA.dispatch(loadSettings());
    await realmB.dispatch(loadSettings());
    // 同 ①：建模「B 没收到失效通知」⇒ B 的界面还显示着旧的后端。
    __resetSettingsChangedBusForTests();

    // realm A 把后端切成「自带存储（WebDAV）」。
    realmA.dispatch(updateSettings({ syncBackend: 'webdav' }));
    assert.equal(await dispatchSaveSettings(realmA.dispatch), null);
    const afterA = await storage.getSettingsForWrite();
    assert.equal(
      afterA.syncBackend,
      'webdav',
      '前提：realm A 真的把后端切到了自带存储'
    );

    // realm B 的界面还显示着旧的「TapStack 云端」（它没收到失效通知）。
    // 用户在 B 里**明确**点了「TapStack 云端」—— 也就是他看到的那一项。
    // ⇒ 这是一次明确的「我要切回云端」，必须写下去。
    realmB.dispatch(updateSettings({ syncBackend: 'supabase' }));
    assert.equal(await dispatchSaveSettings(realmB.dispatch), null);

    const afterB = await storage.getSettingsForWrite();
    assert.equal(
      afterB.syncBackend,
      'supabase',
      '用户点过的值必须写下去 —— 若用「相对本 realm 挂载快照的差值」当判据，' +
        '这一项恰好与旧快照相同 ⇒ 被当成「用户没改」⇒ 不写 ⇒ 用户的操作静默无效'
    );
  });

  it('③ 别的 realm 改了设置 ⇒ 本 realm 的状态被刷新（失效通道真的通）', async () => {
    const { createStore } = await import('@/store');
    const { dispatchSaveSettings, loadSettings, updateSettings } = await import(
      '@/store/slices/settingsSlice'
    );

    const realmA = createStore();
    const realmB = createStore();
    await realmA.dispatch(loadSettings());
    await realmB.dispatch(loadSettings());

    assert.equal(
      realmB.getState().settings.syncBackend,
      'supabase',
      '前提：realm B 现在的快照是旧的'
    );

    realmA.dispatch(updateSettings({ syncBackend: 'webdav' }));
    assert.equal(await dispatchSaveSettings(realmA.dispatch), null);

    await settle();

    assert.equal(
      realmB.getState().settings.syncBackend,
      'webdav',
      'realm B 必须被刷新 —— 设置落在 IndexedDB，chrome.storage.onChanged 根本不触发，' +
        '没有自建的失效通道时，B 会一直显示旧后端（用户以为自己没切成功）'
    );
    assert.ok(
      sentMessages.some(m => m.type === 'TABSTACK_SETTINGS_CHANGED'),
      '写方必须广播「设置变了」—— 跨执行上下文只有 runtime 消息这一条通道'
    );
  });
});

describe('GAP1-1：存储层的两处读必须是真值（不是 60s 缓存）', () => {
  let kv: ReturnType<typeof installKvEnv>;
  let chromeData: Map<string, unknown>;

  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(() => {
    kv = installKvEnv();
    kv.reset();
    chromeData = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
          },
          remove: async (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) chromeData.delete(key);
          },
          clear: async () => {
            chromeData.clear();
          },
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      // 刻意**不提供** runtime.sendMessage：storage 的导入路径靠它判断
      // 「有没有 SW」（hasMutationSender）⇒ 没有它就走本地直写那条兜底路，
      // 而不需要一个会回话的假 SW。
      runtime: {
        getManifest: () => ({ version: 'test' }),
        onMessage: { addListener: () => undefined, removeListener: () => undefined },
      },
    };
  });

  it('导出备份里的设置是磁盘真值（不是 60s 缓存里的旧值）', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');

    // 先让 60s 缓存里装进一份旧值。
    const before = await storage.getSettings();
    const oldTheme = before.themeMode;

    // 模拟「别的 realm 改了磁盘」（绕过本进程的缓存与写入口）。
    const onDisk = { ...before, themeMode: oldTheme === 'dark' ? 'light' : 'dark' };
    await kvSet(STORAGE_KEYS.SETTINGS, onDisk);

    const exported = await storage.exportData();
    assert.equal(
      exported.data.settings?.themeMode,
      onDisk.themeMode,
      '备份必须导出磁盘真值 —— 拿缓存里的旧值导出，用户会得到一份「恢复到旧状态」的备份'
    );
    assert.notEqual(
      exported.data.settings?.themeMode,
      oldTheme,
      '前提：磁盘上的值确实与缓存里的旧值不同（否则这条断言没有检测力）'
    );
  });

  it('导入时合并的底是磁盘真值（不会把别的 realm 刚改的设置退回旧值）', async () => {
    const { storage } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    const { STORAGE_KEYS } = await import('@/storage-kv/keys');

    const before = await storage.getSettings();
    const onDiskTheme = before.themeMode === 'dark' ? 'light' : 'dark';
    await kvSet(STORAGE_KEYS.SETTINGS, { ...before, themeMode: onDiskTheme });

    const result = await storage.importDetailed({
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: {
        groups: [
          {
            id: 'g-1',
            name: '会话 1',
            tabs: [{ url: 'https://example.com/', title: '例子' }],
            createdAt: '2026-10-24T00:00:00.000Z',
            updatedAt: '2026-10-24T00:00:00.000Z',
            isLocked: false,
          },
        ],
        settings: { themeStyle: 'claude' },
      },
    } as never);
    assert.equal(result.ok, true, `导入必须成功：${JSON.stringify(result)}`);

    const after = await storage.getSettingsForWrite();
    assert.equal(after.themeStyle, 'claude', '备份里的设置必须被合并进来');
    assert.equal(
      after.themeMode,
      onDiskTheme,
      '备份里没有的字段必须保住磁盘上的真值 —— 拿缓存里的旧值当底，' +
        '会把别的 realm 刚改的设置静默退回旧值'
    );
  });
});
