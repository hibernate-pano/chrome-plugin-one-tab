// downloadAndMerge 的最后一条 fail-open：本地快照读失败不得变成一次写入。
//
// 链路（修复前）：
//   storage.getGroupsFresh() 抛错（一次 IndexedDB/存储读失败）
//   → try/catch 只 console.error，snapshot 停留在 []
//   → localGroups = snapshot = []
//   → mergeOpStamped([], cloud) ≈ cloud 本身
//   → validateMergeResult([], cloud, merged) 恒 valid（本地为空，基线为 0）
//   → storage.setGroupsImmediate(merged) 把本地整组会话换成云端快照
// 也就是说：一次读错误 + 一次自动同步 = 本地数据被静默改写。
// commit 66ed9fc 已经把「读失败降级成空数组」从 storage 层修掉，
// 但 syncEngine 这一层仍在把同一个错误吞成 []，是仅剩的读失败转写入的路径。
//
// 本文件钉死修复后的语义：本地快照读失败 → {success:false, reason:'snapshot_failed'}，
// 且在此之前不得发生任何网络请求与任何本地写入（setGroupsImmediate）。
import { describe, it, before } from 'node:test';
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

// 本文件会跑真实的 syncEngine（大量 console 输出：印记迁移、探活、失败堆栈）。
// 在 `node --test` 下，被测代码的原始 stdout 会与 test runner 自己的
// v8 序列化结果消息共用同一条 pipe；两者交错时父进程解析序列化帧会随机
// 报 "Unable to deserialize cloned data"（子进程全部断言其实都通过）。
// 故本文件静音 console；需要看日志时用 VERBOSE=1 跑。
if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const NOW = '2026-09-24T10:00:00.000Z';

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────────
// failReads 里的键：读它时抛错（模拟一次真实存储读失败）。
// 写操作全部记录到 writes，用于断言「读失败后没有任何落盘」。
const lsData = new Map<string, string>();
const writes: string[] = [];
let failReads = new Set<string>();

(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => {
      if (failReads.has(k)) throw new Error(`simulated read failure: ${k}`);
      return lsData.has(k) ? (lsData.get(k) as string) : null;
    },
    setItem: (k: string, v: string) => {
      lsData.set(k, String(v));
      writes.push(k);
    },
    removeItem: (k: string) => {
      lsData.delete(k);
    },
    clear: () => lsData.clear(),
  },
};

// supabase 的 session 读走 chrome.storage.local（扩展环境），所以 chrome 桩
// 必须是一个真的 Map 存储，而不是空壳。
const chromeData = new Map<string, unknown>();
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
        for (const [key, v] of Object.entries(obj)) chromeData.set(key, v);
      },
      remove: async (k: string) => {
        chromeData.delete(k);
      },
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

// supabase-js 也要一个未过期的假 session，否则 downloadTabGroups 直接报未登录
// （store 里的登录态只过了 authGuard 这一层）。
const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';

let fetchCalls = 0;
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname.endsWith('/auth/v1/user')) {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  fetchCalls += 1;
  // 云端为空
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

function makeGroup(id: string) {
  return {
    id,
    name: `group-${id}`,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

const LOCAL_GROUPS = [makeGroup('local-1'), makeGroup('local-2'), makeGroup('local-3')];

before(async () => {
  register(LOADER_PATH);
  lsData.set('tab_groups', JSON.stringify(LOCAL_GROUPS));
  lsData.set('storage_version', JSON.stringify(5));
  const session = JSON.stringify({
    access_token: 'stub-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'stub-refresh-token',
    user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' },
  });
  chromeData.set(SESSION_KEY, session);
  lsData.set(SESSION_KEY, session);

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  // 登录态直接置真：本用例要考的是快照读失败，不是 authGuard。
  store.dispatch(
    setFromCache({ user: { id: 'user-under-test' } as never, isAuthenticated: true })
  );
});

describe('downloadAndMerge fail-closed：本地快照读失败不得变成写入', () => {
  it('读失败 → 立即返回 snapshot_failed，且零网络请求、零落盘', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    fetchCalls = 0;
    writes.length = 0;
    failReads = new Set(['tab_groups']);
    let result: Awaited<ReturnType<typeof syncEngine.downloadAndMerge>>;
    try {
      result = await syncEngine.downloadAndMerge({ forceRemote: true });
    } finally {
      failReads = new Set();
    }

    assert.equal(result.success, false, '本地读失败时下载必须失败（修复前会成功并写回云端快照）');
    assert.equal(result.reason, 'snapshot_failed', '必须给出可辨识的失败原因');
    assert.deepEqual(result.groups, [], '失败时不得回吐任何（云端）数据');
    assert.equal(fetchCalls, 0, '本地快照都没读到就不该发起云端下载');
    assert.equal(
      writes.includes('tab_groups'),
      false,
      '读失败后一次 setGroupsImmediate 都不允许发生（修复前会把本地整组会话换成云端快照）'
    );

    // 落盘仍是原来三条
    const { storage } = await import('@/utils/storage');
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['local-1', 'local-2', 'local-3'],
      '本地会话列表未被改写'
    );
  });

  it('读失败后引擎不卡在 syncing（后续同步仍可进入）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    failReads = new Set(['tab_groups']);
    try {
      await syncEngine.downloadAndMerge({ forceRemote: true });
    } finally {
      failReads = new Set();
    }
    assert.equal(syncEngine.getIsSyncing(), false, '失败返回前必须复位 isSyncing');
  });

  it('读成功时对照组：仍走正常流程（证明上一条不是被环境整体短路）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();

    fetchCalls = 0;
    // 默认（非 forceRemote）路径：云端为空 → 合并结果应保留全部本地组
    const result = await syncEngine.downloadAndMerge();
    assert.equal(result.success, true, '读成功时下载必须成功');
    assert.ok(fetchCalls > 0, '读成功时必须真的发起云端下载');
    assert.deepEqual(
      result.groups.map(g => g.id).sort(),
      ['local-1', 'local-2', 'local-3'],
      '云端为空时本地组必须全部保留（本次不是「读失败被吞成空」的形状）'
    );
  });
});
