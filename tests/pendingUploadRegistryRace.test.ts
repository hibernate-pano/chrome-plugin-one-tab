// DS-43-19 的**运行时**回归（2026-10-23）：真 syncEngine + 真 storage + 假后端。
//
// 复现的现场（用户可见的症状）：
//   归属待决期（WebDAV 首次同步）⇒ 上传按「增量白名单」过滤 ⇒
//   用户保存会话 A ⇒ A 登记进白名单；
//   另一轮上传**正在进行**（它开始时读到的白名单快照里还没有 A）⇒
//   那轮上传看不到 A ⇒ 对账「对得上」⇒
//   旧实现**整表清**白名单 + 把 pending_upload 清成 false ⇒
//   ⇒ A 的登记被抹掉（或留下却没人再传）⇒ **A 永远不上云**，
//     而界面报「同步成功」。
//
// 断言的是**不变量**（不是实现长相）：
//   · 轮次期间才登记进来的 id 必须**活下来**（不被连坐清掉）；
//   · 「还有没传完的东西」必须仍然成立（待传标志保留）⇒ 下一轮会接着传；
//   · 界面不许说「同步成功」（结果必须带上「还没传完」这个事实）。
//
// 后端用**替身**注入（sync-backend 的 setActiveSyncBackend）：本文件考的是
// 引擎的「登记 ↔ 消费 ↔ 上报」时序，不该被真实云端的行为干扰。
// 替身里那道**闸门**（gate）就是用来制造「轮次期间」的：上传请求进来之后
// 阻塞在那儿，直到用例把登记放进去 —— 于是「登记落在轮次期间」这件事
// 是**真的发生了**，不是假想的。
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';
import type { SyncBackendPort } from '@/sync-backend/ports';
import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';
const LOCAL_DEVICE = 'devLocal';
const NOW = '2026-10-23T08:00:00.000Z';

// ── 本地存储桩（无 indexedDB 时 storageAdapter 回退到 localStorage）────────
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as any).window.localStorage;

const chromeData = new Map<string, unknown>();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of keys) if (chromeData.has(key)) out[chromeData.get(key) ? key : key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

function mkGroup(id: string, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `会话 ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: LOCAL_DEVICE, s: 2 },
    tabs: [
      { id: `${id}-t1`, url: `https://${id}.example.com/`, title: '标题', createdAt: NOW, lastAccessed: NOW, pinned: false },
    ],
    ...over,
  } as TabGroup;
}

/** 把本地 groups 写进 storage（30s 缓存必须先失效）。 */
async function seedLocal(groups: TabGroup[]) {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setGroupsImmediate(groups);
  invalidateGroupsCache();
}

before(async () => {
  register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(LOCAL_DEVICE));
  lsData.set('op_stamp_migrated', JSON.stringify(true));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
  lsData.set('user_settings', JSON.stringify({ syncBackend: 'webdav' }));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));
});

beforeEach(async () => {
  const { invalidateGroupsCache, storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setPendingUpload(false);
  await storage.clearPendingUploadGroupIds();
  await storage.setPendingUploadRegistryUnreliable(false);
  await storage.setFirstSyncPending(false);
  invalidateGroupsCache();
});

afterEach(async () => {
  const { resetActiveSyncBackend } = await import('@/sync-backend');
  resetActiveSyncBackend();
});

// ════════════════════════════════════════════════════════════════════

describe('DS-43-19：轮次期间才登记进来的改动不许被连坐清掉', () => {
  it('登记活下来 + 待传标志保留 + 结果必须带上「还没传完」这个事实', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');

    // ── 造一道闸门：上传请求进来后阻塞在那儿，直到用例把登记放进去 ──────
    let releaseUpload!: () => void;
    const gate = new Promise<void>(r => { releaseUpload = r; });
    let markEntered!: () => void;
    const entered = new Promise<void>(r => { markEntered = r; });

    const uploads: string[][] = [];
    const fake: SyncBackendPort = {
      id: 'webdav',
      label: '测试替身',
      async fetchFingerprints() { return []; },
      async downloadGroups() { return []; },
      async uploadGroups(groups) {
        uploads.push(groups.map(g => g.id));
        markEntered();
        await gate;
        return { writtenIds: groups.map(g => g.id) };
      },
      async broadcastDeletes(ids) { return { broadcastIds: [...ids], blockedIds: [] }; },
      async purgeExpiredDeletes() { return 0; },
      async uploadSettings() { /* 不考设置 */ },
      async downloadSettings() { return null; },
    };
    setActiveSyncBackend(fake);

    // 本机有一个会话；归属待决期（抑制全量）⇒ 上传按白名单过滤。
    await seedLocal([mkGroup('real-1')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1']);
    await storage.setPendingUpload(true);

    // 起一轮上传（**不 await**）：它会在闸门处停住。
    const round = syncEngine.upload({ syncSettings: false, forcePending: true });
    await entered;
    assert.deepEqual(uploads, [['real-1']], '这一轮只传白名单里的那个');

    // ── 轮次「进行中」：用户又改了一个会话，登记落盘 ──────────────────
    await storage.noteGroupsChanged(['late-1']);
    releaseUpload();

    const result = await round;

    // ① 晚到的登记**必须活下来**：旧实现（整表清）会把它抹掉。
    const whitelist = await storage.getPendingUploadGroupIds();
    assert.ok(
      whitelist.includes('late-1'),
      '轮次期间才登记进来的 id 必须留在待传队列里（整表清会把它连坐抹掉 ⇒ 改动永远不上云）'
    );

    // ② 「还有没传完的东西」必须仍然成立 ⇒ 下一轮会接着传。
    assert.equal(
      await storage.getPendingUpload(),
      true,
      '队列里还剩东西 ⇒ 待传标志必须保留（清掉就等于宣布「都传完了」）'
    );

    // ③ 界面不许说「同步成功」：结果必须带上「还没传完」这个事实。
    assert.equal(
      result.skippedGroups,
      1,
      '必须报出「还有 1 个会话没传完」（否则 SW 回包 ok=true ⇒ 界面弹「上传成功」）'
    );
    assert.match(
      String(result.error ?? ''),
      /本轮上传期间/,
      '必须有人话说明为什么这轮不算「全部同步」'
    );
    assert.doesNotMatch(
      String(result.error ?? ''),
      /同步成功|全部已同步/,
      '文案不许说「都同步了」'
    );
  });

  it('白名单按确认消费：只移除点名的那些，其余留下', async () => {
    const { storage } = await import('@/utils/storage');
    await storage.noteGroupsChanged(['a', 'b', 'c']);
    const remaining = await storage.consumePendingUploadGroupIds(['a', 'c']);
    assert.deepEqual(remaining, ['b'], '只移除点名的那些');
    assert.deepEqual(
      await storage.getPendingUploadGroupIds(),
      ['b'],
      '留在队列里的必须还在（晚到的登记不许被连坐清掉）'
    );
  });

  it('消费失败 ⇒ 按「还有东西没传完」处理（fail-closed）', async () => {
    const { decidePendingAfterRegistryConsume } = await import('@/core/uploadCoverage');
    assert.equal(
      decidePendingAfterRegistryConsume({ residualIds: [], consumeFailed: true }).keepPending,
      true,
      '消费失败 ⇒ 不知道白名单什么样 ⇒ 宁可多传一轮，也不许说「都传完了」'
    );
  });
});
