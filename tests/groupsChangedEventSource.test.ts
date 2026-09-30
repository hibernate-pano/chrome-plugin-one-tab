// 回归：groups 变化事件必须由**写入口**发出（事件源），否则管理页永不刷新。
//
// 真实 bug（2026-09-30 修 P0）：组数据早已迁到 IndexedDB（@/storage-kv/
// storageAdapter，db=tabvaultpro/store=kv/key=tab_groups），但 UI 唯一的刷新
// 信号 onGroupsChanged 一直只监听 chrome.storage.onChanged 的 tab_groups 键——
// 生产写路径一个字节都不写 chrome.storage.local，该事件永不触发。于是：
//   · SW 后台保存标签（TabManager）
//   · 云端下载合并（syncEngine）
//   · 导入 / 迁移
// 落盘之后，已打开的管理页列表永远不刷新，30s 缓存也不失效。
//
// 本文件锁两件事：
//   1. 行为：写入口（setGroupsImmediate / setGroups）落盘后，同进程订阅者被唤醒；
//      跨上下文（chrome.runtime 消息）也能唤醒，且收到广播不再转发（防消息风暴）。
//   2. 结构：storage.ts 里每一处 `kvSet(STORAGE_KEYS.GROUPS` 都必须在同一函数里
//      发出 notifyGroupsChanged()——新增写路径若忘了发事件，这里立刻红。
//      （旧实现只监听 chrome.storage.onChanged，任何「写完不发事件」的新路径
//      都能悄无声息地重现这个 bug，行为测试抓不到。）

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'node:module';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = new URL('./_alias-loader.mjs', `file://${TESTS_DIR}/`).href;
const PROJECT_ROOT = resolve(TESTS_DIR, '..');

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────────
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

// ── chrome 桩：记录 runtime.sendMessage 广播，收集 runtime.onMessage 监听器 ──
const sentMessages: Array<{ type?: string }> = [];
const runtimeMessageListeners: Array<(msg: { type?: string }) => void> = [];
const storageChangedListeners: Array<(...args: unknown[]) => void> = [];

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: {
      addListener: (fn: (...args: unknown[]) => void) => { storageChangedListeners.push(fn); },
      removeListener: () => undefined,
    },
  },
  runtime: {
    id: 'test-extension',
    getManifest: () => ({ version: 'test' }),
    sendMessage: (msg: { type?: string }) => { sentMessages.push(msg); return Promise.resolve({}); },
    onMessage: {
      addListener: (fn: (msg: { type?: string }) => void) => { runtimeMessageListeners.push(fn); },
      removeListener: () => undefined,
    },
  },
};

const NOW = '2026-09-30T00:00:00.000Z';

function group(id: string) {
  return {
    id, name: `g-${id}`,
    tabs: [{
      id: `${id}-t1`, url: `https://${id}.example.com`, title: id,
      createdAt: NOW, lastAccessed: NOW, pinned: false,
    }],
    createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1,
  } as any;
}

let storage: typeof import('../src/utils/storage.ts').storage;
let onGroupsChanged: typeof import('../src/utils/storage.ts').onGroupsChanged;
let invalidateGroupsCache: typeof import('../src/utils/storage.ts').invalidateGroupsCache;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ storage, onGroupsChanged, invalidateGroupsCache } = await import('../src/utils/storage.ts'));
});

describe('groups 变化事件：写入口发事件，同进程订阅者被唤醒', () => {
  it('setGroupsImmediate 落盘后触发订阅（SW 后台保存 / 云端合并走的就是它）', async () => {
    invalidateGroupsCache();
    let fired = 0;
    const off = onGroupsChanged(() => { fired += 1; });
    try {
      await storage.setGroupsImmediate([group('a')]);
      assert.equal(fired, 1, 'SW 直写 groups 后必须发出一次变化事件');
    } finally {
      off();
    }
  });

  it('setGroups 落盘后触发订阅（popup 侧防抖写路径）', async () => {
    invalidateGroupsCache();
    let fired = 0;
    const off = onGroupsChanged(() => { fired += 1; });
    try {
      // 500ms 防抖窗口：await 返回即已真正落盘
      await storage.setGroups([group('a'), group('b')]);
      assert.equal(fired, 1, '防抖写路径落盘后同样必须发出变化事件');
    } finally {
      off();
    }
  });

  it('事件到达时本进程 30s 缓存已失效：订阅方紧接着的读取能看到新数据', async () => {
    await storage.setGroupsImmediate([group('old')]);
    await storage.getGroups(); // 填充 30s 缓存（旧快照）

    let seen: string[] = [];
    const off = onGroupsChanged(() => { seen = []; void storage.getGroups().then(gs => { seen = gs.map(g => g.id); }); });
    try {
      await storage.setGroupsImmediate([group('old'), group('new')]);
      // getGroups 是异步的，等它落地
      await new Promise(r => setTimeout(r, 20));
      assert.deepEqual(seen, ['old', 'new'],
        '事件必须先失效 30s 缓存，否则订阅方刷新后仍读到旧列表');
    } finally {
      off();
    }
  });
});

