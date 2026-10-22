// 下载路径剥离本机老版本墓碑组时**必须登记删除广播**（2026-10-20 D-8）。
//
// ── 本文件在防什么回归 ───────────────────────────────────────────────────
//
// 场景（老版本设备留下的残留形状）：
//   · 本机 storage 里有一个组，`isDeleted === true`（v1.21 老模型留下的组级墓碑）。
//   · 云端那一行是**活跃**的（那份删除意图从未送达云端：老版本可能压根没广播，
//     或者广播失败后设备换了一台）。
//
// 下载路径（`syncEngine.downloadAndMerge`）在合并**之前**就把本机的墓碑组
// filter 掉了（本地不留墓碑，见 syncEngine 文件头「无墓碑模型」）。
// 缺陷本体：**剥掉的时候没有登记一次删除广播** ⇒
//   · 云端那一行仍然是活跃的；
//   · 下一轮下载合并时它以「云端有、本地无」的身份**整组复活**
//     （mergeOpStamped 的 `cg && !lg` 分支）⇒
//   · 那个「本机已经删掉的会话」在所有设备上又回来了；用户看不到任何提示。
//
// 为什么它躲过了既有的删除广播登记：
//   登记走的是 `removedGroupIds(mergedGroups, finalGroups)` ——
//   而墓碑组在**进合并之前**就被 filter 掉了，它压根不在 mergedGroups 里 ⇒
//   removedGroupIds 看不见它 ⇒ 队列里永远没有它 ⇒ 广播永远不发。
//
// ── 断言钉的是**不变量 / 用户可见的后果**，不是字面量 ────────────────────
//
// 钉的三个后果：
//   ① 云端真的收到了这一组的删除广播（= 队列登记 + pending_upload 置位
//      + 上传轮真的把它发出去，整条链路的**终点**）；
//   ② 本机不再留着组级墓碑（无墓碑模型）；
//   ③ 下一轮下载时那个组不再回来（**用户真正关心的**：「我删掉的会话
//      怎么又出现了」）。
//
// ⚠️ 为什么不直接断言「此刻队列里还有它」：
//   下载完成后引擎自己会调度一次上传（syncEngine 的「下载完成但本地仍有
//   未上传变更 → 重新调度上传」），那次上传会消费掉删除广播队列并清掉
//   pending_upload ⇒ 「此刻队列里还有它」这条断言在跟竞态打架，
//   钉不住真正的性质。这里改成钉**终点**（广播确实发出去了），它对
//   「什么时候发」不敏感。
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

function makeBackend(opts?: { groups?: unknown[] }) {
  const calls = {
    downloadGroups: 0,
    uploadGroups: [] as Array<{ ids: string[]; overwriteRemote: boolean }>,
    broadcastDeletes: [] as string[][],
  };

  const backend: Record<string, unknown> = {
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
      // 端口契约（2026-10-23 R-1）：必须回报「哪些真的广播了、哪些被账号闸门挡下」。
      // 自带存储（WebDAV）不按账号分行 ⇒ 全部放行。
      return { broadcastIds: [...ids], blockedIds: [] };
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

  return { backend, calls };
}

let current: ReturnType<typeof makeBackend>;

async function install(backend: unknown): Promise<void> {
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(backend as never);
}

/** 全部已广播的删除 id（跨轮累计）。 */
const broadcasted = (): string[] => current.calls.broadcastDeletes.flat();

/**
 * 等到某个 id 真的被广播出去（最多 3 秒）。
 *
 * 为什么用轮询而不是直接查队列：下载完成后引擎会自己排一次上传，那次上传
 * 会消费队列 ⇒ 「队列里还有它」在下载返回后可能已经过期。而「广播出去了」
 * 是**终点**，无论中间隔了几轮、什么时候发，它都成立。
 */
async function waitForBroadcast(id: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (broadcasted().includes(id)) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return broadcasted().includes(id);
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
  // 上一次用例的上传会把 last_upload_time 刷新到「刚刚」⇒ 下一个用例的
  // 下载被 recent_upload_guard（35s 保护窗口）直接跳过 ⇒ 用例之间互相污染，
  // 表现成「有的用例莫名其妙 success:false」。把上传时间推到窗口之外，
  // 并清掉待上传标志，让每个用例都从同一起点开始。
  await storage.setLastUploadTime(new Date(Date.now() - 120_000).toISOString());
  await storage.setPendingUpload(false);
  invalidateGroupsCache();
  current = makeBackend();
  await install(current.backend);
});

// ══════════════════════════════════════════════════════════════════════════
// 一、剥掉老版本墓碑组 ⇒ 云端必须真的知道这组被删了
// ══════════════════════════════════════════════════════════════════════════

