// 云端上行/下行链路的安全性回归（工作包：同步链路修复员）。
//
// 本文件钉死 4 个缺陷，每个用例都在对应修复前失败、修复后通过：
//
// [P0] 合并模式上传撞上「云端更晚的墓碑」→ 整台设备永久卡死
//   合并上传把每个活跃组以 is_deleted=false 写出；若云端那一行是另一台设备写的
//   墓碑且 last_op_seq 更大，guard_tab_group_op_stamp 判 NEW < OLD → RETURN NULL
//   （静默吞写，HTTP 200 无 error；version 守卫第 1 条放行 is_deleted 翻转，
//   拦不住它）→ verifyUploadReadback 的 is_deleted 比对抛错 → upload 失败 →
//   pending_upload 永不清 → 之后每次 downloadAndMerge 都先撞 upload_first、
//   上传又失败 → 一次都下载不了，闹钟每 60s 重试一次。
//   修法：写之前就按合并用的同一套全序判据认输（upload.ts 预检），
//   本地副本交给下一次下载合并物理移除。
//
// [P1] 墓碑 stamp 用「云端 OLD.last_op_seq + 1」自造号，脱离本机 Lamport 时钟
//   云端行 last_op_seq 为 NULL 时墓碑只拿到 seq 1；对方设备只要 seq >= 2，
//   在 mergeOpStamped 里就赢过这条墓碑、保留该组并重新上传为活跃 = 删除被撤销。
//   「取 OLD+1 保证守卫放行」只对服务端守卫成立，对客户端合并不成立。
//
// [P1] 下载时一组的标签全被 sanitizeTabUrl 过滤 → 产出 tabs: []
//   同文件对别的「读不出来」形状都有 fail-safe，唯独这条没有。空壳会被下游
//   dropEmptyGroups 硬删并登记 pendingDeleteIds 把云端行也删掉；
//   v1.22.0 起没有回收站 = 这一组在两边被永久销毁。
//
// [P2] 覆盖上传写出的墓碑行不带 deleted_at → purgeExpiredCloudTombstones
//   以 deleted_at 为龄期基准，30 天清理不生效，云端墓碑行只增不减。
//
// 假云端 = tests/overwriteTombstone.test.ts 那套 PostgREST 子集桩（GET/POST/
// PATCH/DELETE、eq./in()、select 投影、PGRST204 缺列降级），只补本场景必需的三处
// 仿真，不另造一套：
//   1) select=* 投影（downloadTabGroups 会发 `*, last_op_*, version`）与 order；
//   2) lt. 过滤器（purgeExpiredCloudTombstones 的龄期查询）；
//   3) 服务端两个 BEFORE UPDATE 守卫的逐条判定（照抄 migration 的 plpgsql）——
//      没有它，假云端会「老实接受」被守卫吞掉的写入，P0 那条静默吞写根本复现不出来。
//
// 文件样板与 tests/overwriteTombstoneDoubleWrite.test.ts 一致（真 syncEngine +
// 真 storage + 假云端）；跑真实 syncEngine 会打大量日志，故默认静音 console。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from './_helpers/stubSession.ts';
// 纯类型导入：编译期擦除，运行时零依赖，故不受「@/ 必须 register(loader) 后动态 import」的约束。
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
const REMOTE_DEVICE = 'devRemote';
const NOW = '2026-09-29T08:00:00.000Z';
const LATER = '2026-09-29T09:00:00.000Z';

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

// ── 假云端（PostgREST 子集） ───────────────────────────────────────────────
interface CloudRow {
  id: string;
  user_id: string;
  [k: string]: unknown;
}

