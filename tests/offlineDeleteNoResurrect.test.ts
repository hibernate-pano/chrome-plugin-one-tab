// 「离线删除（从未上过云）」的两个复活/卡死边界——1.22.10 修复的回归钉。
//
// 【为什么有这份文件】体检（docs/health-check-2026-10-05.md）发现两条 P1，共同点都是
// 「本地删除意图的载体从未到达云端」：
//
//   P1-A（plain 读回卡死）markCloudGroupsAsDeleted 的 plain 降级分支（云端有
//        is_deleted、无印记列）没有 stamp 分支那步「先读现有行」，只能拿全量
//        pendingDeleteIds 做读回校验；其中「本地新建、从未上过云就被删」的 id
//        在云端没有行 → compareTombstoneReadback 抛「云端缺失组」→ upload 整体
//        失败 → pending_upload 永不清 → downloadAndMerge 永远撞 upload_first：
//        该设备既传不上也下不来，且同队列其他组的删除广播被连坐卡死。
//        修复口径：对齐 stamp 分支（只校验 touchedIds）——存在的行必须已标删
//        （吞写照样现形），缺失的行视为意图已达成（无行可复活）。
//
//   P1-B（迁移复活）1.22.0 的 purgeTombstones 把组级墓碑从 storage 物理移除，
//        但没把 id 转入 pendingDeleteIds。它假设「未上过云的残留由下一次 upload
//        的兜底标记覆盖」，可那个兜底（syncEngine.upload 的 legacyTombstoneIds）
//        读的正是 storage 里的 isDeleted 组——迁移一删，兜底永远读不到。凡
//        「离线删除 + 墓碑从未上过云 + 升级到 1.22.x」，云端行仍活跃，下次下载
//        合并整组复活。修复：登记意图**先于**物理移除（崩溃窗口落在「已登记、
//        未移除」侧顶多重广播一次，幂等；反过来就是本缺陷）。
//
// 跑的是真 storage + 真 syncEngine + 真 migrationUtils，假云端与
// tests/syncNoResurrectInvariants.test.ts 完全同一套 PostgREST 子集契约，不另造方言。
// 【反向验证】两条用例都在修复前的代码上跑红过（P1-A 死于 pending_upload_failed /
// 「云端缺失组 g-ghost」；P1-B 死于 pending_delete_ids 不含 g-tomb → 下载后整组复活）。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';

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
const DEV = 'devA';
const NOW = '2026-09-29T08:00:00.000Z';
const LATER = '2026-09-29T09:00:00.000Z';

// ── 本地存储底座（单设备；KV 驱动在无 indexedDB 时回退 localStorage）────────
const base = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return base.size;
    },
    key: (i: number) => [...base.keys()][i] ?? null,
    getItem: (k: string) => (base.has(k) ? (base.get(k) as string) : null),
    setItem: (k: string, v: string) => void base.set(k, String(v)),
    removeItem: (k: string) => void base.delete(k),
    clear: () => base.clear(),
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

// ── 假云端（PostgREST 子集，与 syncNoResurrectInvariants.test.ts 同一套契约）──
interface CloudRow {
  id: string;
  user_id: string;
  [k: string]: unknown;
}

const cloud = {
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
};

function jsonRes(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function missingColumnRes(col: string) {
  return jsonRes(
    {
      code: 'PGRST204',
      message: `Could not find the '${col}' column of 'tab_groups' in the schema cache`,
      details: null,
      hint: null,
    },
    400
  );
}

function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'on_conflict' || key === 'order') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      const ids = raw.slice(4, -1).split(',').map(s => s.replace(/"/g, '').trim());
      if (!ids.includes(String(row.id))) return false;
    } else if (raw.startsWith('lt.')) {
      if (!(String(row[key]) < raw.slice(3))) return false;
    } else {
      throw new Error(`假云端不认识的过滤器: ${key}=${raw}`);
    }
  }
  return true;
}

