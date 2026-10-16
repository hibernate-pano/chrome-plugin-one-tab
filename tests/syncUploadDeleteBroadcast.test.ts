// 上传删除广播接线：markCloudGroupsAsDeleted 与 clearPendingDeleteIds 必须成对。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身时删掉了原守卫（审计记录的
// src/services/syncEngine.ts:674-681 接线）。审计用变异证明：把这处
// `if (cloudDeleteIds.length > 0 && opts?.includeDeleted !== false)` 改成
// `if (false && ...)` 后，全量 1046 个测试依旧全绿 —— tests/_helpers/fakeSyncBackend.ts
// 里的 `broadcastDeletes` 调用台账当时没有任何断言读它。
//
// 这条接线的两个方向都是事故：
//   · 少广播（漏掉 if）：本地已物理删除、云端行仍活跃 → 对端下次合并整组复活
//     （v1.22.0 起无回收站，不可逆）。
//   · 只广播不清队：队列永远非空 → 每轮重复广播，且 pending_upload 永不清。
//   · 不广播却清队（方向相反的 fail-open）：删除意图当场蒸发，比前者更隐蔽 ——
//     所以 includeDeleted=false（本轮不广播）时队列必须原样保留。
//
// 变异验证口径（本次恢复后实测）：把 if 条件恒假后，
// 「上传一次即广播队列里的 id，并在读回确认后清队」逐条变红
// （broadcastDeletes 台账为空 + 队列未清）；具体输出见交付记录。
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
  env.writes.length = 0;
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([mkGroup('g-keep')] as never);
  await storage.addPendingDeleteIds(['g-del']);
  invalidateGroupsCache();
  backend.calls.broadcastDeletes.length = 0;
});

describe('syncEngine.upload：删除广播接线（广播 + 清队成对）', () => {
  it('上传一次即把 pending_delete_ids 里的 id 交给后端广播，并在读回确认后清队', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(up.success, true, `上传必须成功（${up.error ?? '无'}）`);
    assert.deepEqual(
      backend.calls.broadcastDeletes,
      [['g-del']],
      '已物理删除的组必须广播到云端（标记 is_deleted）；漏掉这一步，对端下次合并会把' +
        '整组复活，而本地已经没有任何痕迹可以重试'
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '广播成功（后端调用返回）后必须清队，否则每轮重复广播且 pending_upload 永不清'
    );
  });

  it('includeDeleted=false：本轮不广播时队列必须原样保留（清队与广播成对）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    const up = await syncEngine.upload({
      syncSettings: false,
      forcePending: true,
      includeDeleted: false,
    });

    assert.equal(up.success, true, `上传必须成功（${up.error ?? '无'}）`);
    assert.deepEqual(
      backend.calls.broadcastDeletes,
      [],
      'includeDeleted=false 时不得发广播（测试专用开关）'
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      ['g-del'],
      '没广播就绝不能清队：那等于把删除意图当场丢弃，云端行仍活跃 → 下次合并整组复活'
    );
  });

  it('队列为空时后端不得收到空广播调用（负控：证明上一条是接线触发而不是替身噪声）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    await storage.clearPendingDeleteIds([]);
    // 上面传空数组不会清掉持久化队列（清队按确认消费），因此直接重建一个空队列环境
    const { kvRemove } = await import('@/storage/storageAdapter');
    await kvRemove('pending_delete_ids');

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(up.success, true);
    assert.deepEqual(backend.calls.broadcastDeletes, [], '没有删除意图就不该调用广播');
  });
});
