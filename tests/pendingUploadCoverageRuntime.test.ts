// D-3 的**运行时**回归（2026-10-20）：真 syncEngine + 真 storage + 假后端。
//
// 复现的现场（用户可见的症状）：
//   用户切到自带存储 → firstSyncPending=true（抑制全量）→
//   用户导入一份备份（20 个会话）→
//   增量白名单里装的是**备份文件里的 id**（落盘时 id 被 genId() 重新生成，
//   所以这些 id 在本机根本不存在）→
//   待决期的上传按白名单过滤 ⇒ 过滤结果恒为空 ⇒ 一个组都传不上去 →
//   而 pending_upload 与白名单**照样被清掉** ⇒
//   20 个导入的会话永远到不了云盘，alarm 与 60s 轮询也不再重试，界面毫无提示。
//
// 断言的是**不变量**：
//   · 「本轮一个都没传上去」⇒ pending_upload 必须保留；
//   · 结果必须如实带上「N 个会话尚未同步」；
//   · 正常路径（真的传上去了）不许被误伤（pending_upload 照旧被清）。
//
// 后端用**替身**注入（sync-backend 的 setActiveSyncBackend）：本文件考的是
// 引擎的「登记 ↔ 上行」对账与标志处置，不该被真实云端的行为干扰。
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
const NOW = '2026-10-20T08:00:00.000Z';

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
        for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
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

/** 记录上传批次的假后端（自带存储侧，id='webdav'）。 */
function makeFakeBackend() {
  const uploads: string[][] = [];
  const fake: SyncBackendPort = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups(groups) {
      uploads.push(groups.map(g => g.id));
      return { writtenIds: groups.map(g => g.id) };
    },
    async broadcastDeletes(ids) {
      /* 本文件不考删除广播 */
      return { broadcastIds: [...ids], blockedIds: [] };
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 不考设置 */
    },
    async downloadSettings() {
      return null;
    },
  };
  return { fake, uploads };
}

before(async () => {
  register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(LOCAL_DEVICE));
  lsData.set('op_stamp_migrated', JSON.stringify(true));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
  // 用户选的是自带存储 —— 归属待决期的抑制只对自带存储生效。
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

describe('D-3：白名单全是「不存在的 id」时，pending_upload 必须保留', () => {
  it('一个组都没传上去 ⇒ pending_upload 保留 + 如实报出「N 个会话尚未同步」', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // 本机有 20 个会话（导入后的真实 id）。
    await seedLocal(Array.from({ length: 20 }, (_, i) => mkGroup(`real-${i}`)));

    // 归属待决期（抑制全量）——白名单里装的是**备份文件里的 id**。
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(Array.from({ length: 20 }, (_, i) => `file-id-${i}`));
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    // 复现的现场：过滤结果恒为空 ⇒ 后端一次都没被叫到。
    assert.deepEqual(uploads, [], '白名单里的 id 都不存在 ⇒ 本轮不该上传任何会话');

    // 关键不变量：pending_upload **必须保留**（下一轮会重试）。
    assert.equal(
      await storage.getPendingUpload(),
      true,
      '本轮一个组都没传上去 ⇒ pending_upload 必须保留（修复前被无条件清掉 ⇒ 永不再重试）'
    );
    // 白名单也必须保留（否则下一轮连「该传什么」都不知道）。
    assert.equal(
      (await storage.getPendingUploadGroupIds()).length,
      20,
      '增量白名单必须保留'
    );
    // 必须如实报出未同步数量。
    assert.equal(result.skippedGroups, 20, '必须报出「20 个会话尚未同步」');
    assert.match(
      String(result.error ?? ''),
      /20 个会话尚未同步/,
      '错误文案必须说清楚有多少个会话没同步'
    );
  });

  it('正常路径（真的传上去了）不许被误伤：pending_upload 照旧被清', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    await seedLocal([mkGroup('real-1'), mkGroup('real-2')]);
    await storage.setFirstSyncPending(true);
    // 白名单里是**真实存在**的 id（写方登记对了）。
    await storage.noteGroupsChanged(['real-1', 'real-2']);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.deepEqual(uploads, [['real-1', 'real-2']], '登记对了就应当真的上传这两个');
    assert.equal(result.skippedGroups, undefined, '全部传上去了就不该报「未同步」');
    assert.equal(await storage.getPendingUpload(), false, '全部传上去了 ⇒ pending_upload 照旧被清');
    assert.deepEqual(await storage.getPendingUploadGroupIds(), [], '白名单照旧被清');
  });

  it('登记不可信（白名单写失败过）⇒ 不得清 pending_upload', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // ── 2026-10-20 D-10：这里的现场必须**真的存在一个漏登记的会话** ──────
    // 原来的现场只有一个会话、且它登记成功了 ⇒ 「漏登记」这件事**压根没发生**
    // （没有第二个会话被漏掉）⇒ 断言的前提是虚的。
    // 现场之所以要改，是因为判定「漏登记的那批补齐了没有」现在有了**可数的事实**：
    // 本轮提交出去的会话是否**覆盖了本机全部活跃会话**。
    //   · 覆盖了 ⇒ 漏登记的那批（若有）也在这份提交里 ⇒ 缺口关闭；
    //   · 没覆盖 ⇒ 还有会话没进本轮 ⇒ 缺口仍开着。
    // 下面这台机器上有**两个**会话，白名单里只有其中一个 ⇒ 另一个就是
    // 「登记失败时漏掉的那批」⇒ 缺口必然开着 ⇒ pending_upload 必须保留。
    await seedLocal([mkGroup('real-1'), mkGroup('missed-1')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1']);
    // 模拟「登记失败过」：上一次登记写盘失败，漏了哪些改动无从确认。
    await storage.setPendingUploadRegistryUnreliable(true);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(
      await storage.getPendingUpload(),
      true,
      '登记不可信 ⇒ 不能宣称「全部已同步」⇒ pending_upload 必须保留'
    );
    // 界面不许被骗：「没传上去的数量」是 0（登记集合对得上账），
    // 但「都传完了」这件事**证明不了** ⇒ 结果必须带上这个事实。
    assert.equal(
      result.cannotConfirmAllSynced,
      true,
      '「无法确认全部已同步」这个事实必须报给调用方（否则界面报「同步成功」）'
    );
    assert.match(
      String(result.error ?? ''),
      /无法确认/,
      '必须有人话说明为什么没法确认（用户要看得懂为什么卡住）'
    );
  });

  it('删除掉的会话不算「未同步」（它不该被上行，删除意图走另一条路）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // 本机还剩一个会话；另一个刚被删掉（白名单里仍有它的 id）。
    await seedLocal([mkGroup('real-1')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1', 'deleted-1']);
    await storage.addPendingDeleteId('deleted-1');
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.deepEqual(uploads, [['real-1']], '已删除的会话不该被上行');
    assert.equal(
      result.skippedGroups,
      undefined,
      '已删除并广播成功的会话不算「未同步」（否则用户会看到无意义的报错）'
    );
    assert.equal(await storage.getPendingUpload(), false, '该清的清干净了');
  });
});
