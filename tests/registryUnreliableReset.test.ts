// 「登记不可信」标志的**自锁**修复（2026-10-20 D-10）的行为回归。
//
// 复现的现场（用户可见的症状）：
//   写方登记「本次改动的会话 id」失败一次（配额满 / 死句柄看门狗 / 事务 abort）
//   ⇒ 标志 `pending_upload_registry_unreliable` 被置上
//   ⇒ 旧代码只在「上传对账通过」的分支里清它，而那个判据里又含
//      「标志为假」⇒ 标志为真 ⇒ 判据为假 ⇒ 复位永远执行不到
//   ⇒ 标志永不复位 ⇒ pending_upload 永远清不掉 ⇒ 每轮后台同步都在重跑上传
//   ⇒ **界面还报「同步成功」**（skippedGroups 恒为 undefined，
//      读起来像「没有例外」）。
//
// 断言的是**不变量**（不是字面量）：
//   · 标志为 true 时**存在**一条与上传对账无关的路径能把它变回 false；
//   · 标志为 true 期间，调用方**不得**被告知「全部已同步」；
//   · 复位那一轮**必须**能覆盖漏登记的那批（不能只清标志就当没事发生）；
//   · 复位**幂等**；
//   · 正常路径（登记成功）**逐字不变**（标志一直是 false，行为不变）。
//
// 分两层：纯函数层（core/uploadCoverage）与运行时层（真 syncEngine + 真 storage
// + 假后端）。运行时层考的是「引擎真的接上了这条路径」——
// 纯函数绿但引擎没调用，是本仓反复吃亏于「机制存在但没被用上」。
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';
import type { SyncBackendPort } from '@/sync-backend/ports';
import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';
const LOCAL_DEVICE = 'devLocal';
const NOW = '2026-10-20T08:00:00.000Z';

// ── 本地存储桩（无 indexedDB 时 storageAdapter 回退到 localStorage）────────
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as any).window.localStorage;

const chromeData = new Map<string, unknown>();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        const out: Record<string, unknown> = {};
        for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

function mkGroup(id: string, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `会话 ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: LOCAL_DEVICE, s: 2 },
    tabs: [
      { id: `${id}-t1`, url: `https://${id}.example.com/`, title: '标题', createdAt: NOW, lastAccessed: NOW, pinned: false },
    ],
    ...over,
  } as TabGroup;
}

/** 把本地 groups 写进 storage（30s 缓存必须先失效）。 */
async function seedLocal(groups: TabGroup[]) {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setGroupsImmediate(groups);
  invalidateGroupsCache();
}

/** 记录上传批次的假后端（自带存储侧，id='webdav'）。 */
function makeFakeBackend() {
  const uploads: string[][] = [];
  const fake: SyncBackendPort = {
    id: 'webdav',
    label: '测试替身',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups(groups) {
      uploads.push(groups.map(g => g.id));
      return { writtenIds: groups.map(g => g.id) };
    },
    async broadcastDeletes(ids) {
      /* 不考删除广播 */
      return { broadcastIds: [...ids], blockedIds: [] };
    },
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {
      /* 不考设置 */
    },
    async downloadSettings() {
      return null;
    },
  };
  return { fake, uploads };
}

before(async () => {
  register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(LOCAL_DEVICE));
  lsData.set('op_stamp_migrated', JSON.stringify(true));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
  // 用户选的是自带存储 —— 归属待决期的抑制只对自带存储生效。
  lsData.set('user_settings', JSON.stringify({ syncBackend: 'webdav' }));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));
});

