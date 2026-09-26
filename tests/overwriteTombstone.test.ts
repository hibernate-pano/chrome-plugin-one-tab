// 覆盖上传（overwriteCloud）墓碑丢失 bug 的锁定测试。
//
// Bug：覆盖模式先 DELETE 掉云端该用户的全部行，再 upsert —— 但 uploadTabGroups
// 收到的 groups 里被 syncEngine 过滤掉了墓碑（activeGroups = !isDeleted），
// 于是删除意图随覆盖一起丢失：本地墓碑在 IndexedDB 里还在，云端却没有墓碑行，
// 另一端持有的活跃副本下次合并即复活该组；markCloudGroupsAsDeleted 随后按
// 「id 在云端不存在」跳过（无行可复活），整条链路静默成功。
//
// 修复：覆盖模式把本地墓碑一起交给 uploadTabGroups，随同一次 upsert 写上云；
// is_deleted 按本地判定逐行推导（活跃=false / 墓碑=true，一条规则同时保住
// 「Web 端软删、本地仍活跃 → 复位为活跃」的恢复语义）。
//
// 本文件用 fetch 层假云端（PostgREST / GoTrue 子集）跑真实的 uploadTabGroups：
// 断言落库的云端行，而不是断言内部调用次数。覆盖 stamp / plain / hard-delete
// 三种列形态（decideCloudTombstoneWrite 的三个返回值）。
//
// 文件样板与 tests/webDeleteTombstone.test.ts 一致：@/ 别名模块只能动态 import，
// 且环境桩（localStorage / fetch）必须在 import 被测模块之前就位。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const USER_ID = 'user-under-test';
const SUPABASE_HOST = 'https://stub.supabase.co';
// supabase-js 默认 storageKey：sb-<hostname 首段>-auth-token
const SESSION_KEY = 'sb-stub-auth-token';
const NOW = '2026-09-24T08:00:00.000Z';
const LATER = '2026-09-24T09:00:00.000Z';

// ── 环境桩 1：localStorage（supabase session 持久化 + KV 回退驱动） ─────────
function installLocalStorageStub() {
  const map = new Map<string, string>();
  const stub = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  (globalThis as any).localStorage = stub;
  return map;
}

const store = installLocalStorageStub();

// 未过期的假 session：uploadTabGroups 前置的 getSession/getUser 都靠它放行。
// expires_at 放到未来，避免 supabase-js 触发自动刷新定时器。
store.set(
  SESSION_KEY,
  JSON.stringify({
    access_token: 'stub-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'stub-refresh-token',
    user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' },
  })
);

// ── 环境桩 2：假云端（PostgREST 子集） ────────────────────────────────────
interface CloudRow {
  id: string;
  user_id: string;
  name?: string;
  updated_at?: string;
  is_deleted?: boolean;
  last_op_device?: string | null;
  last_op_seq?: number | null;
  [k: string]: unknown;
}

type ColumnMode = 'stamp' | 'plain' | 'hard-delete';

const cloud = {
  /** 云端实际存在的列（决定 decideCloudTombstoneWrite 落在哪个模式） */
  columns: { is_deleted: true, last_op_seq: true } as { is_deleted: boolean; last_op_seq: boolean },
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作，用于断言 DELETE 先于 upsert */
  ops: [] as string[],
};

function applyColumnMode(mode: ColumnMode) {
  cloud.columns = {
    is_deleted: mode !== 'hard-delete',
    last_op_seq: mode === 'stamp',
  };
  cloud.rows.clear();
  cloud.ops.length = 0;
}

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

/** 极简 PostgREST 过滤：user_id=eq.X、id=in.("a","b") */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'on_conflict') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      // postgrest-js 实际发的是 in.(a,b)（4 字符前缀 'in.('，无引号）；带引号形式一并兼容
      const ids = raw.slice(4, -1).split(',').map(s => s.replace(/"/g, '').trim());
      if (!ids.includes(String(row.id))) return false;
    } else {
      throw new Error(`假云端不认识的过滤器: ${key}=${raw}`);
    }
  }
  return true;
}

function project(row: CloudRow, cols: string[]): CloudRow {
  const out: CloudRow = {} as CloudRow;
  for (const c of cols) (out as any)[c] = row[c];
  return out;
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
      if (c === 'is_deleted' && !cloud.columns.is_deleted) return missingColumnRes(c);
      if (c === 'last_op_seq' && !cloud.columns.last_op_seq) return missingColumnRes(c);
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
    cloud.ops.push(`DELETE:${params.get('user_id') ?? ''}`);
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written: CloudRow[] = [];
    for (const row of rows) {
      // upsert（onConflict: id）：按主键覆盖
      cloud.rows.set(row.id, { ...row });
      written.push(row);
    }
    cloud.ops.push(`UPSERT:${written.map(r => `${r.id}=${String(r.is_deleted)}`).join(',')}`);
    return jsonRes(written);
  }

  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      const next = { ...row, ...body };
      cloud.rows.set(id, next);
      touched.push(next);
    }
    cloud.ops.push(`PATCH:${Object.keys(body).join(',')}`);
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 测试数据 ──────────────────────────────────────────────────────────────
function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [],
    createdAt: NOW,
    updatedAt: LATER,
    isLocked: false,
    version: 1,
    ...overrides,
  } as any;
}