describe('groups 变化事件：跨上下文广播', () => {
  it('写入口经 chrome.runtime.sendMessage 广播，别的扩展上下文能收到', async () => {
    invalidateGroupsCache();
    const off = onGroupsChanged(() => undefined);
    try {
      const before = sentMessages.length;
      await storage.setGroupsImmediate([group('x')]);
      const broadcasts = sentMessages.slice(before);
      assert.ok(broadcasts.length >= 1, 'SW 写完必须广播，否则 popup 进程收不到');
      assert.equal(broadcasts[broadcasts.length - 1].type, 'TABSTACK_GROUPS_CHANGED');
    } finally {
      off();
    }
  });

  it('收到广播只派发本地订阅者，不二次广播（否则 SW ↔ popup 无限消息风暴）', () => {
    let fired = 0;
    const off = onGroupsChanged(() => { fired += 1; });
    try {
      assert.ok(runtimeMessageListeners.length > 0, '订阅时必须注册 runtime.onMessage 监听');
      const before = sentMessages.length;
      for (const listener of runtimeMessageListeners) {
        listener({ type: 'TABSTACK_GROUPS_CHANGED' });
      }
      assert.equal(fired, 1, '一条广播唤醒一次订阅者');
      assert.equal(sentMessages.length, before, '收到广播不得再次 sendMessage（防消息风暴）');
    } finally {
      off();
    }
  });

  it('不订阅时不会为写方注册 runtime 监听（写方不该为它付出唤醒代价）', () => {
    const before = runtimeMessageListeners.length;
    // 直接调写路径（无订阅者）：不得新增 runtime.onMessage 监听
    void storage.setGroupsImmediate([group('y')]);
    assert.equal(runtimeMessageListeners.length, before);
  });
});

describe('结构守卫：每一个 groups 写入口都必须发事件', () => {
  const storageSource = readFileSync(
    resolve(PROJECT_ROOT, 'src/utils/storage.ts'),
    'utf8'
  );
  const lines = storageSource.split('\n');

  it('storage.ts 中每个 kvSet(STORAGE_KEYS.GROUPS 之后都跟 notifyGroupsChanged()', () => {
    const writeSites: number[] = [];
    lines.forEach((line, i) => {
      if (/kvSet\(\s*STORAGE_KEYS\.GROUPS\s*,/.test(line)) writeSites.push(i);
    });
    assert.ok(writeSites.length >= 2,
      `预期至少两个 groups 写入口（防抖 + 直写），实际找到 ${writeSites.length}`);

    for (const i of writeSites) {
      const window = lines.slice(i, i + 12).join('\n');
      assert.match(window, /notifyGroupsChanged\(\)/,
        `第 ${i + 1} 行的 groups 写入没有发出变化事件 —— 新增写路径若漏发，`
        + '管理页就会重现「后台保存/云端合并后不刷新」');
    }
  });

  it('onGroupsChanged 不再依赖 chrome.storage.onChanged（组数据不在 chrome.storage 里）', () => {
    const start = storageSource.indexOf('export function onGroupsChanged');
    assert.ok(start > 0, 'onGroupsChanged 应仍然导出');
    const body = storageSource.slice(start, storageSource.indexOf('\n}', start) + 2);
    assert.doesNotMatch(body, /storage\.onChanged/,
      'onGroupsChanged 不得再监听 chrome.storage.onChanged：'
      + '生产写路径写的是 IndexedDB，该事件永不触发，且 migrateStorageKeys 的残留写入会伪造刷新');
  });

  it('storage-kv/groupsChangedBus 是唯一的事件源，且存在被 storage.ts 引用', () => {
    const busPath = resolve(PROJECT_ROOT, 'src/storage-kv/groupsChangedBus.ts');
    const bus = readFileSync(busPath, 'utf8');
    assert.match(bus, /export function notifyGroupsChanged/);
    assert.match(bus, /export function subscribeGroupsChanged/);
    assert.match(storageSource, /from '@\/storage-kv\/groupsChangedBus'/);
  });
});
