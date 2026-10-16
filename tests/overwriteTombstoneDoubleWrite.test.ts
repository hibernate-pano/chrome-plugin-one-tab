// 覆盖上传：墓碑只写一遍（不再 tombstone double-write）。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身删掉了原守卫。审计用变异证明：把
// src/services/syncEngine.ts 里 `writtenTombstoneIds = new Set(up?.writtenTombstoneIds ?? [])`
// 换成 `writtenTombstoneIds = new Set()`，全量 1046 个测试依旧全绿。
//
// 缺陷本体（P0-2，双写墓碑）：
//   覆盖模式下 uploadTabGroups(allGroups, true) 已经把残留墓碑按「本机印记」
//   写上云，upload() 随后又把这些 id 交给 markCloudGroupsAsDeleted —— 它会按
//   云端 OLD.last_op_seq+1 且换成本设备重新 UPDATE，同一行被写两遍：
//     (a) 多 N 次 UPDATE 往返 + 一次读回 SELECT；
//     (b) 严格 LT 守卫（BEFORE UPDATE）可能把第二次写静默吞掉，与 upsert 写入的
//         印记互相打架 → verifyUploadReadback 的 checkStamp 永远对不上 → 抛错、
//         pending_upload 保留 → 上传永久卡在重试循环。
//   修复：`writtenTombstoneIds` 记录本轮 upsert 真正写上的 id，广播时把它们剔掉。
//
// 变异验证口径（本次恢复后实测）：把 writtenTombstoneIds 置空后，
// 「覆盖上传不再二次广播墓碑」变红（后端 broadcastDeletes 台账出现墓碑 id）；
// 「合并模式墓碑仍走广播」正控保持绿，证明剔除以「本轮已写上云」为界而不是一刀切。
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

let backend: FakeSyncBackendHandle;

const seedWithTombstones = async () => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([
    mkGroup('g-active'),
    mkGroup('g-tomb-a', { isDeleted: true, tabs: [] }),
    mkGroup('g-tomb-b', { isDeleted: true, tabs: [] }),
  ] as never);
  invalidateGroupsCache();
  backend.calls.broadcastDeletes.length = 0;
  backend.calls.uploadGroups.length = 0;
};

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { storage } = await import('@/utils/storage');
  await storage.clearPendingDeleteIds();
  await seedWithTombstones();
});

describe('ITEM 1 覆盖上传：墓碑只写一遍（不再 tombstone double-write）', () => {
  it('覆盖上传把墓碑并入同一次 upsert，不再二次广播（writtenTombstoneIds 消费真实生效）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    const res = await syncEngine.upload({
      overwriteCloud: true,
      syncSettings: false,
      forcePending: true,
    });

    assert.equal(res.success, true, `覆盖上传应成功：${res.error ?? ''}`);
    assert.equal(res.skippedOverwrite, undefined, '本地有活跃组时不应报告跳过覆盖');

    // 正控：本批 upsert 确实是覆盖模式，且三条行（1 活跃 + 2 墓碑）都交出去了
    assert.equal(backend.calls.uploadGroups.length, 1, '应恰有一次 upsert');
    assert.equal(backend.calls.uploadGroups[0]?.overwriteRemote, true, '覆盖标志必须如实传递');
    assert.equal(backend.calls.uploadGroups[0]?.count, 3, '覆盖模式必须包含残留墓碑');

    // 关键断言：墓碑已被本次 upsert 写掉 → 绝不能再调用 markCloudGroupsAsDeleted
    // （后者的 UPDATE 会按云端 OLD.seq+1 重写印记，与 upsert 的印记打架）
    assert.deepEqual(
      backend.calls.broadcastDeletes,
      [],
      '覆盖上传后不得再对已 upsert 的墓碑行发删除广播（双写 = 多 N 次往返 + ' +
        '印记打架导致读回校验永久失败）。若这里出现墓碑 id，说明 writtenTombstoneIds 被绕开了。'
    );

    // 且本地残留墓碑已随覆盖一起清除
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['g-active'],
      '老版本残留墓碑在广播确认后应从本地物理清除'
    );
  });

  it('合并模式（overwriteCloud=false）：墓碑仍走 markCloudGroupsAsDeleted（未被过度过滤）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(res.success, true, `合并上传应成功：${res.error ?? ''}`);
    // 合并模式只上活跃组，墓碑不在本次 upsert 的 writtenIds 里 → 必须交给广播
    assert.deepEqual(
      backend.calls.uploadGroups[0]?.count,
      1,
      '合并模式只 upsert 活跃组'
    );
    const broadcast = backend.calls.broadcastDeletes.flat();
    assert.ok(
      broadcast.includes('g-tomb-a') && broadcast.includes('g-tomb-b'),
      `合并模式的墓碑必须走删除广播，实际台账: ${JSON.stringify(backend.calls.broadcastDeletes)}`
    );
  });
});