const cloud = {
  /** 云端实际存在的列（决定三个 supports* 探测落在哪个分支） */
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作 */
  ops: [] as string[],
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

/** 极简 PostgREST 过滤：user_id=eq.X、id=in.("a","b")、deleted_at=lt.X */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'on_conflict' || key === 'order') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      // postgrest-js 实际发的是 in.(a,b)（4 字符前缀 'in.('，无引号）；带引号形式一并兼容
      const ids = raw.slice(4, -1).split(',').map(s => s.replace(/"/g, '').trim());
      if (!ids.includes(String(row.id))) return false;
    } else if (raw.startsWith('lt.')) {
      // purgeExpiredCloudTombstones 的龄期查询。缺失值（undefined）比任何 ISO
      // 串都大 → 不会被判过期，与 Postgres 里 NULL < cutoff 为 NULL（不命中）一致。
      if (!(String(row[key]) < raw.slice(3))) return false;
    } else {
      throw new Error(`假云端不认识的过滤器: ${key}=${raw}`);
    }
  }
  return true;
}

function project(row: CloudRow, cols: string[]): CloudRow {
  // select=* 时先摊平整行（downloadTabGroups 会发 `*, last_op_device, last_op_seq, version`）
  const out: CloudRow = (cols.includes('*') ? { ...row } : {}) as CloudRow;
  for (const c of cols) {
    if (c === '*') continue;
    (out as any)[c] = row[c];
  }
  return out;
}

/**
 * 服务端两个 BEFORE UPDATE 守卫的逐条判定（照抄 migration 的 plpgsql）。
 *
 * 没有它，假云端会老老实实接受每一次 upsert/UPDATE，而真实生产库里
 * 「守卫 RETURN NULL」是 HTTP 200 + error=null —— 也就是说客户端无从得知
 * 写入被丢弃，只能靠读回校验发现。P0 那条链路完全依赖这个语义。
 *
 * 迁移来源：
 *   - guard_tab_group_version：
 *     supabase/migrations/20260827_fix_version_guard_for_tombstones.sql
 *   - guard_tab_group_op_stamp：
 *     supabase/migrations/20260910_fix_op_stamp_guard_strict_lt.sql
 */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  // 两个 BEFORE UPDATE 触发器是**独立**的：任一返回 NULL（RETURN NULL）就整行
  // 丢弃，返回 NEW 只表示放行到下一个触发器。所以 version 守卫放行之后必须
  // 继续跑 op-stamp 守卫——这正是 P0 那条链路的要害：is_deleted 翻转让 version
  // 守卫第 1 条放行，却仍然被 op-stamp 守卫按「严格更旧」静默吞掉。
  //
  // guard_tab_group_version
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  // 规则 1：墓碑翻转总是放行；规则 2：严格更旧的 version 才拒收
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) {
    return old;
  }

  // guard_tab_group_op_stamp
  const oSeq = old.last_op_seq;
  const nSeq = next.last_op_seq;
  if (oSeq != null && nSeq == null) return old; // 规则 1：清空印记拒收
  if (oSeq == null || nSeq == null) return next; // 规则 2：任一侧无印记 → 无从比较，放行
  if ((nSeq as number) < (oSeq as number)) return old; // 规则 3：仅拒收严格更旧的写入
  return next;
}

/** upsert(onConflict: id) / PATCH 的共同写入语义：未列出的列保留旧值 + 守卫 */
function writeRow(id: string, body: CloudRow): CloudRow {
  const old = cloud.rows.get(id);
  if (!old) {
    const inserted = { ...body } as CloudRow;
    cloud.rows.set(id, inserted);
    return inserted;
  }
  // Postgres：INSERT 未列出的列在 ON CONFLICT DO UPDATE 时保持 OLD 值
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
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, limit)
      .map(r => project(r, cols));
    return jsonRes(data);
  }

  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (matches(row, params)) cloud.rows.delete(id);
    }
    cloud.ops.push('DELETE');
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written: CloudRow[] = rows.map(row => writeRow(row.id, row));
    cloud.ops.push(`UPSERT:${written.map(r => `${r.id}=${String(r.is_deleted)}`).join(',')}`);
    return jsonRes(written);
  }

  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      touched.push(writeRow(id, body));
    }
    cloud.ops.push(`PATCH:${touched.map(t => `${t.id}:seq=${String(t.last_op_seq)}`).join(',')}`);
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 测试数据 ──────────────────────────────────────────────────────────────
function mkTab(id: string, url: string) {
  return {
    id,
    url,
    title: id,
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
  };
}

