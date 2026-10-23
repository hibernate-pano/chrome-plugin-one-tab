/**
 * 覆盖下载的**预览**必须与**实际落盘结果**一致（2026-10-23，第 51 轮）。
 *
 * ── 这个缺陷是什么 ──────────────────────────────────────────────────────
 * 第 51 轮自审发现的第二个 P1：
 *
 *   覆盖下载的预览（utils/syncPreview.ts 的 buildDownloadPreviewSummary）
 *   算「覆盖后本地还剩什么」时，**只**用了「云端读到的」那几组。
 *   而「云端这轮读不出来、本机有副本」的那几组（D-6，2026-10-20 引入的保护）
 *   **不在**那份清单里（那是「读到的」）⇒ 预览把它们算成了「覆盖后会被删除」。
 *
 *   而执行侧（services/syncEngine.ts）**明明会保住它们**（D-6 的全部意义）。
 *   ⇒ 预览说「将删除 N 个会话」，实际只删 N−1 个 ⇒ **预览说了假话**。
 *
 * 方向上是「多报删除」（偏保守），但它仍然是谎话：
 *   · 用户为一个**不会发生**的删除去确认（白紧张，还学不会信任这个数字）；
 *   · 卡片上的「预计删除数」与执行结果对不上；
 *   · 更糟的是：跳过清单里的组如果**本机没有副本**，那份清单对预览毫无作用
 *     ⇒ 预览完全看不见「云端这轮没读到」这件事。
 *
 * ── 为什么这条守卫要跑**真引擎**、走**真的装配路径** ─────────────────────
 * 「预览与实际同源」只有跑一遍真引擎、拿真落盘结果来对账才算数。
 * 只断言纯函数的结果，只能证明「纯函数算成了某个数」，证明不了「那个数对」。
 *
 * 而「装配路径」也必须是**真的**那条：数据装配已从组件搬进
 * `services/syncPreviewLoader.ts`（第 51 轮）—— 留在组件里的话，守卫只能对着
 * **源码长相**断言，而源码长相证明不了「那份清单真的进了预览」
 * （把清单换成空数组，源码长相一点没变 ⇒ 守卫照样绿 = 零检测力）。
 *
 * ── 判据钉的是**不变量** ────────────────────────────────────────────────
 *   1. 预览说的「会删掉几个」== 实际被删掉几个（逐个 id 对账）；
 *   2. 预览说的「覆盖后还剩几个」== 实际落盘的活跃会话数；
 *   3. 被跳过的组**本机没有副本**时 ⇒ 预览不算「保住」（没什么可保住的）；
 *   4. 墓碑**不保活**（删除意图有本机证据，与云端读不读得出来无关）；
 *   5. 合并模式不删任何东西 ⇒ 「保住数」恒为 0；
 *   6. 上传方向的「保留数」== 执行侧判据算出的（装配路径也要同源）；
 *   7. 文案：下载方向的风险文案必须说「本地那几份会被保留」，
 *      且**不得**说「不会被删除或覆盖」（那在下载方向上是自相矛盾的话）。
 *   8. 云端带来的**空壳**（零标签）会被引擎剔掉 ⇒ 预览必须把这次删除报出来
 *      （旧口径不建模空壳清理 ⇒ 说「不会删」，实际真删了 ⇒ 方向相反的谎话）；
 *   9. 同一个 id 同时出现在「读到的」与「读不出来的」两份清单里 ⇒ 只能算一份
 *      （引擎按 id 去重，旧口径直接拼接 ⇒ 说「还剩 2 个」，实际落盘 1 个）。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv, mkGroup } from '../_helpers/engineStorageEnv.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

// ⚠️ 必须在任何 `await import('@/utils/storage')` 之前装环境桩。
const env = installEngineStorageEnv();

/** 一条「读不出来」的记录（形状与端口的 DownloadSkippedGroup 一致）。 */
interface SkippedRow {
  id: string;
  reason: string;
}

/**
 * 可编程的后端替身：逐次给「读到的」与「读不出来的」两份清单。
 *
 * `downloadSkippedGroups` 是**可选能力**（自带存储后端没有这个方法）⇒
 * 这里默认提供，模拟的是云端后端那种「会跳过」的后端。
 */
function makeBackend(opts?: { groups?: unknown[]; skipped?: SkippedRow[] }) {
  const backend: Record<string, unknown> = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return opts?.groups ?? [];
    },
    async uploadGroups(groups: Array<{ id: string }>, uploadOpts?: { overwriteRemote?: boolean }) {
      return {
        writtenIds: groups.map(g => g.id),
        overwroteRemote: uploadOpts?.overwriteRemote === true,
      };
    },
    async broadcastDeletes() {
      return { broadcastIds: [], blockedIds: [] };
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 测试不需要写设置 */
    },
    async downloadSettings() {
      return null;
    },
    async downloadSkippedGroups() {
      return opts?.skipped ?? [];
    },
  };
  return backend;
}

