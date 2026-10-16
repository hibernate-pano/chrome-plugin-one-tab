// 迁移边界：purgeTombstones 物理移除墓碑组前必须登记删除意图（否则升级后复活）。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身把整份 tests/offlineDeleteNoResurrect.test.ts
// 删除。审计用变异证明：把源文件里 `await storage.addPendingDeleteIds(tombstoneGroupIds)`
// 注释掉后，全量 1046 个测试依旧全绿。而残留的
// tests/localStorageFreshness.test.ts「purgeTombstones 基于真值」只断言墓碑组被
// 物理移除，从未断言删除队列收到了这些 id —— 恰好漏掉唯一不可逆的那一步。
//
// 缺陷本体（1.22.10 修复）：
//   purgeTombstones 把组级墓碑从 storage 物理移除，但没把 id 转入 pendingDeleteIds。
//   它假设「未上过云的残留由下一次 upload 的兜底标记覆盖」，可那个兜底
//   （syncEngine.upload 的 legacyTombstoneIds）读的正是 storage 里的 isDeleted 组
//   —— 迁移一删，兜底永远读不到。凡「离线删除 + 墓碑从未上过云 + 升级到 1.22.x」，
//   云端行仍活跃，下次下载合并整组复活（v1.22.0 起无回收站）。
//   修复：登记意图**先于**物理移除（崩溃窗口落在「已登记、未移除」侧顶多重广播
//   一次，幂等；反过来就是本缺陷）。
//
// 变异验证口径（本次恢复后实测）：注释掉 addPendingDeleteIds 调用后，
// 「墓碑组的删除意图必须先登记进 pending_delete_ids」与「上传必须把该 id 广播出去」
// 逐条变红（具体输出见交付记录）。
import { describe, it, before, after } from 'node:test';
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

installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

let backend: FakeSyncBackendHandle;

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  await resetFakeSyncBackend();
});

describe('迁移边界：purgeTombstones 物理移除墓碑组前必须登记删除意图', () => {
  it('墓碑组被物理移除前先把 id 登记进广播队列，随后上传把它广播到云端', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    const { purgeTombstones } = await import('@/utils/migrationUtils');

    // 本地：一个活跃组 + 一个老模型墓碑组（离线删除、广播从未成功）
    await storage.setGroupsImmediate([
      mkGroup('g-keep'),
      mkGroup('g-tomb', { isDeleted: true }),
    ] as never);
    invalidateGroupsCache();

    // 记录「登记」与「物理移除」的真实先后顺序 —— 崩溃窗口只有在
    // 「已登记、未移除」一侧才是幂等重广播；反过来就是丢意图。
    const events: string[] = [];
    const origAdd = storage.addPendingDeleteIds.bind(storage);
    const origSet = storage.setGroupsImmediate.bind(storage);
    (storage as unknown as Record<string, unknown>).addPendingDeleteIds = async (
      ids: readonly string[]
    ) => {
      if (ids.length > 0) events.push(`add:${ids.join(',')}`);
      return origAdd(ids);
    };
    (storage as unknown as Record<string, unknown>).setGroupsImmediate = async (
      groups: Parameters<typeof origSet>[0]
    ) => {
      events.push(`set:${groups.map(g => g.id).join(',')}`);
      return origSet(groups);
    };

    try {
      await purgeTombstones();
    } finally {
      (storage as unknown as Record<string, unknown>).addPendingDeleteIds = origAdd;
      (storage as unknown as Record<string, unknown>).setGroupsImmediate = origSet;
    }

    // 关键断言 1：墓碑组物理移除，但删除意图必须先登记（不可逆的顺序）
    const addIdx = events.findIndex(e => e.startsWith('add:g-tomb'));
    const setIdx = events.findIndex(e => e.startsWith('set:'));
    assert.ok(
      addIdx !== -1,
      `墓碑组的删除意图必须先登记进广播队列，实际事件序列: ${events.join(' → ') || '（空）'}`
    );
    assert.ok(setIdx !== -1, `应发生一次物理移除写入，实际事件序列: ${events.join(' → ')}`);
    assert.ok(
      addIdx < setIdx,
      '登记必须**先于**物理移除：反过来的崩溃窗口会让删除意图永久蒸发'
    );

    invalidateGroupsCache();
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['g-keep'],
      '墓碑组应被物理移除（无墓碑模型）'
    );
    assert.ok(
      (await storage.getPendingDeleteIds()).includes('g-tomb'),
      '墓碑组的删除意图必须登记进 pending_delete_ids——' +
        '否则云端活跃行无从服从删除，下次下载合并整组复活（修复前的原样）'
    );

    // 关键断言 2：上传把删除广播到云端（真 SyncEngine + 后端替身的 broadcastDeletes 台账）
    const { syncEngine } = await import('@/services/syncEngine');
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `迁移后的上传必须成功（${up.error ?? '无'}）`);
    assert.ok(
      backend.calls.broadcastDeletes.some(ids => ids.includes('g-tomb')),
      `云端必须收到 g-tomb 的删除广播，实际台账: ${JSON.stringify(backend.calls.broadcastDeletes)}`
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '广播读回确认后队列清空（否则下轮重复广播）'
    );
  });
});
