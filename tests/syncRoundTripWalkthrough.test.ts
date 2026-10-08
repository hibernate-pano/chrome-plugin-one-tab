// 端到端同步走查（2026-10-07）：把「上传 / 下载」当成一条完整用户旅程跑一遍。
//
// 【为什么要这份文件】现有 sync 测试是按**不变量**组织的（不复活的 N 条路径、
// 覆盖开关、预检降级……），每条各自成立，但没有任何一条**把旅程本身走完**：
//   A 建会话 → 上传 → B（全新设备）下载 → A 改 → B 再下载 → A 删 → B 再下载。
// 用户遇到的故障往往正是「每一段都对、接起来不对」，所以这里补一条按时间顺序
// 走完的链路，并在每一步断言「另一端真的看到了」。
//
// 假云端刻意**与 syncNoResurrectInvariants.test.ts 同一套 PostgREST 子集契约**
// （GET/POST/PATCH/DELETE、eq./in()./lt. 过滤、select 投影、PGRPC204 缺列降级、
// 两个 BEFORE UPDATE 守卫的逐条判定）—— 不另造第三套方言，否则测试会自己骗自己。
//
// 对 syncNoResurrectInvariants 那份假云端的两点加强（均与
// downloadPaginationStability.test.ts 同一套建模）：
//   1. GET **真的解析 order 参数排序**（原先那份只按 created_at 降序）；
//   2. 对「按 order 键仍并列」的行做**随请求变化的确定性置换**（请求序号做种子）。
//      Postgres 对并列行的跨查询顺序不给任何保证，若靠 JS sort 的稳定性原样
//      回传插入序，并列维度就没被建模——有没有 id tiebreaker 测试都绿。
//      做了置换之后，规模走查用例（260 行 created_at 全并列）**真的能守
//      下载分页的 id tiebreaker**：临时去掉 download.ts 的 `.order('id')`，
//      该用例即红（页窗口重叠 ⇒ 丢行/重复行）。
//
// 静默运行，加 VERBOSE=1 打印逐步日志：
//   VERBOSE=1 node --test --import ./tests/_register-loader.mjs \
//     --experimental-strip-types tests/syncRoundTripWalkthrough.test.ts
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

const say = (...args: unknown[]) => console.log(...args);
if (!process.env.VERBOSE) {
  console.log = () => {};
}

const USER_ID = 'walkthrough-user';
const SESSION_KEY = 'sb-stub-auth-token';
const DEV_A = 'devA';
const DEV_B = 'devB';
const NOW = '2026-10-07T08:00:00.000Z';
const LATER = '2026-10-07T09:00:00.000Z';

// ── 两台设备的本地存储底座 ────────────────────────────────────────────────
const deviceStores: Record<string, Map<string, string>> = { A: new Map(), B: new Map() };
let activeStore: Map<string, string> = deviceStores.A;

(globalThis as any).window = {
  localStorage: {
    get length() { return activeStore.size; },
    key: (i: number) => [...activeStore.keys()][i] ?? null,
    getItem: (k: string) => (activeStore.has(k) ? activeStore.get(k) : null),
    setItem: (k: string, v: string) => void activeStore.set(k, String(v)),
    removeItem: (k: string) => void activeStore.delete(k),
    clear: () => activeStore.clear(),
  },
};
(globalThis as any).localStorage = (globalThis as any).window.localStorage;

const chromeData = new Map<string, unknown>();
(globalThis as any).chrome = {
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

// ── 假云端（PostgREST 子集；GET 按 order 排序 + 并列行确定性置换）─────────────
interface CloudRow {
  id: string;
  user_id: string;
  [k: string]: unknown;
}
const cloud = {
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
  ops: [] as string[],
  /** 已发出的分页 GET 数（带 offset 参数的请求），做并列置换的种子 */
  pagedGets: 0,
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const missingColumnRes = (col: string) =>
  jsonRes(
    { code: 'PGRST204', message: `Could not find the '${col}' column of 'tab_groups' in the schema cache` },
    400
  );

function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'on_conflict', 'order'].includes(key)) continue;
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

/** order 是**一个**逗号分隔参数：`created_at.desc,id.desc`（supabase-js 会合并） */
function parseOrder(params: URLSearchParams): Array<{ col: string; asc: boolean }> {
  const out: Array<{ col: string; asc: boolean }> = [];
  for (const raw of params.getAll('order')) {
    for (const spec of raw.split(',')) {
      const [col, dir] = spec.split('.');
      if (col) out.push({ col, asc: (dir ?? 'asc').toLowerCase() !== 'desc' });
    }
  }
  return out;
}