function project(row: CloudRow, cols: string[]): CloudRow {
  const out: CloudRow = (cols.includes('*') ? { ...row } : {}) as CloudRow;
  for (const c of cols) {
    if (c === '*') continue;
    (out as any)[c] = row[c];
  }
  return out;
}

/** 服务端两个 BEFORE UPDATE 守卫（照抄 syncNoResurrectInvariants 同一实现） */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) {
    return old;
  }
  const oSeq = old.last_op_seq;
  const nSeq = next.last_op_seq;
  if (oSeq != null && nSeq == null) return old;
  if (oSeq == null || nSeq == null) return next;
  if ((nSeq as number) < (oSeq as number)) return old;
  return next;
}

function writeRow(id: string, body: CloudRow): CloudRow {
  const old = cloud.rows.get(id);
  if (!old) {
    const inserted = { ...body } as CloudRow;
    cloud.rows.set(id, inserted);
    return inserted;
  }
  const merged = applyGuards(old, { ...old, ...body } as CloudRow);
  cloud.rows.set(id, merged);
  return merged;
}

function jsonBody(init: RequestInit | undefined): any {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  return undefined;
}

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    return jsonRes({ message: 'not found' }, 404);
  }

  const params = url.searchParams;

  if (method === 'GET') {
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    for (const c of cols) {
      if (c !== '*' && cloud.columns[c] === false) return missingColumnRes(c);
    }
    const limitRaw = params.get('limit');
    const limit = limitRaw ? Number(limitRaw) : Number.POSITIVE_INFINITY;
    const data = [...cloud.rows.values()]
      .filter(r => matches(r, params))
      .slice(0, limit)
      .map(r => project(r, cols));
    return jsonRes(data);
  }

  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (matches(row, params)) cloud.rows.delete(id);
    }
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written: CloudRow[] = rows.map(row => writeRow(row.id, row));
    return jsonRes(written);
  }

  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      touched.push(writeRow(id, body));
    }
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 测试数据 ──────────────────────────────────────────────────────────────
function mkTab(id: string, url: string) {
  return { id, url, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false };
}

function withTabs(id: string, n: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: Array.from({ length: n }, (_, j) => mkTab(`${id}-t${j + 1}`, `https://${id}.example.com/${j + 1}`)),
    createdAt: NOW,
    updatedAt: LATER,
    isLocked: false,
    version: 1,
    ...overrides,
  } as any;
}

type Handlers = { mutate: (cmd: any) => Promise<{ ok: boolean; error?: string }> };

let handlers: Handlers;

before(async () => {
  register(LOADER_PATH);
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));

  // SW 语义命令执行器：依赖按 src/background/mutationService.ts 的生产绑定复刻
  // （scheduleUpload 只做「置位 pending_upload」，定时器不属于被钉的不变量）
  const { storage } = await import('@/utils/storage');
  const { createMutationHandlers } = await import('@/background/mutationHandlers');
  const { createSeqRegistry } = await import('@/utils/seqRegistry');
  const { createJournal } = await import('@/utils/journal');
  const { kvGet, kvSet } = await import('@/storage/storageAdapter');
  const { getDeviceId } = await import('@/utils/deviceUtils');
  const seq = createSeqRegistry({ kvGet, kvSet, getGroups: () => storage.getGroups() });
  const journal = createJournal({ kvGet, kvSet, getDeviceId, nextSeq: () => seq.nextSeq() });
  const h = createMutationHandlers({
    getGroups: () => storage.getGroupsForWrite(),
    setGroups: (g: any) => storage.setGroupsImmediate(g),
    scheduleUpload: async (ms: number) => {
      void ms;
      await storage.setPendingUpload(true);
    },
    now: () => new Date().toISOString(),
    journal,
    seq,
    noteGroupDeleted: (ids: readonly string[]) => storage.addPendingDeleteIds(ids),
  });
  handlers = {
    mutate: async (cmd: any) => {
      const res = await h.handle(cmd);
      return { ok: res.ok, error: res.error };
    },
  };
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true };

  base.clear();
  base.set('storage_version', JSON.stringify(5));
  base.set('tabvaultpro_device_id', JSON.stringify(DEV));
  base.set('op_stamp_migrated', JSON.stringify(true));
  // 上传保护窗口（UPLOAD_GUARD_MS=35s）视为已过期
  base.set('last_upload_time', JSON.stringify(new Date(Date.now() - 60_000).toISOString()));

  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').clear();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
});