const ACTIVE = mkGroup('g-active', { lastOp: { d: 'devExt', s: 3 } });
const TOMBSTONES = [
  mkGroup('g-tomb-1', { isDeleted: true, lastOp: { d: 'devExt', s: 5 } }),
  mkGroup('g-tomb-2', { isDeleted: true, lastOp: { d: 'devExt', s: 6 } }),
  mkGroup('g-tomb-3', { isDeleted: true, lastOp: { d: 'devExt', s: 7 } }),
];

async function loadUploadModule(mode: ColumnMode) {
  applyColumnMode(mode);
  const probe = await import('@/utils/supabase/probe');
  // 列探测结果是进程内单例缓存；三种列形态要能在同一进程里分别跑
  probe.__resetCloudColumnProbeCacheForTests();
  const { uploadSync, selectRowsForUpload } = await import('@/utils/supabase/upload');
  return { uploadTabGroups: uploadSync.uploadTabGroups, selectRowsForUpload };
}

// ── selectRowsForUpload：哪一行真的上行 ──────────────────────────────────
describe('selectRowsForUpload: 覆盖模式必须把墓碑一起上行', () => {
  it('覆盖 + 有 is_deleted 列 → 活跃组与墓碑组全部上行', async () => {
    const { selectRowsForUpload } = await loadUploadModule('stamp');
    const rows = selectRowsForUpload([ACTIVE, ...TOMBSTONES], {
      overwriteCloud: true,
      tombstoneColumn: true,
    });
    assert.deepEqual(rows.map(g => g.id), ['g-active', 'g-tomb-1', 'g-tomb-2', 'g-tomb-3']);
  });

  it('覆盖 + 无 is_deleted 列（hard-delete 降级）→ 墓碑不上行（避免 42703 整批失败）', async () => {
    const { selectRowsForUpload } = await loadUploadModule('hard-delete');
    const rows = selectRowsForUpload([ACTIVE, ...TOMBSTONES], {
      overwriteCloud: true,
      tombstoneColumn: false,
    });
    assert.deepEqual(rows.map(g => g.id), ['g-active']);
  });

  it('合并模式 → 只上行活跃组（墓碑仍走 markCloudGroupsAsDeleted）', async () => {
    const { selectRowsForUpload } = await loadUploadModule('stamp');
    const rows = selectRowsForUpload([ACTIVE, ...TOMBSTONES], {
      overwriteCloud: false,
      tombstoneColumn: true,
    });
    assert.deepEqual(rows.map(g => g.id), ['g-active']);
  });
});

// ── 端到端：覆盖上传后云端行的 is_deleted ────────────────────────────────
describe('uploadTabGroups 覆盖模式：1 活跃 + 3 墓碑全部落云（stamp 模式）', () => {
  it('四行都在，且墓碑行 is_deleted=true / 活跃行 false，印记不被抹掉', async () => {
    const { uploadTabGroups } = await loadUploadModule('stamp');
    await uploadTabGroups([ACTIVE, ...TOMBSTONES], true);

    assert.equal(cloud.rows.size, 4, '覆盖后云端应有 4 行（1 活跃 + 3 墓碑）');
    assert.equal(cloud.rows.get('g-active')?.is_deleted, false);
    for (const t of TOMBSTONES) {
      const row = cloud.rows.get(t.id);
      assert.ok(row, `墓碑组 ${t.id} 必须作为墓碑行留在云端，否则删除意图随覆盖丢失`);
      assert.equal(row!.is_deleted, true, `${t.id} 必须是墓碑`);
      assert.equal(row!.last_op_device, 'devExt');
      assert.equal(row!.last_op_seq, t.lastOp.s);
    }
    // 覆盖的先删后插顺序：DELETE 必须发生在 upsert 之前
    assert.equal(cloud.ops[0], `DELETE:eq.${USER_ID}`);
    assert.ok(cloud.ops[1]?.startsWith('UPSERT:'), `期望紧随其后是 upsert，实得 ${cloud.ops[1]}`);
  });

  it('墓碑组与活跃组同批写入同一次 upsert（不是先活跃、后补 UPDATE）', async () => {
    const { uploadTabGroups } = await loadUploadModule('stamp');
    await uploadTabGroups([ACTIVE, ...TOMBSTONES], true);
    const upserts = cloud.ops.filter(o => o.startsWith('UPSERT:'));
    assert.equal(upserts.length, 1, '墓碑必须并入这一次覆盖 upsert');
    assert.match(upserts[0], /g-tomb-1=true/);
    assert.match(upserts[0], /g-active=false/);
  });
});