/**
 * 按请求里的 order 排序；对「按这些键仍并列」的行做随请求变化的置换，
 * 模拟 Postgres 对并列行不给跨查询顺序保证的真实行为（与
 * downloadPaginationStability.test.ts 的 orderedRows 同一套建模）。
 * 没有这一步的话，JS sort 的稳定性会把 Map 插入序原样回传——并列维度
 * 等于没建模，有没有 id tiebreaker 测试都是绿的。
 * 置换用请求序号做种子，不用随机数：确定性，失败可复现。
 */
function orderedRows(
  rows: CloudRow[],
  order: Array<{ col: string; asc: boolean }>,
  requestIndex: number
): CloudRow[] {
  const sorted = [...rows].sort((a, b) => {
    for (const { col, asc } of order) {
      const av = String(a[col] ?? '');
      const bv = String(b[col] ?? '');
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });

  // 同一组「按指定键完全并列」的行，顺序在请求之间不稳定。
  const keyOf = (r: CloudRow) => order.map(({ col }) => String(r[col] ?? '')).join('\u0000');
  const out: CloudRow[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && keyOf(sorted[j]) === keyOf(sorted[i])) j++;
    const group = sorted.slice(i, j);
    if (group.length > 1) {
      const shift = requestIndex % group.length;
      out.push(...group.slice(shift), ...group.slice(0, shift));
    } else {
      out.push(...group);
    }
    i = j;
  }
  return out;
}

const project = (row: CloudRow, cols: string[]): CloudRow => {
  const out: CloudRow = (cols.includes('*') ? { ...row } : {}) as CloudRow;
  for (const c of cols) if (c !== '*') (out as any)[c] = row[c];
  return out;
};

/** 服务端两个 BEFORE UPDATE 守卫的逐条判定（照抄 supabase/migrations 的 plpgsql） */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) return old;
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

const jsonBody = (init?: RequestInit): any =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'wt@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) return jsonRes({ message: 'not found' }, 404);

  const params = url.searchParams;

  if (method === 'GET') {
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    for (const c of cols) if (c !== '*' && cloud.columns[c] === false) return missingColumnRes(c);
    const limit = params.get('limit') ? Number(params.get('limit')) : Number.POSITIVE_INFINITY;
    const offset = params.get('offset') ? Number(params.get('offset')) : 0;
    // 请求序号 = 已发出的分页 GET 数：只有带 offset 的请求才是分页窗口
    // （探活 / digest 这类一次性 GET 不计数）。与 downloadPaginationStability
    // 的 requestIndex 语义一致：第 N 个分页请求的种子就是 N。
    const requestIndex = cloud.pagedGets;
    if (params.has('offset')) cloud.pagedGets += 1;
    const data = orderedRows(
      [...cloud.rows.values()].filter(r => matches(r, params)),
      parseOrder(params),
      requestIndex
    )
      .slice(offset, offset + limit)
      .map(r => project(r, cols));
    return jsonRes(data);
  }
  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) if (matches(row, params)) cloud.rows.delete(id);
    cloud.ops.push('DELETE');
    return jsonRes([]);
  }
  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written = rows.map(row => writeRow(row.id, row));
    cloud.ops.push(`UPSERT(${written.length})`);
    return jsonRes(written);
  }
  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      touched.push(writeRow(id, body));
    }
    cloud.ops.push(`PATCH(${touched.length})`);
    return jsonRes(touched);
  }
  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 设备 harness ──────────────────────────────────────────────────────────
const asDevice = async (which: 'A' | 'B') => {
  activeStore = deviceStores[which];
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').clear();
};

let handlers: { mutate: (cmd: any) => Promise<{ ok: boolean; error?: string }> };

