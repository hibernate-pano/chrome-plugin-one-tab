// downloadAndMerge 的最后一条 fail-open：本地快照读失败不得变成一次写入。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身把整份 tests/syncEngineFailClosed.test.ts
// 删除。审计用变异证明：把 syncEngine.downloadAndMerge 里快照读失败的
// `return { success:false, groups:[], reason:'snapshot_failed' }`
// 换成 `snapshot = []`（fail-open），全量 1046 个测试依旧全绿。
//
// 链路（修复前）：
//   storage.getGroupsFresh() 抛错（一次 IndexedDB/存储读失败）
//   → try/catch 只 console.error，snapshot 停留在 []
//   → localGroups = snapshot = []
//   → mergeOpStamped([], cloud) ≈ cloud 本身
//   → validateMergeResult([], cloud, merged) 恒 valid（本地为空，基线为 0）
//   → storage.setGroupsImmediate(merged) 把本地整组会话换成云端快照
// 也就是说：一次读错误 + 一次自动同步 = 本地数据被静默改写。
//
// 本文件钉死修复后的语义：本地快照读失败 → {success:false, reason:'snapshot_failed'}，
// 且在此之前不得发生任何网络请求与任何本地写入（setGroupsImmediate）。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  installFakeSyncBackend,
  resetFakeSyncBackend,
  type FakeSyncBackendHandle,
} from './_helpers/fakeSyncBackend.ts';
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

const LOCAL_GROUPS = [mkGroup('local-1'), mkGroup('local-2'), mkGroup('local-3')] as never;
let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  // 2026-10-16：原守卫用假 PostgREST + 假 session 跑真引擎；后端接缝改造后
  // SyncEngine 的网络出口只剩 `@/sync-backend`，这里注入替身（远端恒空）。
  backend = await installFakeSyncBackend();

  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
  await storage.setGroupsImmediate(LOCAL_GROUPS);
  const { invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
});

describe('downloadAndMerge fail-closed：本地快照读失败不得变成写入', () => {
  it('读失败 → 立即返回 snapshot_failed，且零网络请求、零落盘', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    backend.calls.fetchFingerprints = 0;
    backend.calls.downloadGroups = 0;
    env.writes.length = 0;
    env.failReadKeys.add('tab_groups');
    let result: Awaited<ReturnType<typeof syncEngine.downloadAndMerge>>;
    try {
      result = await syncEngine.downloadAndMerge({ forceRemote: true });
    } finally {
      env.failReadKeys.delete('tab_groups');
    }

    assert.equal(result.success, false, '本地读失败时下载必须失败（修复前会成功并写回云端快照）');
    assert.equal(result.reason, 'snapshot_failed', '必须给出可辨识的失败原因');
    assert.deepEqual(result.groups, [], '失败时不得回吐任何（云端）数据');
    assert.equal(backend.calls.downloadGroups, 0, '本地快照都没读到就不该发起云端下载');
    assert.equal(backend.calls.fetchFingerprints, 0, '探活同样不该发起');
    assert.equal(
      env.writes.includes('tab_groups'),
      false,
      '读失败后一次 setGroupsImmediate 都不允许发生（修复前会把本地整组会话换成云端快照）'
    );

    // 落盘仍是原来三条
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['local-1', 'local-2', 'local-3'],
      '本地会话列表未被改写'
    );
  });

  it('读失败后引擎不卡在 syncing（后续同步仍可进入）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    env.failReadKeys.add('tab_groups');
    try {
      await syncEngine.downloadAndMerge({ forceRemote: true });
    } finally {
      env.failReadKeys.delete('tab_groups');
    }
    assert.equal(syncEngine.getIsSyncing(), false, '失败返回前必须复位 isSyncing');
  });

  it('读成功时对照组：仍走正常流程（证明上一条不是被环境整体短路）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    backend.calls.downloadGroups = 0;
    // 默认（非 forceRemote）路径：远端为空 → 合并结果应保留全部本地组
    const result = await syncEngine.downloadAndMerge();
    assert.equal(result.success, true, '读成功时下载必须成功');
    assert.ok(backend.calls.downloadGroups > 0, '读成功时必须真的发起云端下载');
    assert.deepEqual(
      result.groups.map(g => g.id).sort(),
      ['local-1', 'local-2', 'local-3'],
      '远端为空时本地组必须全部保留（本次不是「读失败被吞成空」的形状）'
    );
  });
});
