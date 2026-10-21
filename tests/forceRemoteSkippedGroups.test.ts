// 覆盖下载 + 「云端这轮读不出来的那几组」（2026-10-20 D-6）。
//
// ── 本文件在防什么回归 ───────────────────────────────────────────────────
//
// 云端下行时，有些会话**整组读不出来**会被跳过（形状不可恢复 / 还原率不达标 /
// tabs 表被网关截断 / 单组处理异常，见 src/utils/supabase/download.ts）。
// 这些组的**云端行仍在**（一个字节都没被动过），但它们**不在下载结果里**。
//
// 缺陷本体（引擎层「只消费下载结果」）：
//   覆盖下载（forceRemote）把 localGroups 整体置空 ⇒ 那几组**根本没进**
//   mergedGroups ⇒
//     · 删除熔断量的是「合并结果里被剔除的」⇒ 看不见这类丢失；
//     · `removedGroupIds` 为空 ⇒ **不**登记删除广播 ⇒ 云端行也不被标记；
//     · `setGroupsImmediate(finalGroups)` ⇒ 本机那一份被**物理删除**；
//     · `success: true` ⇒ 界面报成功 ⇒ 用户唯一可见信号是「列表变短了」。
//   而 1.22.0 起删除即物理清除、无回收站 ⇒ 一次覆盖下载就足以永久清掉用户
//   仅存于本机的那一份；再叠加一次覆盖上传（先 DELETE 云端全部行）云端那份也没了。
//
// 对照：自带存储后端在同样情形下是 **fail-closed** 的（不可读分片 → 收集 →
// 整轮抛错，中止合并以免把本地对应会话判成「云端已删除」）。只有云端后端是
// 「静默少读」—— 那正是这里要补上的事实出口。
//
// ── 断言钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
// 每条断言问的是「用户的数据会怎样」，而不是「代码里出现了哪个字符串」。
// 这样改实现（换写法、换措辞）不会把守卫变成负担，而**改坏**（回到缺陷形态）
// 一定会红。
//
// ── 装置说明 ─────────────────────────────────────────────────────────────
//
// 真 SyncEngine + 真 storage + 后端替身（tests/_helpers/fakeSyncBackend.ts
// 的同款思路，但这里要能**逐轮**给「读到的」与「读不出来的」两份清单，所以
// 自己造一个可编程的替身）。刻意**不**用源码结构断言：那类断言只能证明
// 「代码长什么样」，证明不了「用户的数据会怎样」—— 而这正是本缺陷的性质。
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// ══════════════════════════════════════════════════════════════════════════
// 可编程的后端替身
// ══════════════════════════════════════════════════════════════════════════

/** 一条「读不出来」的记录。形状与端口的 DownloadSkippedGroup 一致。 */
interface SkippedRow {
  id: string;
  reason: string;
}

/**
 * 后端替身。
 *
 * `skipped` 刻意做成**可选能力**：默认的替身（没有这个方法）模拟的是
 * 「不产生跳过的后端」（自带存储、测试替身）—— 那条路径必须照常成功。
 * `withSkipCapability = true` 时才提供 `downloadSkippedGroups()`。
 */
function makeBackend(opts?: {
  groups?: unknown[];
  skipped?: SkippedRow[];
  /** 是否提供 downloadSkippedGroups 方法（模拟「后端不产生跳过」） */
  withSkipCapability?: boolean;
  /** 让 downloadSkippedGroups 抛错（模拟「事实未知」） */
  skipThrows?: boolean;
  /** 记录上传/广播，用于断言「云端行没被动过」 */
}) {
  const calls = {
    downloadGroups: 0,
    uploadGroups: [] as Array<{ ids: string[]; overwriteRemote: boolean }>,
    broadcastDeletes: [] as string[][],
    downloadSkippedGroups: 0,
  };

  const base: Record<string, unknown> = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      calls.downloadGroups += 1;
      return opts?.groups ?? [];
    },
    async uploadGroups(groups: Array<{ id: string }>, uploadOpts?: { overwriteRemote?: boolean }) {
      calls.uploadGroups.push({
        ids: groups.map(g => g.id),
        overwriteRemote: uploadOpts?.overwriteRemote === true,
      });
      return {
        writtenIds: groups.map(g => g.id),
        overwroteRemote: uploadOpts?.overwriteRemote === true,
      };
    },
    async broadcastDeletes(ids: string[]) {
      calls.broadcastDeletes.push([...ids]);
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
  };

  if (opts?.withSkipCapability) {
    base.downloadSkippedGroups = async () => {
      calls.downloadSkippedGroups += 1;
      if (opts?.skipThrows) throw new Error('模拟：清单读不到');
      return opts?.skipped ?? [];
    };
  }

  return { backend: base, calls };
}