before(async () => {
  register(LOADER_PATH);
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));

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
    scheduleUpload: async () => {
      await storage.setPendingUpload(true);
    },
    now: () => new Date().toISOString(),
    journal,
    seq,
    noteGroupDeleted: (ids: readonly string[]) => storage.addPendingDeleteIds(ids),
  });
  handlers = { mutate: async (cmd: any) => { const r = await h.handle(cmd); return { ok: r.ok, error: r.error }; } };
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  cloud.pagedGets = 0;
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true };
  for (const [name, deviceId] of [['A', DEV_A], ['B', DEV_B]] as const) {
    const s = deviceStores[name];
    s.clear();
    s.set('storage_version', JSON.stringify(5));
    s.set('tabvaultpro_device_id', JSON.stringify(deviceId));
    s.set('op_stamp_migrated', JSON.stringify(true));
    s.set('last_upload_time', JSON.stringify(new Date(Date.now() - 60_000).toISOString()));
  }
  activeStore = deviceStores.A;
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').clear();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
});

async function seed(groups: any[]) {
  const { storage } = await import('@/utils/storage');
  await storage.setGroupsImmediate(groups);
}
const localGroups = async (): Promise<any[]> => {
  const { invalidateGroupsCache, storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  return storage.getGroups();
};
const uploadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.upload({ syncSettings: false, forcePending: true });
};
const downloadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.downloadAndMerge();
};
/** 把上传保护窗口「等出」（UPLOAD_GUARD_MS=35s），不引入 sleep */
async function expireUploadGuard() {
  const { storage } = await import('@/utils/storage');
  await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
}

function mkTab(id: string, url: string) {
  return { id, url, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false };
}
function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [mkTab(`${id}-t1`, `https://${id}.example.com/1`)],
    createdAt: NOW,
    updatedAt: LATER,
    isLocked: false,
    version: 1,
    ...overrides,
  } as any;
}

const liveRows = () => [...cloud.rows.values()].filter(r => r.is_deleted !== true);
const tombRows = () => [...cloud.rows.values()].filter(r => r.is_deleted === true);

