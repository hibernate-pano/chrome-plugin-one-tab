/**
 * DS-43-1 端到端守卫：**换账号之后删掉的会话，删除意图不许被新账号那一轮顺手清掉**。
 *
 * ── 这个文件在防什么回归 ─────────────────────────────────────────────────
 *
 * 缺陷链（审计 R-1）：
 *   A 的会话 X 同步到了 A 的云端 → 用户退出 A、登录 B → 用户删掉 X
 *   → X 的 id 进了删除广播队列 → **B 的下一轮上传**去广播它 →
 *   云端当然没有 B 名下那一行 → 读回校验把「云端没这行」判成「意图已达成」
 *   （missingAsAchieved）→ 删除意图被清出队列 → 用户再登录回 A 时，
 *   A 的云端那一行**还是活跃的** → 下一轮下载合并把 X **整组加回来**
 *   ⇒ 用户看见「我明明删掉的会话又回来了」，全程零提示。
 *
 * ── 为什么单开一个文件（而不是并进 guards/deleteBroadcastAccountGate）──────
 *
 * 那份守卫钉的是**每一层**（判据层 / 写入层 / 消费层），一层一层验。
 * 本文件钉的是**整条往返**：意图被挡下之后**留在队列里**，等它真正的主人账号
 * 登录回来时**真的落到主人的云端**，然后才被清队。
 *
 * 这一半（「等主人登录回来再广播」）是那层守卫没有覆盖的：
 * 只证明「没被清掉」不够 —— 如果它永远留在队列里、永远不广播，
 * 那条会话在**主人**的云端上仍然是活跃的，同样会复活。
 * ⇒ 必须钉到「主人登录回来 ⇒ 墓碑真的落地」这个终点。
 *
 * ── 判据钉的是「用户可见的终点」，不是中间状态 ──────────────────────────
 *
 * ① B 的这一轮上传后：A 的云端那一行**必须还是活跃的**（墓碑没落错地方）、
 *    B 的云端**不许多出**这一行、删除意图**必须还在队列里**。
 * ② 登录回 A 并上传后：A 的云端那一行**必须已经是墓碑**（is_deleted=true）、
 *    队列里那一条**必须被清掉**（真广播过 ⇒ 不许无限重播）。
 *
 * ⚠️ ②里「队列被清掉」这一条是**双向**的：
 *   · 清掉 = 意图真的送达了（否则下一轮又会重播，队列只增不减）；
 *   · 没清掉 = 意图还在（否则用户删了却没删掉，见①）。
 *   两半都钉，才不会出现「清了 ⇒ 复活」或「不清 ⇒ 永远重播」。
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installEngineStorageEnv, mkGroup } from '../_helpers/engineStorageEnv.ts';
import { installFakePostgrestCloud } from '../_helpers/fakePostgrestCloud.ts';
import { stubSessionJson } from '../_helpers/stubSession.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

// 本文件在 tests/guards/ 下 ⇒ 仓库根是两级往上。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

// ⚠️ 必须在任何 '@/…' 的 import 之前装：storage-kv 在首次 import 时选驱动，
// 没有 indexedDB 时回退 localStorage（tests/_helpers/engineStorageEnv.ts 的头注）。
const env = installEngineStorageEnv();

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_A = 'user-a-11111111-1111-4111-8111-111111111111';
const USER_B = 'user-b-22222222-2222-4222-8222-222222222222';
const SESSION_KEY = 'sb-stub-auth-token';
const AUTH_CACHE_KEY = 'auth_cache';
const GROUP_ID = 'g-x';

let cloud: ReturnType<typeof installFakePostgrestCloud>;

/** 假后端每次广播的回报（谁真的广播了 / 谁被账号闸门挡下了）。 */
const backendCalls = {
  broadcastDeletes: [] as string[][],
  results: [] as Array<{ broadcastIds: string[]; blockedIds: string[] }>,
};

