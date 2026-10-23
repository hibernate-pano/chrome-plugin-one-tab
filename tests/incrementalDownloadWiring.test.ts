// 增量下载的**接线**守卫（2026-10-23，第 53 轮）。
//
// ── 这个文件在防什么 ───────────────────────────────────────────────────────
//
// 「少下载」这件事有两半：
//   ① 判据算得对（tests/cloudDelta.test.ts 钉住「合并结果逐字相同」）；
//   ② **真的走了那条路**（引擎确实只回源了变更的行，没顺手又拉一遍全量）。
//
// 本文件钉的是 ②。为什么它必须**行为级**地钉：
//   「源码里出现了 downloadGroupsByIds」是**零检测力**的断言 ——
//   把实参换成空数组、或者把调用挪进一个永远不走的分支，源码长相一点没变，
//   守卫照样绿。而这里防的恰恰是那种退化：**全量下载看起来还在跑，
//   于是出网量又回到 ∝ 库大小 ⇒ 配额又会被吃光 ⇒ 项目又被封**
//   （Supabase 的 egress 封禁是**项目级**的：连 /auth/v1/health 都返回 402）。
//
// ⇒ 所以断言钉的是「后端替身**实际收到**了哪些 id」与
//   「全量下载**一次都没被调用**」。
//
// ── 为什么还要一个「后端不支持增量」的反向用例 ───────────────────────────
// 端口上的 `downloadGroupsByIds` 是**可选能力**。不支持时必须**自动退回全量**
// 并让调用方知道「拿到的是完整集合，不是那几行」——
// 装配错一次（把完整集合当成只有那几行）⇒ 云端集合被削掉一大半
// ⇒ 合并把没变的会话判成「云端没有」⇒ **数据丢失**。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv, mkGroup } from './_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// ══════════════════════════════════════════════════════════════════════════
// 可编程的后端替身
// ══════════════════════════════════════════════════════════════════════════

interface CloudRow {
  id: string;
  name: string;
  updatedAt: string;
  version: number;
  isDeleted?: boolean;
  lastOp?: { d: string; s: number };
}

function makeBackend(opts: { rows: CloudRow[]; supportSelective?: boolean }) {
  const calls = {
    fetchFingerprints: 0,
    downloadGroups: 0,
    downloadGroupsByIds: [] as string[][],
  };

  const toGroup = (r: CloudRow) => ({
    ...mkGroup(r.id, {
      name: r.name,
      updatedAt: r.updatedAt,
      version: r.version,
      ...(r.isDeleted ? { isDeleted: true } : {}),
      ...(r.lastOp ? { lastOp: r.lastOp } : {}),
    }),
  });

  const backend: Record<string, unknown> = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      calls.fetchFingerprints += 1;
      // 指纹必须与内容**同源**（真实后端两者读的是同一份数据）——
      // 否则差量判据算出来的「云端有哪些行」与内容对不上号。
      return opts.rows.map(r => ({
        id: r.id,
        updatedAt: r.updatedAt,
        version: r.version,
        isDeleted: r.isDeleted === true,
        ...(r.lastOp ? { lastOp: r.lastOp } : {}),
      }));
    },
    async downloadGroups() {
      calls.downloadGroups += 1;
      return opts.rows.map(toGroup);
    },
    async uploadGroups(groups: Array<{ id: string }>) {
      return { writtenIds: groups.map(g => g.id), overwroteRemote: false };
    },
    async broadcastDeletes(ids: string[]) {
      return { broadcastIds: [...ids], blockedIds: [] };
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 本用例不关心设置 */
    },
    async downloadSettings() {
      return null;
    },
  };

  if (opts.supportSelective !== false) {
    backend.downloadGroupsByIds = async (ids: string[]) => {
      calls.downloadGroupsByIds.push([...ids]);
      const want = new Set(ids);
      return opts.rows.filter(r => want.has(r.id)).map(toGroup);
    };
  }

  return { backend, calls };
}