async function seed(groups: any[], extra: Record<string, unknown> = {}) {
  const { storage } = await import('@/utils/storage');
  const { kvSet } = await import('@/storage/storageAdapter');
  for (const [k, v] of Object.entries(extra)) await kvSet(k, v);
  await storage.setGroupsImmediate(groups);
}

const localGroups = async (): Promise<any[]> => {
  const { invalidateGroupsCache, storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  return storage.getGroups();
};

const pendingDeletes = async (): Promise<string[]> => {
  const { storage } = await import('@/utils/storage');
  return storage.getPendingDeleteIds();
};

const uploadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.upload({ syncSettings: false, forcePending: true });
};

const downloadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.downloadAndMerge();
};

// ─────────────────────────────────────────────────────────────────────────
// P1-A：plain 降级模式下，从未上过云的删除意图不得把设备钉死
// ─────────────────────────────────────────────────────────────────────────
describe('plain 降级模式（有 is_deleted、无印记列）：从未上过云的删除意图不得卡死设备', () => {
  it('离线新建即删除的组（云端无行）随正常删除广播一起上传 → 上传成功、队列清空、下一轮照常', async () => {
    // 强制 plain 模式：印记列探测返回 PGRST204（客户端先于 SQL 迁移发布的窗口）
    cloud.columns = { is_deleted: true, last_op_seq: false, deleted_at: true };
    const probe = await import('@/utils/supabase/probe');
    probe.__resetCloudColumnProbeCacheForTests();

    // g-ghost 在任何上传发生之前就被删除：它的 id 只存在于删除广播队列里，云端没有它的行
    await seed([withTabs('g-keep', 1), withTabs('g-ghost', 1)], { device_seq: 2 });
    const del = await handlers.mutate({ op: 'deleteGroup', groupId: 'g-ghost' });
    assert.equal(del.ok, true, `前置：deleteGroup 必须成功（${del.error ?? '无'}）`);
    assert.deepEqual(await pendingDeletes(), ['g-ghost'], '前置：删除意图已登记进广播队列');
    assert.equal(cloud.rows.get('g-ghost'), undefined, '前置：g-ghost 从未上过云，云端没有它的行');

    // 关键一轮：g-keep 活跃行照常上云，g-ghost 的删除广播在 plain 模式下
    // PATCH 匹配 0 行 → 读回时「云端缺失组」。
    // 修复前：verifyTombstoneReadback 对缺失行抛错 → upload 整体失败 →
    //   pending_upload 永不清 → downloadAndMerge 永远撞 upload_first → 设备钉死。
    const up = await uploadNow();
    assert.equal(
      up.success,
      true,
      `上传必须成功（${up.error ?? '无'}）——云端无行的删除意图没有可复活的对象，` +
      '不得把整台设备的上传/下载卡死'
    );
    assert.equal(await (await import('@/utils/storage')).storage.getPendingUpload(), false,
      'pending_upload 必须被清掉——它不清就意味着永久重试循环');
    assert.deepEqual(
      await pendingDeletes(),
      [],
      '广播完成后队列必须清空（云端无行的 id 视为意图已达成，无行可复活）'
    );
    assert.equal(cloud.rows.get('g-keep')?.is_deleted, false, '正控：活跃组照常上云');
    assert.equal(cloud.rows.get('g-ghost'), undefined, '云端不该为从未上过云的组造行');

    // 正控：已上云的组在 plain 模式下照样被标删——「吞写现形」能力不放松
    const del2 = await handlers.mutate({ op: 'deleteGroup', groupId: 'g-keep' });
    assert.equal(del2.ok, true, `正控前置：deleteGroup 必须成功（${del2.error ?? '无'}）`);
    const up2 = await uploadNow();
    assert.equal(up2.success, true, `正控：第二轮上传必须成功（${up2.error ?? '无'}）`);
    assert.equal(
      cloud.rows.get('g-keep')?.is_deleted,
      true,
      '已上云的行必须真的被标删（读回校验对存在的行仍然严格）'
    );
    assert.deepEqual(await pendingDeletes(), [], '正控：广播确认后队列清空');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P1-B：1.22.0 迁移边界——purgeTombstones 必须把墓碑组的删除意图转入广播队列
// ─────────────────────────────────────────────────────────────────────────
describe('迁移边界：purgeTombstones 物理移除墓碑组前必须登记删除意图（否则升级后复活）', () => {
  it('离线删除 + 墓碑从未上过云 + 升级到 1.22.x → 迁移登记意图 → 上传广播 → 下载不复活', async () => {
    // 前置：老模型时代两个组都已上云（活跃行）
    await seed(
      [
        withTabs('g-keep', 1, { lastOp: { d: DEV, s: 2 } }),
        withTabs('g-tomb', 2, { lastOp: { d: DEV, s: 2 } }),
      ],
      { device_seq: 2 }
    );
    const up0 = await uploadNow();
    assert.equal(up0.success, true, `前置：首轮上传必须成功（${up0.error ?? '无'}）`);

    // 用户离线删除 g-tomb（老模型：本地转组级墓碑；云端广播从未成功——上传失败/未登录）
    await seed([
      withTabs('g-keep', 1, { lastOp: { d: DEV, s: 2 } }),
      withTabs('g-tomb', 2, { isDeleted: true, lastOp: { d: DEV, s: 2 } }),
    ]);
    assert.equal(cloud.rows.get('g-tomb')?.is_deleted, false, '前置：云端行仍是活跃（离线删除未上云）');

    // 升级到 1.22.x：跑迁移
    const { purgeTombstones } = await import('@/utils/migrationUtils');
    await purgeTombstones();

    // 关键断言 1：墓碑组物理移除，但删除意图转入广播队列
    const after = await localGroups();
    assert.equal(after.filter(g => g.id === 'g-tomb').length, 0, '墓碑组应被物理移除（无墓碑模型）');
    assert.ok(
      (await pendingDeletes()).includes('g-tomb'),
      '墓碑组的删除意图必须登记进 pending_delete_ids——' +
      '否则云端活跃行无从服从删除，下次下载合并整组复活（修复前的原样）'
    );
    assert.ok(after.some(g => g.id === 'g-keep'), '正控：活跃组不受影响');

    // 关键断言 2：上传把删除广播到云端
    const up = await uploadNow();
    assert.equal(up.success, true, `迁移后的上传必须成功（${up.error ?? '无'}）`);
    assert.equal(cloud.rows.get('g-tomb')?.is_deleted, true, '云端行必须被标删');
    assert.deepEqual(await pendingDeletes(), [], '广播读回确认后队列清空');

    // 关键断言 3：下载合并不复活
    const { storage } = await import('@/utils/storage');
    await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
    const down = await downloadNow();
    assert.equal(down.success, true, `下载必须成功（${down.reason ?? '无'}）`);
    assert.equal(
      (await localGroups()).filter(g => g.id === 'g-tomb').length,
      0,
      '已删除的组不得被云端带回来（复活 = 本用例的存在理由）'
    );
    assert.ok((await localGroups()).some(g => g.id === 'g-keep'), '正控：活跃组在下载后仍在');
  });
});