/** 把替身装进 @/sync-backend（必须在被测模块被 import 之前完成）。 */
async function install(backend: unknown): Promise<void> {
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(backend as never);
}

/** 读本地磁盘真值（绕开 30s 缓存）。 */
async function readLocalGroups(): Promise<Array<{ id: string; isDeleted?: boolean }>> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  return storage.getGroups() as never;
}

/** 把本机会话写进磁盘（预览与引擎都从这里读真值）。 */
async function seedLocalGroups(groups: unknown[]): Promise<void> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate(groups as never);
  invalidateGroupsCache();
}

before(async () => {
  register(LOADER_PATH);
  const { storage } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
});

after(async () => {
  const { resetActiveSyncBackend } = await import('@/sync-backend/index.ts');
  resetActiveSyncBackend();
});

beforeEach(async () => {
  env.failReadKeys.clear();
  const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
  // ⚠️ 必须显式种 syncBackend:'webdav'：读不到设置时 downloadAndMerge 会在任何
  // 闸门之前就返回 backend_unknown ⇒ 用例变成永远为绿的假通过
  // （同样的坑见 forceRemoteEmptyCloudGate.test.ts）。
  await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  invalidateGroupsCache();
});

/** 三组本机会话 + 一组云端会话 + 一条跳过清单 —— 本文件的标准局面。 */
const LOCAL_GROUPS = () => [
  mkGroup('local-keep'), // 云端这轮读不出来 ⇒ 执行侧保住它
  mkGroup('local-same'), // 云端读得到 ⇒ 云端那份顶上来
  mkGroup('local-only'), // 只有本机有 ⇒ 覆盖后真的会被删
];
const LOCAL_IDS = () => LOCAL_GROUPS().map(g => String(g.id));
const CLOUD_GROUPS = () => [mkGroup('local-same')];
const SKIPPED = [{ id: 'local-keep', reason: 'restore_ratio' }];

describe('覆盖下载的预览：说的数必须与真引擎跑出来的结果一致', () => {
  it('预览的「删除数 / 剩余数」== 实际落盘的事实（逐个 id 对账）', async () => {
    await seedLocalGroups(LOCAL_GROUPS());
    await install(makeBackend({ groups: CLOUD_GROUPS(), skipped: SKIPPED }));

    // ── 预览侧：**真的装配路径**（组件用的就是它） ───────────────────────
    // ⚠️ 必须在引擎跑**之前**算：引擎会把结果写回本机（把「只有本机有」的那组
    // 真删掉），预览的「覆盖前」必须取覆盖前的那份真值。
    const { loadDownloadPreviewData } = await import('@/services/syncPreviewLoader');
    const preview = (await loadDownloadPreviewData()).overwrite;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    // ── 事实侧：真引擎落盘之后，本机还剩什么、少了什么 ──────────────────
    const after = await readLocalGroups();
    const afterActiveIds = after.filter(g => !g.isDeleted).map(g => g.id).sort();
    const actuallyDeleted = LOCAL_IDS().filter(id => !afterActiveIds.includes(id)).sort();

    assert.deepEqual(
      afterActiveIds,
      ['local-keep', 'local-same'],
      '前提：云端读不出来的那组本机那份必须还在（D-6 的保护）'
    );
    assert.deepEqual(
      actuallyDeleted,
      ['local-only'],
      '前提：真的只删掉了「只有本机有」的那一组'
    );

    assert.equal(
      preview.deletions,
      actuallyDeleted.length,
      '预览说的「会删几个」必须等于实际删掉的个数 —— ' +
        '预览多报删除 = 拿一个不会发生的删除去吓用户；少报 = 真的删了却没预警'
    );
    assert.equal(
      preview.afterCount,
      afterActiveIds.length,
      '预览说的「覆盖后还剩几个」必须等于实际落盘的活跃会话数'
    );
    assert.equal(
      preview.preservedCount,
      1,
      '「云端读不出来、本机有副本」的那一组必须算成**保住**（不是删除）'
    );
  });

  it('被跳过的组**本机没有副本**时，不算「保住」（没什么可保住的）', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const preview = buildDownloadPreviewSummary(
      LOCAL_GROUPS() as never,
      CLOUD_GROUPS() as never,
      'overwrite',
      { skippedRemoteIds: ['cloud-only-unreadable'] },
    );
    assert.equal(
      preview.preservedCount,
      0,
      '本机压根没有那个 id ⇒ 没有任何本机副本可保住 ⇒ 不能报「保住」'
    );
  });

  it('墓碑不保活（删除意图有本机证据，与云端读不读得出来无关）', async () => {
    const { preservedLocalGroups } = await import('@/core/overwriteDownloadPreserve');
    const tombstone = { id: 'gone', isDeleted: true };
    const active = { id: 'alive', isDeleted: false };
    const kept = preservedLocalGroups(
      [tombstone, active] as never,
      new Set(['gone', 'alive']),
    );
    assert.deepEqual(
      kept.map(g => g.id),
      ['alive'],
      '墓碑不进「保住」—— 把用户已经删掉的会话又留在本机是错的'
    );
  });

  it('合并模式不删任何东西 ⇒ 「保住数」恒为 0', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const preview = buildDownloadPreviewSummary(
      LOCAL_GROUPS() as never,
      CLOUD_GROUPS() as never,
      'merge',
      { skippedRemoteIds: SKIPPED.map(s => s.id) },
    );
    assert.equal(preview.preservedCount, 0);
  });

  it('云端那份与本机那份**内容不同**时：预览说「更新 1 个」，引擎也真的换了内容', async () => {
    // 本机那份是旧的（名字旧、时间旧），云端那份是新的。
    // 覆盖下载的语义 = 本地以云端为准 ⇒ 落盘的必须是**云端那份**。
    await seedLocalGroups([
      mkGroup('local-updated', { name: '旧名字', updatedAt: '2026-09-29T08:00:00.000Z' }),
    ]);
    await install(
      makeBackend({
        groups: [mkGroup('local-updated', { name: '新名字', updatedAt: '2026-10-23T08:00:00.000Z' })],
        skipped: [],
      }),
    );

    const { loadDownloadPreviewData } = await import('@/services/syncPreviewLoader');
    const preview = (await loadDownloadPreviewData()).overwrite;
    assert.equal(preview.updates, 1, '内容不同 ⇒ 预览必须说「更新 1 个」');
    assert.equal(preview.deletions, 0, '同一个 id ⇒ 不是删除');

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const after = await readLocalGroups();
    const landed = after.find(g => g.id === 'local-updated') as { name?: string } | undefined;
    assert.ok(landed, '那组必须还在（覆盖不是删除）');
    assert.equal(landed!.name, '新名字', '落盘的必须是云端那份（新的）—— 预览说「更新」就得真的更新');
  });
});