// ══════════════════════════════════════════════════════════════════════════
// 装置
// ══════════════════════════════════════════════════════════════════════════

const NOW = '2026-09-29T08:00:00.000Z';
const LATER = '2026-10-23T08:00:00.000Z';
/** 本机设备的印记。 */
const DEV_A = { d: 'dev-A', s: 1 };
/** 另一台设备的印记（严格更新 ⇒ 它写的内容会赢下合并）。 */
const DEV_B = { d: 'dev-B', s: 9 };

let current: ReturnType<typeof makeBackend>;

async function install(backend: unknown): Promise<void> {
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(backend as never);
}

const seedLocal = async (groups: Array<Record<string, unknown>>) => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate(groups as never);
  invalidateGroupsCache();
};

const localGroups = async (): Promise<Array<{ id: string; name: string }>> => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  return (await storage.getGroups()) as never;
};

before(async () => {
  register(LOADER_PATH);
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
  // 后端门禁：readConfiguredBackendId 读到 syncBackend='webdav' 才走自带存储路径；
  // 未设置时它回落成 'supabase' ⇒ reason='not_authenticated'（与被测缺陷无关）。
  const { kvSet } = await import('@/storage/storageAdapter');
  const { DEFAULT_SETTINGS } = await import('@/utils/storage');
  await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
});

after(async () => {
  const { resetActiveSyncBackend } = await import('@/sync-backend/index.ts');
  resetActiveSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { storage } = await import('@/utils/storage');
  await storage.clearPendingDeleteIds();
  await storage.setPendingUpload(false);
  // recent_upload_guard（35s 窗口）会把上一个用例的上传拦下 ⇒ 复位成远古时间。
  await storage.setLastUploadTime('2020-01-01T00:00:00.000Z');
});

// ══════════════════════════════════════════════════════════════════════════
// 一、增量路径真的被走到了
// ══════════════════════════════════════════════════════════════════════════