/**
 * 假后端：`broadcastDeletes` **转手给真的 Supabase 写入层**
 * （utils/supabase/upload.ts 的 markCloudGroupsAsDeleted）。
 *
 * 【为什么不能自己假装挡下】账号闸门住在真的写入层里（那是全仓唯一真正写
 * `.eq('user_id', userId)` 的地方）。假后端自己返回 blockedIds 只能证明
 * 「引擎按点名清队」，证明不了「闸门真的挡住了别的账号的会话」。
 * ⇒ 这里必须把活交给真的那一层，让它对着假云端真的判一次。
 */
async function installFakeBackend(): Promise<void> {
  const backend = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups(groups: Array<{ id: string }>) {
      return { writtenIds: groups.map(g => g.id) };
    },
    async broadcastDeletes(ids: string[]) {
      const { uploadSync } = await import('@/utils/supabase/upload');
      const result = await uploadSync.markCloudGroupsAsDeleted(ids);
      backendCalls.broadcastDeletes.push([...ids]);
      backendCalls.results.push(result);
      return result;
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 本文件不考设置同步 */
    },
    async downloadSettings() {
      return null;
    },
  };
  const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
  setActiveSyncBackend(backend as never);
}

/** 登录某个账号：写登录态 + 认账「本机会话归谁」。 */
async function signInAs(userId: string): Promise<void> {
  env.chromeData.set(AUTH_CACHE_KEY, {
    user: { id: userId },
    isAuthenticated: true,
    timestamp: Date.now(),
  });
  env.chromeData.set(SESSION_KEY, stubSessionJson(userId));
  cloud.setSessionUser(userId);
  const { bindLocalSessionsToAccount } = await import('@/store/slices/authSlice');
  await bindLocalSessionsToAccount(userId);
}

/** 退出登录：先记下「本机会话属于谁」，再清登录态（DS-1 的第一环）。 */
async function signOut(): Promise<void> {
  const { authCache } = await import('@/utils/authCache');
  await authCache.clearAuthState();
  env.chromeData.delete(SESSION_KEY);
}

/** 本机有一个会话（用户看得见的那种）。 */
async function seedLocalGroup(id: string): Promise<void> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  await storage.setGroupsImmediate([mkGroup(id)] as never);
  invalidateGroupsCache();
}

/** 云端（账号 A 名下）有一行活跃的会话。 */
function seedCloudRow(id: string, userId: string): void {
  cloud.rows.set(id, {
    id,
    user_id: userId,
    name: `会话 ${id}`,
    tabs_data: '[]',
    is_deleted: false,
    last_op_seq: 5,
    last_op_device: 'dev-a',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  });
}

/** 用户删掉一个会话：本地物理移除 + 登记删除广播意图。 */
async function deleteLocalSession(id: string): Promise<void> {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  const groups = await storage.getGroupsForWrite();
  await storage.setGroupsImmediate(groups.filter(g => g.id !== id) as never);
  invalidateGroupsCache();
  await storage.addPendingDeleteIds([id]);
}

/** 跑一轮真实上传（真引擎 + 真消费逻辑 + 真写入层对着假云端）。 */
async function runUpload(): Promise<{ success: boolean; error?: string }> {
  const { syncEngine } = await import('@/services/syncEngine');
  const result = await syncEngine.upload();
  // 引擎可能在上传结束后自己再排一轮；给那一轮留出时间，免得断言跟它打架。
  await new Promise(r => setTimeout(r, 300));
  return result;
}

/** 删除队列里现在还剩哪些意图。 */
async function pendingDeleteIds(): Promise<string[]> {
  const { storage } = await import('@/utils/storage');
  return storage.getPendingDeleteIds();
}

before(async () => {
  register(LOADER_PATH);
});

after(async () => {
  cloud?.restore();
  const { resetActiveSyncBackend } = await import('@/sync-backend/index.ts');
  resetActiveSyncBackend();
});

beforeEach(async () => {
  // 本机状态清零：localStorage（KV）+ chrome.storage.local（登录态 / 归属记录）。
  env.lsData.clear();
  env.chromeData.clear();
  env.failReadKeys.clear();
  env.failWriteKeys.clear();
  backendCalls.broadcastDeletes.length = 0;
  backendCalls.results.length = 0;

  cloud?.restore();
  cloud = installFakePostgrestCloud();

  const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
  await storage.setOpStampMigrated(true);
  await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  await storage.setLastUploadTime(new Date(Date.now() - 120_000).toISOString());
  await storage.setPendingUpload(false);
  invalidateGroupsCache();
  const left = await storage.getPendingDeleteIds();
  if (left.length > 0) await storage.retractPendingDeleteIds(left);

  await installFakeBackend();
});