describe('预览的数据装配：跳过清单必须真的进了预览（行为级，不是源码长相）', () => {
  it('上传预览算出的「保留数」== 执行侧判据算出的', async () => {
    // 一组「云端有、这台设备读不出来、本机没有副本」⇒ 覆盖上传会保住它。
    const skipped = [{ id: 'cloud-unreadable', reason: 'restore_ratio' }];
    await seedLocalGroups(LOCAL_GROUPS());
    await install(makeBackend({ groups: CLOUD_GROUPS(), skipped }));

    const { loadUploadPreviewData } = await import('@/services/syncPreviewLoader');
    const data = await loadUploadPreviewData();

    const { planOverwriteUpload } = await import('@/core/overwriteUploadGuard');
    const expected = planOverwriteUpload({
      cloudIds: [...CLOUD_GROUPS().map(g => String(g.id)), ...skipped.map(s => s.id)],
      localIds: LOCAL_IDS(),
      unrestorableIds: skipped.map(s => s.id),
    }).protectedIds.length;

    assert.equal(expected, 1, '前提：那一行本机没有副本 ⇒ 该被保住');
    assert.equal(
      data.overwrite.preservedCount,
      expected,
      '装配路径算出的保留数必须与执行侧判据一致（跳过清单没进预览 ⇒ 保留数算成 0）'
    );
  });

  it('下载预览算出的「保住数」== 引擎真的保住的份数', async () => {
    await seedLocalGroups(LOCAL_GROUPS());
    await install(makeBackend({ groups: CLOUD_GROUPS(), skipped: SKIPPED }));

    const { loadDownloadPreviewData } = await import('@/services/syncPreviewLoader');
    const preview = (await loadDownloadPreviewData()).overwrite;

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge({ forceRemote: true });
    const after = await readLocalGroups();
    const actuallyKept = LOCAL_IDS().filter(id =>
      after.filter(g => !g.isDeleted).map(g => g.id).includes(id),
    );

    assert.equal(
      preview.preservedCount,
      1,
      '装配路径必须把「云端读不出来」的那几组算成保住（跳过清单没进预览 ⇒ 算成 0）'
    );
    assert.ok(
      actuallyKept.includes('local-keep'),
      '前提：引擎真的保住了云端读不出来的那一组'
    );
  });

  it('上传预览按后端分流（自带存储 = 并集口径，一个都不删）', async () => {
    // 本机一组、云端两组 ⇒ 「替换」口径下会报「删除 2 个」。
    await seedLocalGroups([mkGroup('c')]);
    await install(makeBackend({ groups: [mkGroup('a'), mkGroup('b')], skipped: [] }));

    const { loadUploadPreviewData } = await import('@/services/syncPreviewLoader');

    const replaceMode = (await loadUploadPreviewData({ preserveRemoteOnly: false })).overwrite;
    assert.equal(replaceMode.deletions, 2, '替换口径（Supabase）：云端独有会话算成删除');

    const unionMode = (await loadUploadPreviewData({ preserveRemoteOnly: true })).overwrite;
    assert.equal(unionMode.deletions, 0, '并集口径（自带存储）：云端独有会话一个都不删');
    assert.equal(unionMode.afterCount, 3, '并集口径：云端会话数如实变成并集（2 → 3）');
  });
});