// ══════════════════════════════════════════════════════════════════════════
// 装置
// ══════════════════════════════════════════════════════════════════════════

/** 当前装着的后端替身（每个用例重装）。 */
let current: ReturnType<typeof makeBackend>;

/** 把替身装进 @/sync-backend（必须在被测模块被 import 之前完成）。 */
async function install(backend: unknown): Promise<void> {
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(backend as never);
}

/** 读本地磁盘真值（绕开 30s 缓存）。 */
async function localGroups(): Promise<Array<{ id: string; tabs: unknown[] }>> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  return storage.getGroups() as never;
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
  // ⚠️ 必须显式种 syncBackend:'webdav'：downloadAndMerge 开头按
  // readConfiguredBackendId() 决定查不查 Supabase 账号。读不到设置时它返回
  // null ⇒ downloadAndMerge 在任何闸门之前就返回 backend_unknown ⇒ 用例
  // 变成永远为绿的假通过（同样的坑见 forceRemoteEmptyCloudGate.test.ts）。
  await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  invalidateGroupsCache();
  current = makeBackend();
  await install(current.backend);
});

// ══════════════════════════════════════════════════════════════════════════
// 一、云端有一组读不出来 + 覆盖下载 ⇒ 本机那一份必须还在
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖下载：云端读不出来的那几组，本机那一份必须保住', () => {
  it('被跳过的组在本机仍然存在（修复前它被物理删除）', async () => {
    // 本机：两组（其中 local-skipped 是云端读不出来的那组）
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('local-skipped'),
      mkGroup('local-ok'),
    ] as never);
    invalidateGroupsCache();

    // 云端：只有 local-ok 读得出来；local-skipped 读不出来（整组跳过）。
    // 云端**没有** local-skipped 这一行 —— 它在云端仍然存在，只是没读到。
    current = makeBackend({
      withSkipCapability: true,
      groups: [mkGroup('local-ok')],
      skipped: [{ id: 'local-skipped', reason: 'restore_ratio' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const after = await localGroups();
    const kept = after.find(g => g.id === 'local-skipped');
    assert.ok(
      kept,
      '云端那份读不出来时，本机那一份必须还在 —— ' +
        '「云端说了算」的前提是我们确实拿到了云端那一份；拿「不知道」冒充「云端没有」= 物理删除'
    );
    assert.equal(
      kept!.tabs.length,
      1,
      '保住的是本机**完好**的那一份，不是被清空后的空壳'
    );
  });

  it('被跳过的组不进删除广播队列（云端行不动 ⇒ 不被标记删除）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-skipped')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'local-skipped', reason: 'unreadable_shape' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge({ forceRemote: true });

    const { storage: st } = await import('@/utils/storage');
    assert.deepEqual(
      await st.getPendingDeleteIds(),
      [],
      '被跳过的组绝不能进删除广播队列 —— ' +
        '1.22.0 起无回收站 = 云端行一旦被打上墓碑就是永久删除'
    );
  });

  it('云端行仍原封保留：下载路径从不写云端（不上传、不广播删除）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-skipped')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'local-skipped', reason: 'tabs_table_truncated' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.deepEqual(
      current.calls.uploadGroups,
      [],
      '下载路径绝不能上传（覆盖上传会先 DELETE 云端全部行 ⇒ 把没读到的那些行永久删掉）'
    );
    assert.deepEqual(
      current.calls.broadcastDeletes,
      [],
      '下载路径绝不能广播删除（那会把「没读到」翻译成「云端已删除」）'
    );
  });

  it('被跳过的组本机那份是**空壳**时 ⇒ 也绝不能进删除广播队列（第二道门）', async () => {
    // 这条守的是**另一条独立的路径**：保护它不被「整份覆盖写」物理删除
    // 还不够 —— 若本机那一份恰好零标签，空壳清理（dropSyncMergedGroups）
    // 会把它剔掉 ⇒ 它进 removedGroupIds ⇒ **被登记进 pendingDeleteIds**
    // ⇒ 云端那一行被打墓碑 ⇒ 「云端只是这轮没读到」的会话被永久删除。
    // 两道门都要守住。
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-skipped', { tabs: [] })] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'local-skipped', reason: 'unreadable_shape' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const { storage: st } = await import('@/utils/storage');
    assert.deepEqual(
      await st.getPendingDeleteIds(),
      [],
      '被跳过的组即使本机那份是空壳，也绝不能被登记成删除广播 —— ' +
        '那等于把「云端只是没读到」翻译成「云端已删除」（1.22.0 起无回收站）'
    );
  });

  it('合并模式（forceRemote=false）下，被跳过的组同样不进删除广播队列', async () => {
    // 合并模式下被跳过的组本来就在合并结果里（云端那份没读到 ⇒ 保留本地），
    // 但**空壳清理**这条路对它一视同仁 ⇒ 同样的漏洞，同样的第二道门。
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-skipped', { tabs: [] })] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'local-skipped', reason: 'restore_ratio' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge();

    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    const { storage: st } = await import('@/utils/storage');
    assert.deepEqual(
      await st.getPendingDeleteIds(),
      [],
      '合并模式下被跳过的组也绝不能进删除广播队列（同一道门，两条路径）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、别把保护做过头：云端墓碑掉的组在覆盖下载后**确实被删**
// ══════════════════════════════════════════════════════════════════════════

describe('保护只针对「读不出来」：云端墓碑掉的组照常被删', () => {
  it('云端墓碑行（is_deleted）⇒ 覆盖下载后本机那份被删除', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('deleted-elsewhere'),
      mkGroup('kept-elsewhere'),
    ] as never);
    invalidateGroupsCache();

    // 云端：deleted-elsewhere 是墓碑行（另一台设备删了）⇒ 覆盖下载必须服从删除。
    current = makeBackend({
      withSkipCapability: true,
      groups: [
        mkGroup('deleted-elsewhere', { isDeleted: true, tabs: [] }),
        mkGroup('kept-elsewhere'),
      ],
      skipped: [],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);
    const after = await localGroups();
    assert.equal(
      after.some(g => g.id === 'deleted-elsewhere'),
      false,
      '云端墓碑是**删除广播**，不是「跳过」⇒ 必须照常执行删除（保护过头 = 删不掉）'
    );
    assert.equal(
      after.some(g => g.id === 'kept-elsewhere'),
      true,
      '云端有的组必须落到本机'
    );
  });

  it('「跳过」与「墓碑」是两件事：同一轮里两者各自按自己的语义走', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('skipped-one'),
      mkGroup('tombstoned-one'),
    ] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [mkGroup('tombstoned-one', { isDeleted: true, tabs: [] })],
      skipped: [{ id: 'skipped-one', reason: 'processing_error' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);
    const after = await localGroups();
    assert.equal(
      after.some(g => g.id === 'skipped-one'),
      true,
      '读不出来的那组必须保住'
    );
    assert.equal(
      after.some(g => g.id === 'tombstoned-one'),
      false,
      '云端墓碑掉的那组必须被删'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、如实上报
// ══════════════════════════════════════════════════════════════════════════

describe('MergeResult 必须如实带上「云端有几组读不出来」', () => {
  it('count 等于被跳过的组数，ids 是它们的 id 清单', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('s1'), mkGroup('s2')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [
        { id: 's1', reason: 'unreadable_shape' },
        { id: 's2', reason: 'restore_ratio' },
      ],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.ok(result.skippedRemoteGroups, '必须如实上报（否则界面只能报成功，用户只看到列表变短）');
    assert.equal(
      result.skippedRemoteGroups!.count,
      2,
      'count 必须等于被跳过的组数（不多报不少报）'
    );
    assert.deepEqual(
      [...result.skippedRemoteGroups!.ids].sort(),
      ['s1', 's2'],
      'ids 必须点名是哪几组（诊断用）'
    );
  });

  it('没有会话被跳过 ⇒ 不带这个字段（UI 据此「一个字都不多说」）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('g1')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [mkGroup('g1')],
      skipped: [],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true);
    assert.equal(
      result.skippedRemoteGroups,
      undefined,
      '没跳过任何会话时不该带这个字段（带 count:0 会让界面弹「0 个会话读不出来」）'
    );
  });

  it('这一轮没有硬失败 ⇒ success 保持 true（说成失败会把用户导向无意义的重试）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('s1')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 's1', reason: 'unreadable_shape' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.success,
      true,
      '重试不会变好（云端那行还是读不出来）⇒ success:false 会让界面弹「请重试」并让用户一直重试'
    );
    assert.equal(result.skippedRemoteGroups?.count, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、后端没有 downloadSkippedGroups 方法时（WebDAV / 测试替身）
// ══════════════════════════════════════════════════════════════════════════

describe('后端不产生跳过（没有该方法）⇒ 同步照常成功', () => {
  it('方法不存在 ⇒ 覆盖下载照常成功，不报错、不中断', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('g1')] as never);
    invalidateGroupsCache();

    // 关键：**不提供** downloadSkippedGroups（模拟 WebDAV 与老测试替身）。
    current = makeBackend({ groups: [mkGroup('g1')] });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.success,
      true,
      `同步必须照常成功（实得：${result.reason ?? '无'}）—— ` +
        '把「这个后端不产生跳过」当成故障会打死所有自带存储用户'
    );
    assert.equal(
      result.skippedRemoteGroups,
      undefined,
      '没有跳过 ⇒ 不带这个字段'
    );
    const after = await localGroups();
    assert.equal(after.some(g => g.id === 'g1'), true, '本地数据照常按云端镜像落盘');
  });

  it('方法不存在 + 覆盖模式 ⇒ 覆盖语义照常（本地置空，云端说了算）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-only')] as never);
    invalidateGroupsCache();

    current = makeBackend({ groups: [mkGroup('g1')] });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(result.success, true);
    const after = await localGroups();
    assert.deepEqual(
      after.map(g => g.id),
      ['g1'],
      '没有跳过清单时，覆盖语义必须照常生效（云端完全镜像本地）'
    );
  });

  it('方法存在却抛错 ⇒ 事实未知 ⇒ 本轮中止，一个字节都不写（fail-closed）', async () => {
    // 「拿不到清单」与「清单是空的」是**两件不同的事**：
    //   · 空清单 = 这个后端本轮确实没跳过任何会话（事实）；
    //   · 拿不到  = 「本轮哪些组被跳过」这个问题没有答案（未知）。
    // 在覆盖模式下拿「未知」去覆盖本地 = 把「可能只是没读到」的会话删掉 ⇒
    // 必须中止（fail-closed），并如实报失败。
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-1')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [mkGroup('local-1')],
      skipped: [],
      skipThrows: true,
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.success,
      false,
      '清单读不到 = 事实未知 ⇒ 必须中止（继续就是拿「不知道」冒充「云端没有」）'
    );
    const after = await localGroups();
    assert.equal(
      after.some(g => g.id === 'local-1'),
      true,
      '中止时本地一个字节都不许动'
    );
  });

  it('读取顺序：必须先 downloadGroups 再 downloadSkippedGroups（同轮保证）', async () => {
    // 为什么顺序有语义：云端后端把「本轮跳过的清单」记在**下载那一次**里
    // （supabase/download.ts 的 lastDownloadSkipped）。先问清单再下载 ⇒
    // 拿到的是**上一轮**的清单（或空）⇒ 引擎以为「这轮没跳过任何组」
    // ⇒ 覆盖下载照常清掉本机那几份 —— 正是本文件要防的那场数据丢失。
    //
    // 这条断言钉的是**调用顺序**这个不变量，不是某个实现细节。
    const order: string[] = [];
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('g1')] as never);
    invalidateGroupsCache();

    const backend = {
      id: 'webdav',
      label: '顺序探针',
      async fetchFingerprints() {
        return [];
      },
      async downloadGroups() {
        order.push('downloadGroups');
        return [mkGroup('g1')];
      },
      async downloadSkippedGroups() {
        order.push('downloadSkippedGroups');
        return [];
      },
      async uploadGroups() {
        return { writtenIds: [] };
      },
      async broadcastDeletes() {
        /* 不该被调用 */
      },
      async purgeExpiredDeletes() {
        return 0;
      },
      async uploadSettings() {
        /* 不该被调用 */
      },
      async downloadSettings() {
        return null;
      },
    };
    await install(backend);

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.deepEqual(
      order,
      ['downloadGroups', 'downloadSkippedGroups'],
      '必须先下载、再问「这轮哪些没读到」—— 顺序反了拿到的就是上一轮的清单'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 五、空云端闸门的判据不能被「跳过」扭曲
// ══════════════════════════════════════════════════════════════════════════

describe('空云端闸门：云端「有行但没读到」≠ 云端是空的', () => {
  it('云端唯一的一组读不出来 ⇒ 不得按「云端为空」拒绝覆盖（那句文案是假的）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-1')] as never);
    invalidateGroupsCache();

    // 云端有 1 行（我们没读到）⇒ 云端**不是空的**。
    // 若闸门按「读到的条数」判 ⇒ cloudTotalCount === 0 ⇒ 拒绝覆盖 ⇒
    // 对用户说「云端没有任何数据，已中止覆盖以免清空本机会话」——
    // 而云端明明有那一组。那句话是假的。
    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'only-cloud-row', reason: 'unreadable_shape' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.notEqual(
      result.reason,
      'overwrite_empty_cloud_refused',
      '云端有行（只是没读到）⇒ 不得按「云端为空」拒绝（那句「云端没有任何数据」是假的）'
    );
  });

  it('云端真的一个字节都没有 ⇒ 仍然必须拒绝覆盖（既有保护不许被削弱）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-1')] as never);
    invalidateGroupsCache();

    current = makeBackend({ withSkipCapability: true, groups: [], skipped: [] });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });

    assert.equal(
      result.reason,
      'overwrite_empty_cloud_refused',
      '云端真的一行都没有 ⇒ 拿它覆盖会清空本机且不可逆（1.22.0 起无回收站）'
    );
    const after = await localGroups();
    assert.equal(
      after.some(g => g.id === 'local-1'),
      true,
      '拒绝时本地一个字节都不许动'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 六、SW 回包必须把这件事带出去
// ══════════════════════════════════════════════════════════════════════════

describe('SW 的下载回包必须带上 skippedRemoteGroups', () => {
  it('SW 的下载分支整体回传 payload（界面才读得到这个字段）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(resolve(ROOT, 'src/service-worker.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const at = src.indexOf("if (data.op === 'download')");
    assert.ok(at > 0, '必须找到 SW 的下载分支');
    const seg = src.slice(at, at + 1200);
    assert.match(
      seg,
      /payload:\s*r/,
      '下载分支必须整体回传 MergeResult（skippedRemoteGroups 就在里面；削掉 payload = 这件事退回「只写进日志」）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 七、覆盖上传之后，云端被跳过的那些行必须还在
//
// ── 为什么这条必须单独钉 ────────────────────────────────────────────────
//
// 覆盖上传（`overwriteCloud: true`）在 Supabase 后端是**先删光再写回**：
//   `delete().eq('user_id', userId)` 把该用户的全部行删掉，
//   然后 upsert 本地这一批。
//
// 于是有个二阶风险：被跳过的组如果**不在**上传清单里，
// 它在云端的那一行会被删掉之后**再也写不回来** ⇒ 永久丢失。
//
// 链条是这样闭合的：
//   1. 覆盖下载时，被跳过的组以「本机那一份」进入合并结果
//      （`mergeOpStamped` 对「只有本地有」的那组直接 push 本地那份）；
//   2. 合并结果写回本地 ⇒ 本地现在有「云端读到的组」+「被跳过的组」；
//   3. 覆盖上传时 `groupsForUpload = allGroups`（覆盖模式上传全部活跃组）
//      ⇒ 被跳过的那几组**在清单里** ⇒ 被重新 upsert 回云端。
//
// 第 3 步是这条测试要证的：**被跳过的组必须出现在覆盖上传的清单里**。
// 少了它，被跳过的组在云端那一行就真的没了 —— 而上一节的用例全部照绿
// （它们只看「本机还在」和「不进删除广播」，看不到云端那一行是否还在）。
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖上传后：云端被跳过的那些行必须还在', () => {
  it('被跳过的组出现在覆盖上传的清单里（否则云端那一行被删掉后写不回来）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('local-skipped'),
      mkGroup('local-ok'),
    ] as never);
    invalidateGroupsCache();

    // 云端：local-ok 读得出来；local-skipped 这轮读不出来（整组跳过）。
    current = makeBackend({
      withSkipCapability: true,
      groups: [mkGroup('local-ok')],
      skipped: [{ id: 'local-skipped', reason: 'restore_ratio' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');

    // ── 第 1 步：覆盖下载 ⇒ 被跳过的组以「本机那一份」活下来 ─────────
    const download = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(download.success, true, `前提：下载必须成功（实得：${download.reason ?? '无'}）`);

    const afterDownload = await localGroups();
    assert.ok(
      afterDownload.some(g => g.id === 'local-skipped'),
      '前提：被跳过的组在下载后必须还在本地'
    );

    // ── 第 2 步：覆盖上传 ⇒ 被跳过的组必须在上传清单里 ───────────────
    current.calls.uploadGroups.length = 0;
    await syncEngine.upload({ overwriteCloud: true, forcePending: true });

    const overwriteCalls = current.calls.uploadGroups.filter(c => c.overwriteRemote);
    assert.ok(
      overwriteCalls.length > 0,
      '前提：这一轮必须真的走了覆盖上传（overwriteRemote=true）'
    );

    const uploadedIds = new Set(overwriteCalls.flatMap(c => c.ids));
    assert.ok(
      uploadedIds.has('local-skipped'),
      '被跳过的组不在覆盖上传的清单里 ⇒ 云端那一行被 DELETE 掉之后' +
        '再也写不回来 ⇒ 永久丢失（1.22.0 起无回收站）'
    );
    assert.ok(
      uploadedIds.has('local-ok'),
      '云端读到的组也必须在清单里（否则覆盖上传把云端清空了）'
    );
  });

  it('被跳过的组不会被登记进删除广播（它的云端行不该被打墓碑）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('local-skipped')] as never);
    invalidateGroupsCache();

    current = makeBackend({
      withSkipCapability: true,
      groups: [],
      skipped: [{ id: 'local-skipped', reason: 'restore_ratio' }],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge({ forceRemote: true });
    await syncEngine.upload({ overwriteCloud: true, forcePending: true });

    const broadcast = current.calls.broadcastDeletes.flat();
    assert.ok(
      !broadcast.includes('local-skipped'),
      '被跳过的组被登记进了删除广播 ⇒ 云端那一行会被打上墓碑 ⇒ 永久删除'
    );
  });
});