beforeEach(async () => {
  const { invalidateGroupsCache, storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setPendingUpload(false);
  await storage.clearPendingUploadGroupIds();
  await storage.setPendingUploadRegistryUnreliable(false);
  await storage.setFirstSyncPending(false);
  invalidateGroupsCache();
});

afterEach(async () => {
  const { resetActiveSyncBackend } = await import('@/sync-backend');
  resetActiveSyncBackend();
});

// ════════════════════════════════════════════════════════════════════
// 第一层：纯函数（core/uploadCoverage）
// ════════════════════════════════════════════════════════════════════

describe('D-10 纯函数：标志的复位条件**独立于上传对账**', () => {
  it('写方侧：「登记成功」能让标志复位，且这条判据里没有「对账」这回事', async () => {
    const { decideRegistryAfterRegistryWrite } = await import('@/core/uploadCoverage');

    // 标志为 true（登记失败过）。
    const before = { unreliable: true, gapOpen: true };
    // 本次登记成功（写方事实）。
    const r = decideRegistryAfterRegistryWrite({ before, writeSucceeded: true });

    assert.equal(
      r.after.unreliable,
      false,
      '登记成功 ⇒ 「登记机制此刻不可信」这个事实不再成立（标志必须能变回 false）'
    );
    assert.equal(
      r.after.gapOpen,
      true,
      '但「漏登记的那批还没补传」必须留着 —— 登记成功证明不了那批被补上了'
    );
    assert.equal(r.changed, true, '状态确实变了 ⇒ 调用方要写盘');
  });

  it('读方侧：「本轮提交的是全量」能让标志复位（同样不看对账）', async () => {
    const { decideRegistryAfterUpload } = await import('@/core/uploadCoverage');

    const before = { unreliable: true, gapOpen: true };
    const r = decideRegistryAfterUpload({ before, submittedFullScope: true });

    assert.equal(r.after.unreliable, false, '全量提交 ⇒ 登记完整与否不影响本轮 ⇒ 标志复位');
    assert.equal(r.after.gapOpen, false, '漏登记的那批就在这份全量里 ⇒ 缺口补上了');
    assert.equal(r.needsFullScope, false, '缺口已补 ⇒ 不再需要全量');
  });

  it('非全量轮次：标志**原样保留**，且继续要求「需要全量」', async () => {
    const { decideRegistryAfterUpload } = await import('@/core/uploadCoverage');

    const before = { unreliable: true, gapOpen: true };
    const r = decideRegistryAfterUpload({ before, submittedFullScope: false });

    assert.equal(r.after.unreliable, true, '本轮不是全量 ⇒ 标志不能被清（否则缺口永远补不上）');
    assert.equal(r.after.gapOpen, true, '缺口仍开着');
    assert.equal(
      r.needsFullScope,
      true,
      '缺口开着 ⇒ 下一轮必须走全量（这是「补上漏登记的那批」的唯一兜底）'
    );
  });

  it('复位**幂等**：已是干净的状态再走一次 ⇒ 状态不变且不写盘', async () => {
    const { decideRegistryAfterUpload, decideRegistryAfterRegistryWrite } =
      await import('@/core/uploadCoverage');

    const clean = { unreliable: false, gapOpen: false };
    const up = decideRegistryAfterUpload({ before: clean, submittedFullScope: true });
    assert.deepEqual(up.after, clean, '复位幂等：状态不变');
    assert.equal(up.changed, false, '没变 ⇒ 调用方不必写盘（幂等的可执行定义）');

    const wr = decideRegistryAfterRegistryWrite({ before: clean, writeSucceeded: true });
    assert.deepEqual(wr.after, clean, '写方侧复位也幂等');
    assert.equal(wr.changed, false, '没变 ⇒ 不写盘');
  });

  it('「登记失败」把标志重新置上（且开出缺口）—— 不掩盖真实问题', async () => {
    const { decideRegistryAfterRegistryWrite } = await import('@/core/uploadCoverage');

    const r = decideRegistryAfterRegistryWrite({
      before: { unreliable: false, gapOpen: false },
      writeSucceeded: false,
    });
    assert.equal(r.after.unreliable, true, '又失败了一次 ⇒ 标志必须再置上');
    assert.equal(r.after.gapOpen, true, '又失败了一次 ⇒ 缺口重新打开');
    assert.equal(r.changed, true);
  });

  it('对账判据：登记不可信**且**本轮依赖白名单 ⇒ 不得宣称「都同步了」', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

    const blocked = reconcileUploadCoverage({
      registeredIds: ['a'],
      submittedIds: ['a'],
      uploadPerformed: true,
      registryUnreliable: true,
      scopeDerivedFromRegistry: true,
    });
    assert.equal(blocked.canClearPending, false, '白名单过滤的轮次 ⇒ 登记不可信必须阻断');
    assert.equal(
      blocked.cannotConfirmAllSynced,
      true,
      '「没漏」无从证明 ⇒ 界面不得被告知「全部已同步」'
    );

    // 本轮是全量 ⇒ 漏登记的那批也在这份全量里 ⇒ 登记不可信不影响本轮结论。
    const full = reconcileUploadCoverage({
      registeredIds: ['a'],
      submittedIds: ['a', 'b'],
      uploadPerformed: true,
      registryUnreliable: true,
      scopeDerivedFromRegistry: false,
    });
    assert.equal(
      full.canClearPending,
      true,
      '本轮是全量 ⇒ 登记漏没漏都不影响本轮传了什么 ⇒ 可以清'
    );
    assert.equal(full.cannotConfirmAllSynced, false, '全量轮次可以确认「都传完了」');
  });

  it('对账判据：缺口未补齐 ⇒ 无论集合对不对得上账，都不得宣称「都同步了」', async () => {
    const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

    const c = reconcileUploadCoverage({
      registeredIds: ['a'],
      submittedIds: ['a'],
      uploadPerformed: true,
      registryGapOpen: true,
    });
    assert.equal(c.canClearPending, false, '缺口开着 ⇒ 不许清 pending_upload');
    assert.equal(
      c.cannotConfirmAllSynced,
      true,
      '集合对得上账也证明不了「没漏」⇒ 界面必须知道「无法确认」'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 第二层：运行时（真 syncEngine + 真 storage + 假后端）
// ════════════════════════════════════════════════════════════════════

describe('D-10 运行时：标志为 true 时**存在**一条能把它变回 false 的路径', () => {
  it('全量轮次 ⇒ 标志复位（且那一轮真的把漏登记的会话传上去了）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // 本机两个会话；白名单里只有 real-1 ⇒ missed-1 就是「登记失败时漏掉的那批」。
    await seedLocal([mkGroup('real-1'), mkGroup('missed-1')]);
    // ⚠️ **不进**归属待决期：待决期的自动上传按白名单过滤（不许替用户做归属
    // 决定）⇒ 那一轮拿不到全量。这里考的是「普通轮次（本来就是全量）」这条
    // 复位路径；待决期那条路径由下一个用例单独考。
    await storage.setFirstSyncPending(false);
    await storage.noteGroupsChanged(['real-1']);
    // 登记失败过 ⇒ 标志置上。
    await storage.setPendingUploadRegistryUnreliable(true);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    // 关键不变量：这一轮走的是**全量** ⇒ 漏登记的那批也传上去了。
    assert.deepEqual(
      uploads,
      [['real-1', 'missed-1']],
      '复位那一轮必须把漏登记的那批也传上去（只清标志就当没事发生 = 静默丢失）'
    );
    assert.equal(
      await storage.getPendingUploadRegistryUnreliable(),
      false,
      '全量轮次之后标志必须能变回 false（不许再自锁）'
    );
    assert.equal(await storage.getPendingUpload(), false, '缺口补齐 ⇒ pending_upload 可以清');
    assert.equal(
      result.cannotConfirmAllSynced,
      undefined,
      '一切补齐了 ⇒ 不再有「无法确认」这回事（不得无谓地报问题）'
    );
  });

  it('待决期（白名单过滤）的轮次：不得自动全量，但必须如实说「无法确认」', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // 归属待决期 ⇒ 自动上传只允许传白名单里的（不许替用户做归属决定）。
    await seedLocal([mkGroup('real-1'), mkGroup('missed-1')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1']);
    await storage.setPendingUploadRegistryUnreliable(true);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.deepEqual(
      uploads,
      [['real-1']],
      '待决期不许自动全量（那会替用户做归属决定）—— 缺口留给「完成归属决策」那一轮'
    );
    assert.equal(
      result.cannotConfirmAllSynced,
      true,
      '「无法确认全部已同步」必须报给调用方 ⇒ 界面不会报「同步成功」'
    );
    assert.match(
      String(result.error ?? ''),
      /无法确认/,
      '必须有人话说明为什么没法确认'
    );
    assert.match(
      String(result.error ?? ''),
      /云盘归属|归属决策/,
      '必须告诉用户**怎么恢复**（完成归属决策的那一次上传会走全量，把缺口补上）'
    );
    assert.equal(
      await storage.getPendingUpload(),
      true,
      '缺口没补上 ⇒ pending_upload 必须保留（下一轮继续）'
    );
  });

  it('缺口开着 ⇒ **下一轮普通上传**必须把漏登记的那批一起传上去（自动补齐）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    // 本机两个会话；白名单里只有 real-1 ⇒ missed-1 是「登记失败时漏掉的那批」。
    await seedLocal([mkGroup('real-1'), mkGroup('missed-1')]);
    await storage.setFirstSyncPending(false);
    await storage.noteGroupsChanged(['real-1']);
    await storage.setPendingUploadRegistryUnreliable(true);
    await storage.setPendingUpload(true);

    // 第一轮：待决期之外 ⇒ 本轮就是全量 ⇒ 漏登记的那批也上去了。
    await syncEngine.upload({ syncSettings: false, forcePending: true });

    // 第二轮：标志已被清 ⇒ 走普通路径（登记集合为空 ⇒ 清单为空）。
    // 关键不变量：**漏登记的那批（missed-1）在第一轮就已经被传上去了** ——
    // 不能出现「标志清了但那批从没传过」的状态（那 = 静默丢失）。
    assert.deepEqual(
      uploads[0],
      ['real-1', 'missed-1'],
      '复位那一轮必须把漏登记的那批一起传上去（否则清标志就等于把丢失合法化）'
    );
    assert.ok(
      uploads.every(batch => batch.includes('missed-1')),
      '漏登记的那批必须**至少**被传过一次（不许只清标志）'
    );
  });

  it('结构不变量：清单**由白名单决定**的那一轮，登记不可信必须阻断', async () => {
    // 这一条钉的是「引擎真的把 scopeDerivedFromRegistry 传对了」——
    // 变异点：把它恒传 false（假装本轮总是全量）⇒ 登记不可信在待决期
    // 不再阻断 ⇒ 界面会报「都同步了」，而那批漏登记的改动其实没传。
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/services/syncEngine.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(
      code,
      /scopeDerivedFromRegistry\s*=\s*changedGroupIds\s*!==\s*null/,
      '「本轮清单是否由白名单决定」必须由**结构事实**判定（白名单非空 ⇒ 是）'
    );
    assert.match(
      code,
      /scopeDerivedFromRegistry,/,
      '必须把这个事实传给对账判据（否则「登记不可信」在待决期不生效）'
    );
  });

  it('存储层必须**忠实落盘**纯函数判据给出的两个位（不许自己另有一套）', async () => {
    // 变异点：存储层落盘时把 gapOpen 写成 false（只保留 unreliable）⇒
    // 「漏登记的那批还没补传」这个提醒被抹掉 ⇒ 下一轮按白名单过滤 ⇒
    // 那批改动**永远**传不上去（静默丢失，且没有任何提示）。
    // 这条测试钉的是「存储层不许有自己的判据」这件事本身。
    //
    // ⚠️ 必须钉**写入那一次**（kvSet 的实参），不能只钉「文件里出现过这个形状」：
    // 返回值那一行也写着 `gapOpen: next.gapOpen`，只做全文件正则匹配的话，
    // 把写入那处改成 `gapOpen: false` 依然能匹配上 ⇒ 这条守卫就成了摆设。
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/utils/storage.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // 取**「按判据落盘」那一次**的实参块（不是同文件里另一处 kvSet ——
    // 置位那处写的是固定值 true/true，本来就不该用 next.*）。
    const at = code.indexOf('next: { unreliable: boolean; gapOpen: boolean }');
    assert.ok(at > 0, '必须能找到「按判据落盘」这个方法');
    const write = code.slice(at, at + 900);
    assert.match(
      write,
      /kvSet\(STORAGE_KEYS\.PENDING_UPLOAD_REGISTRY_UNRELIABLE,\s*\{[\s\S]{0,120}?gapOpen:\s*next\.gapOpen/,
      '落盘时 gapOpen 必须用判据给出的值（不许写死 false ⇒ 抹掉「漏登记未补传」）'
    );
    assert.match(
      write,
      /kvSet\(STORAGE_KEYS\.PENDING_UPLOAD_REGISTRY_UNRELIABLE,\s*\{[\s\S]{0,120}?unreliable:\s*next\.unreliable/,
      '落盘时 unreliable 也必须用判据给出的值'
    );
  });

  it('写方侧：登记成功只清「不可信」，**必须保留**「漏登记未补传」', async () => {
    // 这是整个修复里最容易被写坏的一处：登记成功 ⇒ 「不可信」复位，
    // 但「漏登记的那批还没被全量补传」**必须留着** ——
    // 顺手把它也清了 ⇒ 下一轮按白名单过滤 ⇒ 那批改动永远传不上去。
    const { storage } = await import('@/utils/storage');
    const { decideRegistryAfterRegistryWrite } = await import('@/core/uploadCoverage');

    // 置位（= 登记失败过一次 ⇒ 两个位都开）。
    await storage.setPendingUploadRegistryUnreliable(true);
    const before = await storage.getPendingUploadRegistryState();
    assert.equal(before.unreliable, true);
    assert.equal(before.gapOpen, true, '登记失败 ⇒ 缺口打开');

    // 判据：登记成功 ⇒ 只清 unreliable。
    const decision = decideRegistryAfterRegistryWrite({ before, writeSucceeded: true });
    assert.equal(decision.after.unreliable, false, '登记成功 ⇒ 「不可信」复位');
    assert.equal(
      decision.after.gapOpen,
      true,
      '但「漏登记的那批还没补传」必须留着（清掉它 ⇒ 那批永远传不上去）'
    );
  });

  it('写方侧：登记成功 ⇒ 「不可信」复位（与上传对账无关）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    // 标志为 true（登记失败过）。
    await storage.setPendingUploadRegistryUnreliable(true);
    assert.equal(await storage.getPendingUploadRegistryUnreliable(), true, '前置条件');

    // 写方登记成功（noteGroupsChanged 不抛错）⇒ 「登记机制此刻不可信」不再成立。
    await syncEngine.scheduleUpload(0, ['real-1']);

    assert.equal(
      await storage.getPendingUploadRegistryUnreliable(),
      false,
      '「本次登记成功」这条路径必须能清掉标志 —— 它与上传对账完全无关（因此不自锁）'
    );
  });

  it('正常路径（登记成功、没失败过）：标志一直是 false，行为逐字不变', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake, uploads } = makeFakeBackend();
    setActiveSyncBackend(fake);

    await seedLocal([mkGroup('real-1'), mkGroup('real-2')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1', 'real-2']);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.deepEqual(uploads, [['real-1', 'real-2']], '正常路径照旧只传登记过的');
    assert.equal(
      await storage.getPendingUploadRegistryUnreliable(),
      false,
      '正常路径下标志必须一直是 false（不许被别的东西误置位）'
    );
    assert.equal(result.skippedGroups, undefined, '一切正常 ⇒ 不报「未同步」');
    assert.equal(
      result.cannotConfirmAllSynced,
      undefined,
      '一切正常 ⇒ 不报「无法确认」（不许无谓地吓人）'
    );
    assert.equal(await storage.getPendingUpload(), false, '照旧清 pending_upload');
  });

  it('标志为 true 期间：调用方**不得**被告知「全部已同步」（结果里必须带事实）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { setActiveSyncBackend } = await import('@/sync-backend');
    const { fake } = makeFakeBackend();
    setActiveSyncBackend(fake);

    await seedLocal([mkGroup('real-1'), mkGroup('missed-1')]);
    await storage.setFirstSyncPending(true);
    await storage.noteGroupsChanged(['real-1']);
    await storage.setPendingUploadRegistryUnreliable(true);
    await storage.setPendingUpload(true);

    const result = await syncEngine.upload({ syncSettings: false, forcePending: true });

    // 「没传上去的数量」是 0 —— 登记集合与上行集合**对得上账**。
    // 旧代码只按这个数字决定要不要告诉用户 ⇒ 界面报「同步成功」= 撒谎。
    assert.equal(
      result.skippedGroups,
      undefined,
      '这一轮登记集合与上行集合确实对得上账（所以数量是 0）'
    );
    assert.equal(
      result.cannotConfirmAllSynced,
      true,
      '但「没漏」证明不了 ⇒ 必须带上「无法确认」这个事实（否则界面报「同步成功」）'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// 第三层：SW 那一层（唯一面向用户的一层）不许把「无法确认」当成功
// ════════════════════════════════════════════════════════════════════

describe('D-10 接线：SW 必须把「无法确认」翻译成「不是成功」', () => {
  it('SW 的 SYNC 回包：cannotConfirmAllSynced ⇒ ok=false（不许报「上传成功」）', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/service-worker.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(
      code,
      /cannotConfirmAllSynced/,
      'SW 必须读引擎的这个字段（否则界面收不到「无法确认」这件事）'
    );
    assert.match(
      code,
      /ok:\s*r\.success\s*&&\s*!partial\s*&&\s*!cannotConfirm/,
      '「无法确认」⇒ 回包必须 ok=false（让 popup 弹提示而不是「上传成功」）'
    );
  });

  it('引擎必须在标志为真时把「无法确认」写进结果（不许只在日志里）', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/services/syncEngine.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.match(
      code,
      /cannotConfirmAllSynced/,
      '引擎必须把这个事实放进结果（界面靠它拒绝报「同步成功」）'
    );
    // 复位那条线必须**不在** canClearPending 分支里（那正是自锁的成因）。
    const at = code.indexOf('coverage.canClearPending');
    assert.ok(at > 0, '必须能找到 canClearPending 守卫');
    const branch = code.slice(at, at + 900);
    assert.doesNotMatch(
      branch,
      /setPendingUploadRegistryUnreliable\(false\)/,
      '标志的复位**不许**再写在 canClearPending 分支里（那正是自锁的成因）'
    );
  });
});