describe('落点必须逐个 id 对齐：空壳清理（M3）与同一个 id 出现两次（M2）', () => {
  it('云端带来的空壳（零标签）会被引擎剔掉 ⇒ 预览必须把这次删除算进去', async () => {
    // 本机有一组 g1（带标签）；云端同一个 g1 是个**零标签的空壳**。
    // 执行侧：空壳会被 dropSyncMergedGroups 剔掉 ⇒ 本机那组真的没了。
    //
    // ⚠️ 旧口径的预览把「云端读到的」直接当落点 ⇒ 算成「不删」⇒
    // **方向相反的谎话**（说不会删，实际真删了）。
    await seedLocalGroups([mkGroup('g1')]);
    await install(makeBackend({ groups: [mkGroup('g1', { tabs: [] })], skipped: [] }));

    const { loadDownloadPreviewData } = await import('@/services/syncPreviewLoader');
    const preview = (await loadDownloadPreviewData()).overwrite;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const after = await readLocalGroups();
    const afterActiveIds = after.filter(g => !g.isDeleted).map(g => g.id).sort();
    assert.deepEqual(afterActiveIds, [], '前提：引擎真的把那个零标签空壳剔掉了（本机那组也没了）');

    assert.equal(
      preview.deletions,
      1,
      '预览必须报「会删 1 个会话」—— 旧口径报 0（说不会删，实际真删了）'
    );
    assert.equal(
      preview.afterCount,
      0,
      '空壳场景下预览说的「还剩几个」必须等于实际落盘数'
    );
  });

  it('同一个 id 同时出现在「读到的」与「读不出来的」两份清单里 ⇒ 只能算一份', async () => {
    // 真实存在这种局面：云端 tabs 表回填抛错的那一组**既在结果里、又被记成跳过**
    //（见 utils/supabase/download.ts 的 catch 分支）⇒ 同一个 id 两边都有。
    //
    // 执行侧按 id 去重（mergeOpStamped 用 Map）⇒ 落盘 1 份；
    // 旧口径的预览是两份清单**直接拼接** ⇒ 同一个 id 数两遍 ⇒ 说「还剩 2 个」，
    // 实际只有 1 个。
    await seedLocalGroups([mkGroup('g1')]);
    await install(makeBackend({ groups: [mkGroup('g1')], skipped: [{ id: 'g1', reason: 'restore_ratio' }] }));

    const { loadDownloadPreviewData } = await import('@/services/syncPreviewLoader');
    const preview = (await loadDownloadPreviewData()).overwrite;

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const after = await readLocalGroups();
    const afterActiveIds = after.filter(g => !g.isDeleted).map(g => g.id).sort();
    assert.deepEqual(afterActiveIds, ['g1'], '前提：落盘的只有一份（引擎按 id 去重）');

    assert.equal(
      preview.afterCount,
      1,
      '同一个 id 不能被数两遍 —— 旧口径说「还剩 2 个」，实际落盘 1 个'
    );
  });
});

describe('覆盖下载的预览：文案', () => {
  it('下载方向的风险文案必须说「本地那几份会被保留」', async () => {
    const { buildDownloadPreviewSummary } = await import('@/utils/syncPreview');
    const { describeOverwriteRisk } = await import('@/components/sync/syncPreviewView');
    const preview = buildDownloadPreviewSummary(
      LOCAL_GROUPS() as never,
      CLOUD_GROUPS() as never,
      'overwrite',
      { skippedRemoteIds: SKIPPED.map(s => s.id) },
    );
    const text = describeOverwriteRisk(preview, '本地', preview.preservedCount);
    assert.match(
      text,
      /本地那几份会被保留/,
      `风险文案必须说出「保住」这件事（实得：${text}）—— ` +
        '否则用户会以为「直接替换本地现状」是真的'
    );
    assert.doesNotMatch(
      text,
      /不会被删除或覆盖/,
      '下载方向说「不会被删除或覆盖」是自相矛盾的（这次覆盖就是要覆盖本地）'
    );
  });
});