function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [mkTab(`${id}-t1`, `https://${id}.example.com/`)],
    createdAt: NOW,
    updatedAt: LATER,
    isLocked: false,
    version: 1,
    ...overrides,
  } as any;
}

/** 一条云端行的完整形状（对齐 uploadTabGroups 写出的列） */
function cloudRow(id: string, overrides: Record<string, unknown> = {}): CloudRow {
  return {
    id,
    user_id: USER_ID,
    name: id,
    created_at: NOW,
    updated_at: LATER,
    is_locked: false,
    version: 1,
    is_deleted: false,
    deleted_at: null,
    last_op_device: null,
    last_op_seq: null,
    // 明文 JSON 数组（生产写的是加密串；decryptData 对明文同样直接 JSON.parse）
    tabs_data: JSON.stringify([mkTab(`${id}-t1`, `https://${id}.example.com/`)]),
    ...overrides,
  } as CloudRow;
}

/** 把本地 groups 写进 storage（storage 的 30s 缓存必须先失效） */
async function seedLocal(groups: TabGroup[]) {
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setGroupsImmediate(groups);
  invalidateGroupsCache();
}

before(async () => {
  register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(LOCAL_DEVICE));
  // 存量印记迁移跑过：本文件要考的是同步链路本身，不让迁移改写种子数据的 stamp
  lsData.set('op_stamp_migrated', JSON.stringify(true));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true };
  const { invalidateGroupsCache, storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.clearPendingDeleteIds();
  await storage.setPendingUpload(false);
  await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
  invalidateGroupsCache();
  // 列探测结果是进程内单例缓存，重置后才能让每条用例都重新探一次
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
});

/** 模拟后台闹钟的下一拍：上传保护窗口（UPLOAD_GUARD_MS=35s）已过期 */
async function expireUploadGuard() {
  const { storage } = await import('@/utils/storage');
  await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
}