describe('增量下载：引擎只回源「变更的那几行」', () => {
  it('云端 3 组里只有 1 组变了 ⇒ 只回源那 1 组，且全量下载一次都没发生', async () => {
    // 本机 3 组，印记都是 DEV_A。
    await seedLocal([
      mkGroup('g-a', { lastOp: DEV_A, updatedAt: NOW }),
      mkGroup('g-b', { lastOp: DEV_A, updatedAt: NOW }),
      mkGroup('g-c', { lastOp: DEV_A, updatedAt: NOW }),
    ]);

    // 云端 3 组：g-b 被另一台设备改过（印记更大 ⇒ 会赢下合并）。
    current = makeBackend({
      rows: [
        { id: 'g-a', name: 'g-a', updatedAt: NOW, version: 1, lastOp: DEV_A },
        { id: 'g-b', name: '云端改过的 g-b', updatedAt: LATER, version: 2, lastOp: DEV_B },
        { id: 'g-c', name: 'g-c', updatedAt: NOW, version: 1, lastOp: DEV_A },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();

    assert.equal(res.success, true, `前提：这一轮必须成功（实得 reason: ${res.reason ?? '无'}）`);

    assert.equal(
      current.calls.downloadGroups,
      0,
      '全量下载一次都不能发生 —— 它会把整个库的加密 payload 再拉一遍，' +
        '出网量又回到 ∝ 库大小 ⇒ 配额必然被吃光 ⇒ 项目又被封'
    );
    assert.equal(current.calls.downloadGroupsByIds.length, 1, '应当只回源一次');
    assert.deepEqual(
      current.calls.downloadGroupsByIds[0],
      ['g-b'],
      '回源的必须**只有**变了的那一组（其余两组本地那份就能代表）'
    );
  });

  it('增量路径下，云端改过的那一组的新内容必须真的进到本机', async () => {
    await seedLocal([
      mkGroup('g-a', { lastOp: DEV_A, updatedAt: NOW }),
      mkGroup('g-b', { name: '本机旧名字', lastOp: DEV_A, updatedAt: NOW }),
    ]);

    current = makeBackend({
      rows: [
        { id: 'g-a', name: 'g-a', updatedAt: NOW, version: 1, lastOp: DEV_A },
        { id: 'g-b', name: '云端改过的名字', updatedAt: LATER, version: 2, lastOp: DEV_B },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();
    assert.equal(res.success, true, `前提：这一轮必须成功（实得 reason: ${res.reason ?? '无'}）`);

    const after = await localGroups();
    const b = after.find(g => g.id === 'g-b');
    assert.equal(
      b?.name,
      '云端改过的名字',
      '云端更新的那一组必须换成云端那份 —— ' +
        '「印记相同 ⇒ 本地赢」这条只在印记**相同**时成立；印记不同就必须回源取回云端那份'
    );
    assert.equal(after.length, 2, '没变的那一组不能因为「没回源」而消失');
  });

  it('云端多一组（别的设备新建）⇒ 那一组必须进到本机', async () => {
    await seedLocal([mkGroup('g-a', { lastOp: DEV_A, updatedAt: NOW })]);

    current = makeBackend({
      rows: [
        { id: 'g-a', name: 'g-a', updatedAt: NOW, version: 1, lastOp: DEV_A },
        { id: 'g-new', name: '别的设备建的', updatedAt: LATER, version: 1, lastOp: DEV_B },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();
    assert.equal(res.success, true, `前提：这一轮必须成功（实得 reason: ${res.reason ?? '无'}）`);

    const after = await localGroups();
    assert.ok(
      after.some(g => g.id === 'g-new'),
      '云端独有的组必须被下载进来 —— 它是「另一台设备新建的」那一类'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、反向：后端不支持增量 ⇒ 必须自动退回全量，且结果照样正确
// ══════════════════════════════════════════════════════════════════════════

describe('后端不支持增量下载时：自动退回全量，且结果不变', () => {
  it('退回全量 ⇒ 全量被调用一次，且云端那几组照样进来', async () => {
    await seedLocal([mkGroup('g-a', { lastOp: DEV_A, updatedAt: NOW })]);

    current = makeBackend({
      supportSelective: false,
      rows: [
        { id: 'g-a', name: 'g-a', updatedAt: NOW, version: 1, lastOp: DEV_A },
        { id: 'g-new', name: '别的设备建的', updatedAt: LATER, version: 1, lastOp: DEV_B },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();
    assert.equal(res.success, true, `前提：这一轮必须成功（实得 reason: ${res.reason ?? '无'}）`);

    assert.equal(current.calls.downloadGroups, 1, '不支持增量时必须退回全量');
    const after = await localGroups();
    assert.ok(
      after.some(g => g.id === 'g-new'),
      '退回全量时结果必须与增量路径一致 —— ' +
        '装配错一次（把完整集合当成只有那几行）就会把没变的会话判成「云端没有」'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、探活命中时：一个 payload 都不该下载
// ══════════════════════════════════════════════════════════════════════════

describe('探活命中：一次下载都不该发生', () => {
  it('云端与本机完全一致 ⇒ 全量与增量下载都没发生', async () => {
    await seedLocal([
      mkGroup('g-a', { lastOp: DEV_A, updatedAt: NOW }),
      mkGroup('g-b', { lastOp: DEV_A, updatedAt: NOW }),
    ]);

    current = makeBackend({
      rows: [
        { id: 'g-a', name: 'g-a', updatedAt: NOW, version: 1, lastOp: DEV_A },
        { id: 'g-b', name: 'g-b', updatedAt: NOW, version: 1, lastOp: DEV_A },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();

    assert.equal(res.success, true);
    assert.equal(res.upToDate, true, '探活应当命中（云端与本机逐字一致）');
    assert.equal(current.calls.downloadGroups, 0, '探活命中时全量下载不该发生');
    assert.equal(current.calls.downloadGroupsByIds.length, 0, '探活命中时连增量回源都不该发生');
  });
});