describe('下载路径剥离本机老版本墓碑组：云端必须知道这组被删了', () => {
  it('这组的删除意图真的广播到了云端（修复前：本地剥掉、云端毫不知情 ⇒ 下一轮整组复活）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    // 本机：老版本留下的组级墓碑 + 一个正常活跃组
    await storage.setGroupsImmediate([
      mkGroup('legacy-tomb', { isDeleted: true }),
      mkGroup('alive'),
    ] as never);
    invalidateGroupsCache();

    // 云端：legacy-tomb 那一行是**活跃**的（删除意图从未上过云）
    current = makeBackend({
      groups: [mkGroup('legacy-tomb'), mkGroup('alive')],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge();
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    assert.ok(
      await waitForBroadcast('legacy-tomb'),
      '本机被剥掉的老版本墓碑组，它的删除意图必须真的广播到云端 —— ' +
        '不广播的话云端那一行仍是活跃的，下一轮下载合并它以「云端有、本地无」' +
        '的身份整组复活（= 本缺陷）'
    );
  });

  it('本机不再留着组级墓碑（无墓碑模型：本地不留墓碑）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('legacy-tomb', { isDeleted: true }),
      mkGroup('alive'),
    ] as never);
    invalidateGroupsCache();

    current = makeBackend({
      groups: [mkGroup('legacy-tomb'), mkGroup('alive')],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge();

    assert.equal(
      (result.groups ?? []).some(g => g.id === 'legacy-tomb' && g.isDeleted === true),
      false,
      '本机不留组级墓碑（无墓碑模型）—— 前提：这条路径确实剥掉了它'
    );
    assert.ok(
      (result.groups ?? []).some(g => g.id === 'alive'),
      '正控：正常活跃组不受影响'
    );
  });

  it('下一轮下载时那个组不再回来（用户真正关心的：删掉的会话不许复活）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('legacy-tomb', { isDeleted: true }),
      mkGroup('alive'),
    ] as never);
    invalidateGroupsCache();

    // 第一轮：云端那一行还是活跃的
    current = makeBackend({
      groups: [mkGroup('legacy-tomb'), mkGroup('alive')],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const first = await syncEngine.downloadAndMerge();
    assert.equal(first.success, true, `前提：这一轮必须成功（实得：${first.reason ?? '无'}）`);
    assert.ok(
      await waitForBroadcast('legacy-tomb'),
      '前提：删除意图必须先真的广播到云端（否则第二轮的墓碑行无从谈起）'
    );

    // 第一轮结束时引擎排了一次自动上传 ⇒ last_upload_time 被刷新到「刚刚」
    // ⇒ 第二轮会被 recent_upload_guard（35s 保护窗口）跳过。把上传时间推到
    // 窗口之外，让第二轮真的走完整流程。
    await (await import('@/utils/storage')).storage.setLastUploadTime(
      new Date(Date.now() - 120_000).toISOString()
    );

    // 第二轮：云端那一行已经是墓碑（别的设备已经知道它被删了）
    current = makeBackend({
      groups: [
        mkGroup('legacy-tomb', { isDeleted: true, tabs: [], lastOp: { d: 'dev-cloud', s: 99 } }),
        mkGroup('alive'),
      ],
    });
    await install(current.backend);

    const second = await syncEngine.downloadAndMerge();
    assert.equal(second.success, true, `前提：第二轮必须成功（实得：${second.reason ?? '无'}）`);
    assert.equal(
      (second.groups ?? []).some(g => g.id === 'legacy-tomb'),
      false,
      '云端已经是墓碑了，本机那一份必须被删掉 —— ' +
        '「我明明删了它，怎么又出现了」就是这个缺陷'
    );
    assert.ok(
      (second.groups ?? []).some(g => g.id === 'alive'),
      '正控：别的会话不受影响'
    );
  });

  it('本机没有任何老版本墓碑组时，不产生多余的删除广播（别把正常组误删）', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([mkGroup('alive')] as never);
    invalidateGroupsCache();

    current = makeBackend({ groups: [mkGroup('alive')] });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.downloadAndMerge();

    // 给自动调度的那次上传留出时间
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(
      broadcasted(),
      [],
      '没有老版本墓碑组时不得凭空登记删除广播 —— ' +
        '误登记 = 把用户还想要的会话永久删掉（1.22.0 起无回收站）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、别把保护做过头：同 id 还有活跃副本时不得广播删除
// ══════════════════════════════════════════════════════════════════════════

describe('保护只针对「唯一的证据是墓碑」：同 id 还有活跃副本时不广播删除', () => {
  it('同 id 既有墓碑又有活跃副本时，不得把删除意图发出去', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    // 老版本的脏数据可能留下同 id 的两条：一条墓碑、一条活跃。
    // 活跃那份才是真相（合并结果里它会留下来）—— 若把墓碑的删除意图广播出去，
    // 等于把用户还想要的会话在所有设备上永久删掉（1.22.0 起无回收站）。
    await storage.setGroupsImmediate([
      mkGroup('dup', { isDeleted: true }),
      mkGroup('dup'),
      mkGroup('alive'),
    ] as never);
    invalidateGroupsCache();

    current = makeBackend({ groups: [mkGroup('dup'), mkGroup('alive')] });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge();
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(
      broadcasted(),
      [],
      '同 id 还有活跃副本时不得广播删除 —— 那会把用户还想要的会话永久删掉'
    );
    assert.ok(
      (result.groups ?? []).some(g => g.id === 'dup' && g.isDeleted !== true),
      '正控：活跃副本必须留下来'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、覆盖模式（forceRemote）下同样要登记
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖下载同样要让云端知道老版本墓碑组被删了', () => {
  it('forceRemote 下剥掉的墓碑组也真的广播到云端', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    await storage.setGroupsImmediate([
      mkGroup('legacy-tomb', { isDeleted: true }),
      mkGroup('alive'),
    ] as never);
    invalidateGroupsCache();

    current = makeBackend({
      groups: [mkGroup('legacy-tomb'), mkGroup('alive')],
    });
    await install(current.backend);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.downloadAndMerge({ forceRemote: true });
    assert.equal(result.success, true, `前提：这一轮必须成功（实得：${result.reason ?? '无'}）`);

    assert.ok(
      await waitForBroadcast('legacy-tomb'),
      '覆盖下载剥掉老版本墓碑组时同样必须广播删除意图（两条路径的语义相同）'
    );
  });
});