// ─────────────────────────────────────────────────────────────────────────
// [P0] 云端墓碑比本地新 → 本地组认输，而不是把整台设备钉死在重试循环
// ─────────────────────────────────────────────────────────────────────────
describe('P0：合并上传撞上更新的云端墓碑时认输（syncEngine 全链路）', () => {
  it('上传成功 → pending_upload 被清 → 下一轮下载成功且认输的组被物理移除', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    // 本地：dead-1 被另一台设备删了（云端墓碑 seq 9 > 本地 seq 2），keep-1 正常
    await seedLocal([
      mkGroup('dead-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } }),
      mkGroup('keep-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } }),
    ]);
    // 云端：dead-1 已是墓碑（别的设备写的，印记更大）；keep-1 尚无云端行
    cloud.rows.set('dead-1', cloudRow('dead-1', {
      is_deleted: true,
      last_op_device: REMOTE_DEVICE,
      last_op_seq: 9,
      updated_at: LATER,
      deleted_at: LATER,
    }));

    // ── 修复前：upsert 带 is_deleted=false + 旧 stamp 撞守卫被静默吞写 →
    //    读回发现 is_deleted=true → 抛错 → upload 失败、pending_upload 保留 ──
    await storage.setPendingUpload(true);
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up.success, true, `上传必须成功（实得错误：${up.error ?? '无'}）`);
    assert.equal(
      await storage.getPendingUpload(),
      false,
      'pending_upload 必须被清掉——它不清，downloadAndMerge 就会永远先撞 upload_first'
    );
    // 云端墓碑原样保留：认输不是「把对方的删除撤销」
    assert.equal(cloud.rows.get('dead-1')?.is_deleted, true, '云端墓碑必须仍是墓碑');
    assert.equal(cloud.rows.get('dead-1')?.last_op_seq, 9, '云端墓碑的印记不该被本地旧值覆盖');
    const upsert = cloud.ops.find(op => op.startsWith('UPSERT')) ?? '';
    assert.match(upsert, /keep-1/, '幸存的组必须照常上行');
    assert.doesNotMatch(upsert, /dead-1/, '认输的组本次不应参与 upsert（撞守卫只会静默吞写）');

    // ── 下一轮后台轮询：pending 已清、上传保护窗口已过 → 正常下载 ──
    await expireUploadGuard();
    const down = await syncEngine.downloadAndMerge();
    assert.equal(down.success, true, `下载必须成功（实得：${down.reason ?? '无'}）`);
    assert.deepEqual(
      down.groups.map(g => g.id),
      ['keep-1'],
      '认输的组由合并物理移除，幸存的组必须留下'
    );
    assert.deepEqual(
      (await storage.getGroups()).map(g => g.id),
      ['keep-1'],
      '本地落盘结果同上（认输的组不能留在本地反复撞云端墓碑）'
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '认输的组云端已是墓碑，无需再广播删除（更不能把本地仅存的那份也删掉）'
    );

    // ── 再上传一次：证明不再陷入 pending_upload_failed 循环 ──
    const up2 = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(up2.success, true, `第二轮上传也必须成功（实得：${up2.error ?? '无'}）`);
  });

  it('云端缺印记列（plain 形态）时预检必须整段跳过：不能 select 不存在的列', async () => {
    // plain = 有 is_deleted、无 last_op_seq（客户端先于 SQL 迁移发布的过渡形态）。
    // 预检若照发 `select id, is_deleted, last_op_device, last_op_seq`，PGRST204
    // 会把一次本来正常的上传打死；且没有印记列本就无从比较（服务端按「任一侧
    // NULL → 放行」处理，不会吞写）。
    cloud.columns = { is_deleted: true, last_op_seq: false, deleted_at: true };
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    await seedLocal([mkGroup('p-1', { lastOp: { d: LOCAL_DEVICE, s: 4 } })]);
    cloud.rows.set('p-1', cloudRow('p-1', { is_deleted: true, updated_at: LATER }));
    await storage.setPendingUpload(true);

    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `plain 形态上传必须成功（实得：${res.error ?? '无'}）`);
    assert.equal(await storage.getPendingUpload(), false, 'pending_upload 必须被清掉');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// [P1] 墓碑 stamp 必须走本机 Lamport 时钟
// ─────────────────────────────────────────────────────────────────────────
describe('P1：墓碑 stamp 不得脱离本机 Lamport 时钟', () => {
  it('云端行 last_op_seq 为 NULL 时，墓碑 seq 仍必须大于本地已有的任何 seq', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    // 本地最大印记 42；删除意图指向一个云端没有印记的组
    await seedLocal([
      mkGroup('g-a', { lastOp: { d: LOCAL_DEVICE, s: 40 } }),
      mkGroup('g-b', { lastOp: { d: LOCAL_DEVICE, s: 42 } }),
      mkGroup('g-c', { lastOp: { d: LOCAL_DEVICE, s: 41 } }),
    ]);
    cloud.rows.set('g-del', cloudRow('g-del', { last_op_device: null, last_op_seq: null }));

    const { storage } = await import('@/utils/storage');
    await storage.addPendingDeleteId('g-del');

    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `上传必须成功（实得：${res.error ?? '无'}）`);

    const row = cloud.rows.get('g-del');
    assert.equal(row?.is_deleted, true, '删除意图必须落云');
    assert.equal(row?.last_op_device, LOCAL_DEVICE, '墓碑归属必须是本设备');
    // 修复前这里是 (null ?? 0) + 1 = 1：对方设备 seq>=2 即在合并里赢过这条墓碑，
    // 保留该组并重新上传为活跃 = 删除被静默撤销。
    assert.ok(
      typeof row?.last_op_seq === 'number' && (row.last_op_seq as number) > 42,
      `墓碑 seq 必须大于本地已有的最大 seq 42（实得 ${String(row?.last_op_seq)}）`
    );
  });

  it('云端行印记很大时，墓碑 seq 必须压过它（守卫放行 + 合并意图胜出）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    await seedLocal([mkGroup('g-a', { lastOp: { d: LOCAL_DEVICE, s: 3 } })]);
    cloud.rows.set('g-del', cloudRow('g-del', {
      last_op_device: REMOTE_DEVICE,
      last_op_seq: 500,
    }));

    const { storage } = await import('@/utils/storage');
    await storage.addPendingDeleteId('g-del');

    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `上传必须成功（实得：${res.error ?? '无'}）`);
    const row = cloud.rows.get('g-del');
    assert.equal(row?.is_deleted, true, '守卫放行了，墓碑必须真的落盘');
    assert.ok(
      typeof row?.last_op_seq === 'number' && (row.last_op_seq as number) > 500,
      `墓碑 seq 必须压过云端旧印记 500（实得 ${String(row?.last_op_seq)}）`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// [P1] 下载：一组的标签全被 sanitize 过滤 → 整组跳过，不能产出 tabs:[]
// ─────────────────────────────────────────────────────────────────────────
describe('P1：下载时全部标签 URL 被过滤的组，不得变成零标签空壳', () => {
  it('整组跳过（不合入本地、不登记 purge），本地仅存的那份完好', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    await seedLocal([mkGroup('g-x', { lastOp: { d: LOCAL_DEVICE, s: 1 } })]);
    // 云端同一组：两个标签的 URL 都没通过安全校验，且云端印记更大（合并会选它）
    cloud.rows.set('g-x', cloudRow('g-x', {
      last_op_device: REMOTE_DEVICE,
      last_op_seq: 5,
      updated_at: LATER,
      tabs_data: JSON.stringify([
        { id: 't1', url: 'javascript:alert(document.cookie)', title: 'x', created_at: NOW, last_accessed: NOW },
        { id: 't2', url: 'data:text/html,<script>alert(1)</script>', title: 'y', created_at: NOW, last_accessed: NOW },
      ]),
    }));

    const down = await syncEngine.downloadAndMerge();
    assert.equal(down.success, true, `下载必须成功（实得：${down.reason ?? '无'}）`);

    const local = await storage.getGroups();
    assert.deepEqual(local.map(g => g.id), ['g-x'], '这一组必须还在本地（云端那份读不出来 ≠ 空的）');
    assert.equal(local[0].tabs.length, 1, '本地那份的标签必须完好，绝不能被空壳覆盖');
    for (const g of down.groups) {
      assert.notEqual(g.tabs.length, 0, `下载结果里不允许出现 tabs: [] 的组（${g.id}）`);
    }
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '读不出来的组绝不能被登记进删除广播队列（v1.22.0 无回收站 = 永久删除）'
    );
    // 云端行必须原样保留
    assert.equal(cloud.rows.has('g-x'), true, '云端行必须原封保留，问题修好后能自然恢复');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// [P2] 覆盖上传写出的墓碑行必须带 deleted_at（30 天清理才生效）
// ─────────────────────────────────────────────────────────────────────────
describe('P2：覆盖上传写出的墓碑行必须带 deleted_at', () => {
  it('墓碑行有 deleted_at，活跃行为 null；缺列环境整列省略', async () => {
    const { syncEngine } = await import('@/services/syncEngine');

    await seedLocal([
      mkGroup('g-active', { lastOp: { d: LOCAL_DEVICE, s: 3 } }),
      mkGroup('g-tomb', { isDeleted: true, lastOp: { d: LOCAL_DEVICE, s: 5 } }),
    ]);
    cloud.rows.set('g-stale', cloudRow('g-stale'));

    const res = await syncEngine.upload({ overwriteCloud: true, syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `覆盖上传必须成功（实得：${res.error ?? '无'}）`);

    const tomb = cloud.rows.get('g-tomb');
    assert.equal(tomb?.is_deleted, true, '墓碑行必须以墓碑落云');
    assert.equal(
      typeof tomb?.deleted_at,
      'string',
      '墓碑行必须带 deleted_at——purgeExpiredCloudTombstones 以它为龄期基准'
    );
    assert.ok(
      typeof tomb?.deleted_at === 'string' && !Number.isNaN(Date.parse(tomb.deleted_at as string)),
      'deleted_at 必须是可解析的时刻'
    );
    assert.equal(cloud.rows.get('g-active')?.deleted_at, null, '活跃行不得带删除时刻（复位语义要干净）');
    assert.equal(cloud.rows.has('g-stale'), false, '覆盖仍应先删空云端旧行');
  });
});