describe('uploadTabGroups 覆盖模式 · plain 模式（有 is_deleted、无印记列）', () => {
  it('四行都在，墓碑 is_deleted=true，payload 不含印记列', async () => {
    const { uploadTabGroups } = await loadUploadModule('plain');
    await uploadTabGroups([ACTIVE, ...TOMBSTONES], true);

    assert.equal(cloud.rows.size, 4);
    for (const t of TOMBSTONES) {
      assert.equal(cloud.rows.get(t.id)?.is_deleted, true, `${t.id} 必须是墓碑`);
    }
    assert.equal(cloud.rows.get('g-active')?.is_deleted, false);
    for (const row of cloud.rows.values()) {
      assert.equal('last_op_seq' in row, false, '云端无印记列时 payload 不得带印记列');
    }
  });
});

describe('uploadTabGroups 覆盖模式 · hard-delete 降级（云端无 is_deleted 列）', () => {
  it('墓碑行不上行：覆盖已把云端清空，「行不存在」即删除意图，不留复活面', async () => {
    const { uploadTabGroups } = await loadUploadModule('hard-delete');
    // 预置一条云端活跃行，覆盖后应被活跃组替换、墓碑组彻底不出现
    cloud.rows.set('g-stale', { id: 'g-stale', user_id: USER_ID, updated_at: NOW });
    await uploadTabGroups([ACTIVE, ...TOMBSTONES], true);

    assert.equal(cloud.rows.has('g-stale'), false, '覆盖应先删掉全部旧行');
    assert.equal(cloud.rows.size, 1);
    assert.deepEqual([...cloud.rows.keys()], ['g-active']);
    assert.equal('is_deleted' in cloud.rows.get('g-active')!, false, '无该列时不得写该列');
  });
});

// ── 语义不回归：Web 端软删、本地仍活跃 → 覆盖/合并都必须复位为活跃 ────────
describe('回归保护：本地活跃组写 is_deleted=false（Web 恢复语义不丢）', () => {
  it('覆盖模式：云端预置 is_deleted=true 的组被本地活跃组复位为 false', async () => {
    const { uploadTabGroups } = await loadUploadModule('stamp');
    cloud.rows.set('g-active', { id: 'g-active', user_id: USER_ID, is_deleted: true, updated_at: NOW });
    await uploadTabGroups([ACTIVE, ...TOMBSTONES], true);
    assert.equal(cloud.rows.get('g-active')?.is_deleted, false);
  });

  it('合并模式（overwriteCloud=false）：同样复位为 false，且墓碑组不由本次写入', async () => {
    const { uploadTabGroups } = await loadUploadModule('stamp');
    cloud.rows.set('g-active', { id: 'g-active', user_id: USER_ID, is_deleted: true, updated_at: NOW });
    await uploadTabGroups([ACTIVE], false);
    assert.equal(cloud.rows.size, 1);
    assert.equal(cloud.rows.get('g-active')?.is_deleted, false);
  });
});

// ── 读回校验：墓碑行也纳入 verifyUploadReadback（不能只校验活跃组） ───────
describe('读回校验：墓碑行必须按 is_deleted=true 校验', () => {
  it('服务端把墓碑行静默吞掉（upsert 成功但行不存在）→ 上抛报错，不假装成功', async () => {
    const { verifyUploadReadback } = await import('@/utils/supabase/readback');
    applyColumnMode('stamp');
    const expect = [
      { id: 'a', updatedAt: LATER, lastOp: null, isDeleted: false },
      { id: 'b', updatedAt: LATER, lastOp: null, isDeleted: true },
    ];
    // 只回了活跃行，墓碑行被守卫吞写
    cloud.rows.set('a', { id: 'a', user_id: USER_ID, updated_at: LATER, is_deleted: false });
    await assert.rejects(
      () => verifyUploadReadback(expect, USER_ID, { checkStamp: false, checkTombstone: true }),
      /云端缺失组 b/
    );
  });

  it('墓碑行读回 is_deleted=false → 判为「墓碑未落盘」并抛错', async () => {
    const { verifyUploadReadback } = await import('@/utils/supabase/readback');
    applyColumnMode('stamp');
    const expect = [{ id: 'b', updatedAt: LATER, lastOp: null, isDeleted: true }];
    cloud.rows.set('b', { id: 'b', user_id: USER_ID, updated_at: LATER, is_deleted: false });
    await assert.rejects(
      () => verifyUploadReadback(expect, USER_ID, { checkStamp: false, checkTombstone: true }),
      /墓碑未落盘/
    );
  });

  it('墓碑行读回 is_deleted=true → 校验通过', async () => {
    const { verifyUploadReadback } = await import('@/utils/supabase/readback');
    applyColumnMode('stamp');
    const expect = [{ id: 'b', updatedAt: LATER, lastOp: null, isDeleted: true }];
    cloud.rows.set('b', { id: 'b', user_id: USER_ID, updated_at: LATER, is_deleted: true });
    await verifyUploadReadback(expect, USER_ID, { checkStamp: false, checkTombstone: true });
  });
});