// ══════════════════════════════════════════════════════════════════════════
describe('端到端同步走查：A → 云端 → B', () => {
  it('完整旅程：建 → 上传 → 下载 → 改 → 再下载 → 删 → 不再复活', async () => {
    // ── 1. 设备 A 建立 3 个会话并上传 ─────────────────────────────────
    say('\n=== 1) 设备 A：本地 3 个会话，上传 ===');
    await asDevice('A');
    await seed([
      mkGroup('A-1', { name: '工作' }),
      mkGroup('A-2', { name: '阅读', tabs: [mkTab('t1', 'https://a/1'), mkTab('t2', 'https://a/2')] }),
      mkGroup('A-3', { name: '面试' }),
    ]);
    const upA = await uploadNow();
    say(`   upload success=${upA.success}；云端活跃行=${liveRows().length} 墓碑行=${tombRows().length}`);
    assert.equal(upA.success, true, 'A 的上传必须成功');
    assert.equal(liveRows().length, 3, '云端应有 3 个活跃会话');
    assert.equal(cloud.rows.get('A-2')!.name, '阅读', '云端应存的是加密前的业务字段');

    // ── 2. 设备 B：全新设备第一次下载 ────────────────────────────────
    say('\n=== 2) 设备 B：全新设备，第一次下载 ===');
    await asDevice('B');
    assert.equal((await localGroups()).length, 0, 'B 初始应为空');
    await expireUploadGuard();
    const downB1 = await downloadNow();
    const b1 = await localGroups();
    say(`   download success=${downB1.success}；B 本地会话=${b1.length}`);
    for (const g of b1) say(`     · ${g.name}（${g.tabs.length} 个标签）`);
    assert.equal(downB1.success, true, 'B 的首次下载必须成功');
    assert.deepEqual(
      b1.map(g => g.name).sort(),
      ['工作', '阅读', '面试'],
      'B 必须看到 A 的全部 3 个会话'
    );
    const b2 = b1.find(g => g.name === '阅读')!;
    assert.equal(b2.tabs.length, 2, '标签必须完整往返（加密/解密链路）');
    assert.deepEqual(
      b2.tabs.map((t: any) => t.url).sort(),
      ['https://a/1', 'https://a/2'],
      '标签 URL 必须逐字一致'
    );

    // ── 3. A 改名 → 上传 → B 下载看到新名字 ──────────────────────────
    say('\n=== 3) 设备 A：把「工作」改名为「工作（已归档）」→ 上传 ===');
    await asDevice('A');
    const renA = await handlers.mutate({ op: 'renameGroup', groupId: 'A-1', name: '工作（已归档）' });
    assert.equal(renA.ok, true, 'rename 必须成功');
    const upA2 = await uploadNow();
    say(`   rename ok；云端 A-1.name=${cloud.rows.get('A-1')!.name}；upload=${upA2.success}`);
    assert.equal(upA2.success, true);
    assert.equal(cloud.rows.get('A-1')!.name, '工作（已归档）', '改名必须写上云');

    await asDevice('B');
    await expireUploadGuard();
    const downB2 = await downloadNow();
    const b2Name = (await localGroups()).find(g => g.id === 'A-1')?.name;
    say(`   B 下载 success=${downB2.success}；B 端 A-1.name=${b2Name}`);
    assert.equal(b2Name, '工作（已归档）', 'B 必须看到 A 的改名（组级 LWW）');

    // ── 4. A 删除 → 上传（删除广播）→ B 下载不得复活 ─────────────────
    say('\n=== 4) 设备 A：删除「面试」→ 上传（删除广播）===');
    await asDevice('A');
    const delA = await handlers.mutate({ op: 'deleteGroup', groupId: 'A-3' });
    assert.equal(delA.ok, true, '删除必须成功');
    assert.equal((await localGroups()).some(g => g.id === 'A-3'), false, 'A 本地应立即消失');
    const upA3 = await uploadNow();
    say(`   delete ok；云端 A-3.is_deleted=${String(cloud.rows.get('A-3')?.is_deleted)}；upload=${upA3.success}`);
    assert.equal(upA3.success, true);
    assert.equal(cloud.rows.get('A-3')!.is_deleted, true, '云端行必须被标成墓碑（广播载体）');

    await asDevice('B');
    assert.equal((await localGroups()).some(g => g.id === 'A-3'), true, '删除前 B 本地确实还有它');
    await expireUploadGuard();
    const downB3 = await downloadNow();
    const b3 = await localGroups();
    say(`   B 下载 success=${downB3.success}；B 端剩余=${b3.map(g => g.name).join(' / ')}`);
    assert.equal(
      b3.some(g => g.id === 'A-3'),
      false,
      'A 删掉的会话不得在 B 端复活（v1.22.0 起无回收站，这是最高级别事故）'
    );
    assert.deepEqual(b3.map(g => g.name).sort(), ['工作（已归档）', '阅读'], '其余会话不受影响');
  });

  it('规模走查：260 个会话（含并列 created_at）分批上传 + 分页下载完整往返', async () => {
    say('\n=== 5) 规模：260 个会话，created_at 故意全部并列 ===');
    await asDevice('A');
    // 真实形状：OneTab 一次性导入会给同批每个组盖同一个 now
    const SAME = '2026-10-01T00:00:00.000Z';
    const many = Array.from({ length: 260 }, (_, i) =>
      mkGroup(`S-${String(i).padStart(3, '0')}`, {
        name: `会话 ${i}`,
        createdAt: SAME,
        updatedAt: SAME,
        tabs: [mkTab(`S-${i}-t1`, `https://site${i}.example.com/`)],
      })
    );
    await seed(many);

    const upS = await uploadNow();
    say(`   上传 success=${upS.success}；云端活跃行=${liveRows().length}；UPSERT 请求数=${cloud.ops.filter(o => o.startsWith('UPSERT')).length}`);
    assert.equal(upS.success, true, '260 个会话的上传必须成功');
    assert.equal(liveRows().length, 260, '云端应有全部 260 行');
    assert.ok(
      cloud.ops.filter(o => o.startsWith('UPSERT')).length >= 6,
      `分批上传应发出 ≥6 个请求（260/50），实际 ${cloud.ops.filter(o => o.startsWith('UPSERT')).length}`
    );

    await asDevice('B');
    await expireUploadGuard();
    const downS = await downloadNow();
    const bs = await localGroups();
    const gotIds = new Set(bs.map(g => g.id));
    const missing = many.map(g => g.id).filter(id => !gotIds.has(id));
    say(`   下载 success=${downS.success}；B 本地=${bs.length}；缺失=${missing.length}`);
    assert.equal(downS.success, true);
    assert.deepEqual(
      missing,
      [],
      `并列 created_at 下分页下载丢了 ${missing.length} 行（前 5 个：${missing.slice(0, 5).join(',')}）`
    );
    assert.equal(bs.length, 260, `B 应取回全部 260 个会话，实际 ${bs.length}`);
    assert.equal(new Set(bs.map(g => g.id)).size, 260, '不得出现重复行（页窗口重叠）');
  });
});
