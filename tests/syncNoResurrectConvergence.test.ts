// 跨设备删除收敛：「本地组被云端更新的墓碑覆盖」必须物理移除，且不得复活。
//
// ══════════════════════════════════════════════════════════════════════════
// 【本文件补的是一条缺失的护栏】main 的 tests/syncNoResurrectInvariants.test.ts
// 覆盖了「认输场景」（A 删除、B 离线编辑过 → B 收敛），但它刻意放了**两个**
// 本地组（doomed + keep）：合并结果非空 ⇒ validateMergeResult 的旧「规则 2」
// 永远不触发 ⇒ 那条缺陷被正控组遮住了。
//
// 本文件钉的是**同一个语义下更极端的那一半**：本地**只剩一个**组，且它正是
// 被远端删掉的那一个。此时 merged=0，旧规则 2「本地有活跃数据但合并后为空」
// 命中 ⇒ 判为 validation_failed ⇒ 本机会话永远收不到「另一端已删除」，
// 每轮下载都以同步失败中止，用户侧持续看到错误。
//
// 【为什么旧规则 2 在 whole-group LWW 下只命中这一个合法场景】
//   常规合并里 merged=0 ⟺ 每个本地活跃 id 都输给了一个云端墓碑行
//   （输给云端活跃行时该行会以活跃身份进 merged，本地独有 id 永远保留）；
//   而覆盖模式（forceRemote）在合并前把 localGroups 置空，旧规则 2 同样
//   不可达（decideForceRemoteOverwrite 的注释已论证）。
//   即它把「跨设备删除传播的合法终点」当故障拦 —— 防线方向错了，
//   比没有防线更坏。修复见 src/core/syncDecision.ts（该文件留档了完整推导）。
//
// 变异验证口径：
//   · 把已删除的规则 2 改回旧形态 ⇒ 「本地仅存组被云端墓碑覆盖」红
//   · 让本地新印记也输给墓碑 ⇒ 「离线修改不被旧墓碑删掉」红
//   · 上传路径把已移除组重新 upsert ⇒ 「移除后上传不复活」红
// ══════════════════════════════════════════════════════════════════════════
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

/** 设备 B 的旧印记：持久化号位远低于设备 A 删会话时盖出的墓碑。 */
const B_OLD = { d: 'dev-B', s: 2 };
/** 设备 A 删除时盖出的墓碑印记：严格更新，必胜。 */
const A_NEW = { d: 'dev-A', s: 9 };

const seedLocal = async (groups: Array<Record<string, unknown>>) => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate(groups as never);
  invalidateGroupsCache();
};

const localIds = async (): Promise<string[]> => {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  return (await storage.getGroups()).map(g => g.id);
};

before(async () => {
  register(LOADER_PATH);
  backend = await installFakeSyncBackend();
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
  // main 的 downloadAndMerge 有后端门禁：readConfiguredBackendId 读到
  // syncBackend='webdav' 才走自带存储路径；未设置时它回落成 'supabase'
  // ⇒ ensureAuthenticated 失败 ⇒ reason='not_authenticated'（与被测缺陷无关）。
  const { kvSet } = await import('@/storage/storageAdapter');
  const { DEFAULT_SETTINGS } = await import('@/utils/storage');
  await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
});

after(async () => {
  await resetFakeSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  backend.groups = [];
  backend.calls.uploadGroups.length = 0;
  backend.calls.broadcastDeletes.length = 0;
  const { storage } = await import('@/utils/storage');
  await storage.clearPendingDeleteIds();
  await storage.setPendingUpload(false);
  // recent_upload_guard（35s 窗口，见 syncDecision.ts UPLOAD_GUARD_MS）：
  // 上一个用例的 upload 会写 last_upload_time，同文件后续用例的下载会被它
  // 拦下（reason: recent_upload_guard）。复位成远古时间 = 「从未上传过」。
  await storage.setLastUploadTime('2020-01-01T00:00:00.000Z');
});

describe('跨设备删除收敛：云端墓碑 vs 本地旧副本', () => {
  it('⚠️ 本地仅存的组被云端更新的墓碑覆盖 ⇒ 下载必须成功且物理移除（不得被规则 2 误拦）', async () => {
    // 场景：用户只有 1 个会话；在设备 A 上删了它；设备 B 离线至今，
    // 本地仍是活跃旧副本。B 同步必须收敛到「已删除」。
    await seedLocal([mkGroup('g-doomed', { lastOp: B_OLD })]);
    backend.groups = [mkGroup('g-doomed', { isDeleted: true, tabs: [], lastOp: A_NEW })] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();

    assert.equal(
      res.success,
      true,
      `本地唯一组输给云端墓碑是合法收敛，不得中止（实得 reason: ${res.reason ?? '无'}）`
    );
    assert.deepEqual(
      await localIds(),
      [],
      '本地组必须被物理移除（无回收站模型下收敛到「已删除」）'
    );
  });

  it('移除后上传不得复活：upsert 与广播都不含已收敛删除的组', async () => {
    await seedLocal([mkGroup('g-doomed', { lastOp: B_OLD })]);
    backend.groups = [mkGroup('g-doomed', { isDeleted: true, tabs: [], lastOp: A_NEW })] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const down = await syncEngine.downloadAndMerge();
    assert.equal(down.success, true, `前置：下载必须成功（${down.reason ?? '无'}）`);

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `移除后的上传必须成功（${up.error ?? '无'}）`);

    const upserted = backend.calls.uploadGroups.flatMap(c => c.count);
    assert.equal(
      backend.calls.uploadGroups.length,
      0,
      '本地已无活跃组，不应产生任何 upsert（更不得把已删除组写回云端）'
    );
    assert.equal(upserted.length, 0);
    assert.deepEqual(
      backend.calls.broadcastDeletes.flat(),
      [],
      '云端已是墓碑，无需再广播删除（广播是无害的，但说明引擎没理解收敛语义）'
    );
    assert.deepEqual(await localIds(), [], '上传后本地仍不得复活');
  });

  it('正控：本地另有未冲突组时，合并只剩它（证明上一条不是「把数据清空了」）', async () => {
    await seedLocal([
      mkGroup('g-doomed', { lastOp: B_OLD }),
      mkGroup('g-keep', { lastOp: { d: 'dev-B', s: 3 } }),
    ]);
    backend.groups = [mkGroup('g-doomed', { isDeleted: true, tabs: [], lastOp: A_NEW })] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();

    assert.equal(res.success, true, `下载必须成功（${res.reason ?? '无'}）`);
    assert.deepEqual(
      await localIds(),
      ['g-keep'],
      '墓碑只收敛它覆盖的那一组；未冲突组必须原样留下'
    );
  });

  it('反向保护：本地印记比墓碑更新 ⇒ 离线修改保留，旧墓碑不得删掉新编辑', async () => {
    // 另一半正确性：B 离线期间编辑过（未同步），云端墓碑更旧 —— 删除必须
    // 输给这次编辑，否则「另一端删过」会静默吞掉用户最新的工作。
    await seedLocal([mkGroup('g-edited', { lastOp: { d: 'dev-B', s: 12 } })]);
    backend.groups = [mkGroup('g-edited', { isDeleted: true, tabs: [], lastOp: A_NEW })] as never;

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.downloadAndMerge();

    assert.equal(res.success, true, `下载必须成功（${res.reason ?? '无'}）`);
    assert.deepEqual(
      await localIds(),
      ['g-edited'],
      '本地更新的离线编辑必须赢过云端旧墓碑（组级 LWW 决胜）'
    );
  });
});
