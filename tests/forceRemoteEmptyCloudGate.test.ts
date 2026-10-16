// decideForceRemoteOverwrite 的**调用点**守卫：云端只有墓碑 ≠ 云端为空。
//
// 【为什么需要这个文件，而不是纯函数用例】tests/syncMergeSafety.test.ts 里
// 曾用 `{localActiveCount:3, cloudTotalCount:2}` 同时表达「云端有活跃行」与
// 「云端只有墓碑行」两个场景 —— 输入逐字相同，纯函数只能看到**数量**，
// 根本区分不了两者，那条用例的标题与断言无关（假绿）。
//
// 真正需要钉住的区分在调用点：downloadAndMerge 必须把 downloadTabGroups()
// 返回的**全部行（含 is_deleted 墓碑）**计入 cloudTotalCount。若有人顺手在
// 计数前过滤墓碑：
//   云端只剩墓碑（别处把会话全删了）→ 被数成 0 → 空云端闸门误判 refusal
//   → 跨设备删除永远传不过来（用户删不掉会话）。
// 反过来，云端一行都没有 → 必须 refusal（拿什么都没有来镜像会清空本机）。
//
// 修法（2026-10-15）：闸门判据是「云端完全没有行」，不是「云端没有活跃行」。
// 本文件在真 SyncEngine + 后端替身上钉死这两个终态的互斥。
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
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([mkGroup('local-1')] as never);
  invalidateGroupsCache();
  backend.calls.broadcastDeletes.length = 0;
});

describe('覆盖下载空云端闸门（调用点）：只有墓碑 ≠ 为空', () => {
  it('云端一行都没有 + 本地有活跃组 ⇒ refuse，且本地数据未被触碰', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    backend.groups = [];

    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, false, '空云端覆盖必须被拒绝（v1.22.0 起无回收站，不可逆）');
    assert.equal(result.reason, 'overwrite_empty_cloud_refused');
    assert.deepEqual(
      result.groups.map(g => g.id),
      ['local-1'],
      '拒绝时不写任何东西，回吐的必须是本地快照真值'
    );
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['local-1'],
      '本地数据根本没被动过（闸门在置空 localGroups 之前）'
    );
  });

  it('云端只有墓碑行 + 本地有活跃组 ⇒ proceed（别处的显式删除必须能传过来）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    // 云端只有一行，且是墓碑：另一台设备把会话全删了。
    // 调用点若在计数前过滤 is_deleted，这里会走成 refuse —— 那等于跨设备删除永远不生效。
    backend.groups = [mkGroup('gone', { isDeleted: true, tabs: [] })] as never;

    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.success,
      true,
      '云端只有墓碑是合法状态（删除广播），不得被空云端闸门拦下'
    );
    assert.equal(result.reason, undefined, '不得返回 overwrite_empty_cloud_refused');
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      [],
      '覆盖语义 = 云端镜像：墓碑不落库，本地被同步后的终态为空（删除已服从）'
    );
  });
});