// ══════════════════════════════════════════════════════════════════════════
// 场景一：换账号之后才删（用户看得见的路径）
// ══════════════════════════════════════════════════════════════════════════

describe('换账号之后删掉的会话：意图必须留在队列里，等主人登录回来再广播', () => {
  /** 跑到「B 已经登录、并且已经删掉了那个会话」这一步。 */
  async function runUpToDeleteUnderB(): Promise<void> {
    await seedLocalGroup(GROUP_ID);
    seedCloudRow(GROUP_ID, USER_A);
    await signInAs(USER_A); // A 登录：会话归 A
    await signOut(); // 退出 A：记下「本机会话属于 A」
    await signInAs(USER_B); // 登录 B：换账号 ⇒ 那个会话认账给 A
    await deleteLocalSession(GROUP_ID); // 用户在 B 下删掉了它
  }

  it('B 的这一轮上传：不得写进 B 的云端，也不得把这条意图清出队列', async () => {
    await runUpToDeleteUnderB();

    const result = await runUpload();
    assert.equal(
      result.success,
      true,
      `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`
    );

    // ① A 的云端那一行必须还是活跃的：墓碑不能落在别人的账号下。
    assert.equal(
      cloud.rows.get(GROUP_ID)?.is_deleted,
      false,
      'A 的云端那一行必须还是活跃的 —— 墓碑是 A 的删除意图，只能落在 A 名下'
    );
    // ② B 的云端不许多出这一行。
    assert.equal(
      cloud.rows.get(GROUP_ID)?.user_id,
      USER_A,
      '当前账号（B）的云端不许多出这一行 —— 别的账号的会话不该被写进 B 的库'
    );
    // ③ 删除意图必须还在队列里（这是「等主人登录回来再广播」的前提）。
    assert.ok(
      (await pendingDeleteIds()).includes(GROUP_ID),
      '这条删除意图必须**留在队列里** —— 清掉它等于把意图永久丢掉 ⇒ ' +
        '那条会话在它真正的主人账号下复活（v1.22.0 起无回收站、不可逆）'
    );
    // ④ 闸门必须明确回报「这条被挡下了」（调用方据此不清队）。
    const last = backendCalls.results[backendCalls.results.length - 1];
    assert.ok(
      last?.blockedIds.includes(GROUP_ID),
      '账号闸门必须把这条回报成「被挡下」—— 不回报的话调用方只能整队清队'
    );
  });

  it('登录回 A 之后：这条意图必须真的落到 A 的云端（墓碑）', async () => {
    await runUpToDeleteUnderB();
    await runUpload(); // B 那一轮：被挡下

    await signInAs(USER_A); // 主人回来了
    const result = await runUpload();
    assert.equal(
      result.success,
      true,
      `前提：主人这一轮上传必须成功（实得：${result.error ?? '无'}）`
    );

    assert.equal(
      cloud.rows.get(GROUP_ID)?.is_deleted,
      true,
      '主人登录回来后，这条删除意图必须真的落到 A 的云端（墓碑）—— ' +
        '否则 A 的云端那一行仍是活跃的 ⇒ 下一轮下载合并把它整组加回来 ⇒ ' +
        '「我明明删掉的会话又回来了」'
    );
  });

  it('真的广播成功之后：队列里那一条必须被清掉（不许无限重播）', async () => {
    await runUpToDeleteUnderB();
    await runUpload(); // B 那一轮：被挡下

    await signInAs(USER_A);
    await runUpload(); // A 那一轮：真的广播了

    assert.equal(
      (await pendingDeleteIds()).includes(GROUP_ID),
      false,
      '真的广播成功之后，这条意图必须被清出队列 —— ' +
        '不清 ⇒ 队列只增不减 ⇒ 每一轮都重播一遍（幂等但白费流量）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 场景二：换账号之前就删（会话已经不在本机清单里，只剩队列里那条意图）
// ══════════════════════════════════════════════════════════════════════════

describe('换账号之前就删的会话：归属账本必须把它记给上一个账号', () => {
  /** 跑到「会话已删、A 已退出、B 已登录」这一步。 */
  async function runUpToSwitchUnderB(): Promise<void> {
    await seedLocalGroup(GROUP_ID);
    seedCloudRow(GROUP_ID, USER_A);
    await signInAs(USER_A); // A 登录
    await deleteLocalSession(GROUP_ID); // 在 A 名下就删了 ⇒ 队列里有它
    await signOut(); // 退出 A
    await signInAs(USER_B); // 登录 B：此时本机清单里已经没有那个会话了
  }

  it('换账号时它已经不在本机清单里 ⇒ 归属必须仍然按「上一个账号」记着', async () => {
    await runUpToSwitchUnderB();

    const { accountScopeStore } = await import('@/utils/authCache');
    const scope = await accountScopeStore.read();
    assert.equal(
      scope?.foreignOwners?.[GROUP_ID],
      USER_A,
      '一条已经删掉（不在本机清单里）的会话，它的归属必须仍然记在 A 名下 —— ' +
        '归属一旦在这里丢掉，它的删除意图就会被发给新账号（越权写 + 复活）'
    );
  });

  it('B 的这一轮上传：这条意图必须被挡下并留在队列里', async () => {
    await runUpToSwitchUnderB();

    const result = await runUpload();
    assert.equal(
      result.success,
      true,
      `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`
    );
    assert.equal(
      cloud.rows.get(GROUP_ID)?.is_deleted,
      false,
      'A 的云端那一行必须还是活跃的（墓碑不能落在 B 名下）'
    );
    assert.ok(
      (await pendingDeleteIds()).includes(GROUP_ID),
      '这条删除意图必须留在队列里 —— 等登录回 A 时再广播'
    );
  });

  it('登录回 A 之后：墓碑落到 A 的云端，队列被清空', async () => {
    await runUpToSwitchUnderB();
    await runUpload(); // B 那一轮：被挡下

    await signInAs(USER_A);
    await runUpload(); // A 那一轮：真的广播了

    assert.equal(
      cloud.rows.get(GROUP_ID)?.is_deleted,
      true,
      '主人登录回来后，墓碑必须真的落到 A 的云端（否则那条会话照样复活）'
    );
    assert.equal(
      (await pendingDeleteIds()).includes(GROUP_ID),
      false,
      '真的广播成功之后，队列里那一条必须被清掉'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 场景三：归属**不可知**时（这台机器没有归属记录）⇒ 整批挡住，一条都不许清
// ══════════════════════════════════════════════════════════════════════════

describe('归属不可知时：宁可不删，也不可删错账号', () => {
  it('没有归属记录时：删除意图必须留在队列里，云端那一行不许被当成「已达成」', async () => {
    await seedLocalGroup(GROUP_ID);
    seedCloudRow(GROUP_ID, USER_A);
    await signInAs(USER_A);
    await deleteLocalSession(GROUP_ID);

    // 把归属记录抹掉（=「这台机器没有归属记录」这件事）：
    // 读不出来 ⇒ 归属不可知 ⇒ 闸门必须**挡住**，而不是「当成当前账号的」。
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.clear();

    const result = await runUpload();
    assert.equal(
      result.success,
      true,
      `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）—— ` +
        '上传侧在「没有归属记录」时会用登录缓存兜底认账，不该整轮失败'
    );

    assert.ok(
      (await pendingDeleteIds()).includes(GROUP_ID),
      '归属不可知时，这条删除意图必须留在队列里 —— ' +
        '把它当成「当前账号的」就是往错误的账号里删；把它当成「已达成」就是把意图丢掉 ' +
        '（两种都不可逆）'
    );
    assert.equal(
      cloud.rows.get(GROUP_ID)?.is_deleted,
      false,
      '归属不可知时，云端那一行必须还是活跃的 —— ' +
        '「云端没有这行」不能被当成「意图已达成」'
    );
  });
});

