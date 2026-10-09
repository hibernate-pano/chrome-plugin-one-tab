// 认输预检（upload.ts 的 findConcededGroupIds）在缺列时的降级一致性。
//
// 本文件钉死一个 P2 缺陷 —— 同一个 schema 不一致，在别的路径无害、在这一条致命：
//
//   预检要在 upsert 之前查一次云端那几行的 id/is_deleted/last_op_device/last_op_seq，
//   挑出「云端已是更新的墓碑」的组让它认输。修复前它的错误处理是「任何 error 都抛」。
//   但同批的其它所有路径对缺列一律降级放行：src/utils/supabase/probe.ts 的
//   fetchTabGroupsDigest（42703/PGRST204/column → 回退最小列）、
//   src/web/webApi.ts 的两处读（→ 当作该列不存在）。
//   触发路径：supportsOpStamp 的探测结果在 SW 生命周期内被缓存为 true → 之后该列
//   被删（迁移回滚、换环境、schema 漂移）→ 预检每次都拿到缺列回应 →
//   **缓存窗口内每一次上传都失败**。MV3 SW 重启重置缓存后能自愈，所以不是永久
//   卡死，但这台设备当下的上传全废，且原因指向一条防卡死的机制。
//
// 修法：把预检的错误处理对齐到同批口径 —— 缺列（42703 / PGRST204 / column 关键字）
// → 降级放行（视作无印记列、跳过整段预检）；**非缺列的读失败仍然 fail-closed**，
// 绝不「读不出来就当没有要认输的组」。
//
// 假云端 = tests/syncUploadDownloadSafety.test.ts 那套 PostgREST 子集桩（GET/POST/
// PATCH/DELETE、eq./in()、select 投影、PGRST204 缺列降级，以及照抄 migration plpgsql
// 的两个 BEFORE UPDATE 守卫）。这里是同一套桩的整份拷贝：把它抽成 tests/_helpers 共享
// 模块必须改动 syncUploadDownloadSafety.test.ts，而那个文件属于另一个工作包，
// 本包不得越界。桩的语义（含守卫判定）与那份逐字一致，不另造第三套。
// 唯一新增的能力是 cloud.precheckFault：只对「认输预检发出的那一次 GET」（投影固定
// 为 id,is_deleted,last_op_device,last_op_seq）注入故障，用来钉住**这一次读**的
// 降级/抛错分支，而不让别的读跟着一起坏掉。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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

/** 源码断言用：读文件。路径相对仓库根（本文件在 tests/ 下）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

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

/** 认输预检（findConcededGroupIds）发出的那次 GET 的投影——故障注入靠它定位 */
const PRECHECK_COLS = ['id', 'is_deleted', 'last_op_device', 'last_op_seq'];

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

/** 只注入给「认输预检那一次 GET」的故障 */
type PrecheckFault =
  | { kind: 'missing-column'; column: string }
  | { kind: 'server-error' }
  | { kind: 'network' };

const cloud = {
  /** 云端实际存在的列（决定三个 supports* 探测落在哪个分支） */
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作 */
  ops: [] as string[],
  /** 认输预检那一次 GET 的故障；null = 正常 */
  precheckFault: null as PrecheckFault | null,
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
    if (key === 'select' || key === 'limit' || key === 'offset' || key === 'on_conflict' || key === 'order') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      // postgrest-js 实际发的是 in.(a,b)（4 字符前缀 'in.('，无引号）；带引号形式一并兼容
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

/**
 * 服务端两个 BEFORE UPDATE 守卫的逐条判定（照抄 migration 的 plpgsql）。
 * 迁移来源：
 *   - guard_tab_group_version：
 *     supabase/migrations/20260826064109_fix_version_guard_for_tombstones.sql
 *   - guard_tab_group_op_stamp：
 *     supabase/migrations/20260910_fix_op_stamp_guard_strict_lt.sql
 * 没有它，假云端会「老实接受」被守卫吞掉的写入，认输机制根本复现不出来。
 */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  // 两个 BEFORE UPDATE 触发器是**独立**的：任一返回 NULL 就整行丢弃。
  // version 守卫放行之后必须继续跑 op-stamp 守卫——is_deleted 翻转让 version
  // 守卫第 1 条放行，却仍然被 op-stamp 守卫按「严格更旧」静默吞掉。
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) {
    return old;
  }
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

    // 认输预检发出的那一次读：投影固定，单独注入故障。
    // 「schema 漂移」的形状是：探测结果在 SW 生命周期内被缓存为 true，之后预检
    // 这一读拿到缺列回应（PostgREST schema cache 里已经没有该列）。
    if (cloud.precheckFault && cols.join(',') === PRECHECK_COLS.join(',')) {
      cloud.ops.push(`PRECHECK:${cloud.precheckFault.kind}`);
      if (cloud.precheckFault.kind === 'network') throw new TypeError('fetch failed');
      if (cloud.precheckFault.kind === 'missing-column') {
        return missingColumnRes(cloud.precheckFault.column);
      }
      // 500：确定不是缺列（消息里没有 42703/PGRST204/column）
      return jsonRes({ message: 'Internal Server Error' }, 500);
    }

    for (const c of cols) {
      if (c !== '*' && cloud.columns[c] === false) return missingColumnRes(c);
    }
    const limitRaw = params.get('limit');
    const offsetRaw = params.get('offset');
    const limit = limitRaw ? Number(limitRaw) : Number.POSITIVE_INFINITY;
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    const data = [...cloud.rows.values()]
      .filter(r => matches(r, params))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(offset, offset + limit)
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

/** 本次有没有真的发出过「认输预检」那一次 GET */
function precheckHits(): string[] {
  return cloud.ops.filter(op => op.startsWith('PRECHECK:'));
}

before(async () => {
  register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(LOCAL_DEVICE));
  // 存量印记迁移跑过：本文件要考的是预检的错误处理，不让迁移改写种子数据的 stamp
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
  cloud.precheckFault = null;
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

// ─────────────────────────────────────────────────────────────────────────
// 关键用例 A（回归钉子）：预检读回缺列 → 上传必须照常完成
// ─────────────────────────────────────────────────────────────────────────
describe('认输预检的列缺失降级：缺列按「无印记列」放行', () => {
  it('预检拿到 PGRST204 时上传不失败：pending 被清、云端行照常落盘', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    await seedLocal([
      mkGroup('g-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } }),
      mkGroup('g-2', { lastOp: { d: LOCAL_DEVICE, s: 3 } }),
    ]);
    // 云端还没有这两行 → 本次是纯 INSERT，不存在任何守卫冲突：预检本该「无组认输」。
    // 但云端的印记列（探测结果已缓存为 true）此刻查不到了 —— 修复前预检对任何
    // error 都抛，这次上传直接失败，且缓存窗口内每次都失败。
    cloud.precheckFault = { kind: 'missing-column', column: 'last_op_seq' };
    await storage.setPendingUpload(true);

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.deepEqual(
      precheckHits(),
      ['PRECHECK:missing-column'],
      '用例前提没成立：预检那一次 GET 必须真的被打上缺列故障（否则本例会因别的原因通过）'
    );
    assert.equal(up.success, true, `缺列必须降级放行、上传照常完成（实得错误：${up.error ?? '无'}）`);
    assert.equal(
      await storage.getPendingUpload(),
      false,
      '上传成功才允许清 pending_upload'
    );
    // 降级不等于「这次什么都不写」：组必须真的上了云
    const upsert = cloud.ops.find(op => op.startsWith('UPSERT')) ?? '';
    assert.match(upsert, /g-1/, '本地组必须照常上行');
    assert.match(upsert, /g-2/, '本地组必须照常上行');
    assert.equal(cloud.rows.get('g-1')?.is_deleted, false, '云端行的删除位必须是活跃');
    assert.equal(cloud.rows.get('g-2')?.last_op_seq, 3, '印记必须随上行落盘');
  });

  it('降级放行不许变成「撤销云端删除」：云端墓碑原样保住，已删内容不复活', async () => {
    // 降级意味着「跳过预检」，不是「把本地当老大」。云端那行是另一台设备写的墓碑、
    // 印记更大时，本次上行会被服务端守卫静默吞掉，墓碑必须原封不动。
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    await seedLocal([mkGroup('dead-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } })]);
    cloud.rows.set('dead-1', cloudRow('dead-1', {
      is_deleted: true,
      last_op_device: REMOTE_DEVICE,
      last_op_seq: 9,
      updated_at: LATER,
      deleted_at: LATER,
    }));
    cloud.precheckFault = { kind: 'missing-column', column: 'last_op_seq' };
    await storage.setPendingUpload(true);

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(up.success, true, `缺列降级后上传仍应完成（实得错误：${up.error ?? '无'}）`);
    const row = cloud.rows.get('dead-1');
    assert.equal(row?.is_deleted, true, '云端墓碑绝不能被一次降级放行的上传翻回活跃（已删内容会复活）');
    assert.equal(row?.last_op_seq, 9, '云端墓碑的印记不该被本地旧值覆盖');
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '认输不靠本地广播：云端已是墓碑，不需要再登记删除广播'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 关键用例 B：非列缺失的读失败仍然 fail-closed
// ─────────────────────────────────────────────────────────────────────────
describe('非缺列的预检读失败：必须 fail-closed', () => {
  for (const fault of [
    { kind: 'server-error' as const, label: '服务端 500' },
    { kind: 'network' as const, label: '传输层中断' },
  ]) {
    it(`${fault.label}：上传失败、pending_upload 保留，绝不「读不出来=没有要认输的组」`, async () => {
      const { syncEngine } = await import('@/services/syncEngine');
      const { storage } = await import('@/utils/storage');

      await seedLocal([mkGroup('g-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } })]);
      cloud.precheckFault = fault;
      await storage.setPendingUpload(true);

      const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

      assert.deepEqual(precheckHits(), [`PRECHECK:${fault.kind}`], '用例前提：预检那一次 GET 确实失败了');
      assert.equal(up.success, false, '读不出预检结果就不该发这次 upsert（放行=注定被守卫吞写）');
      assert.equal(
        await storage.getPendingUpload(),
        true,
        '失败必须保留 pending_upload 走下轮重试，清掉它就等于假装同步成功'
      );
      assert.equal(
        cloud.ops.some(op => op.startsWith('UPSERT')),
        false,
        '预检没读出结果时不得已经开写'
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 关键用例 C：正常路径不受影响——认输判定照旧生效
// ─────────────────────────────────────────────────────────────────────────
describe('正常路径：认输判定照旧生效', () => {
  it('预检挑出的组确实没被写上去，云端墓碑与本地幸存的组都完好', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');

    await seedLocal([
      mkGroup('dead-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } }),
      mkGroup('keep-1', { lastOp: { d: LOCAL_DEVICE, s: 2 } }),
    ]);
    cloud.rows.set('dead-1', cloudRow('dead-1', {
      is_deleted: true,
      last_op_device: REMOTE_DEVICE,
      last_op_seq: 9,
      updated_at: LATER,
      deleted_at: LATER,
    }));
    await storage.setPendingUpload(true);

    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });

    assert.equal(up.success, true, `上传必须成功（实得错误：${up.error ?? '无'}）`);
    assert.equal(precheckHits().length, 0, '正常路径下预检不该遇到任何故障');
    const upsert = cloud.ops.find(op => op.startsWith('UPSERT')) ?? '';
    assert.match(upsert, /keep-1/, '幸存的组必须照常上行');
    assert.doesNotMatch(upsert, /dead-1/, '认输的组本次不应参与 upsert（撞守卫只会静默吞写）');
    assert.equal(cloud.rows.get('dead-1')?.is_deleted, true, '云端墓碑必须仍是墓碑');
    assert.equal(cloud.rows.get('dead-1')?.last_op_seq, 9, '云端墓碑的印记不该被本地旧值覆盖');
    assert.equal(await storage.getPendingUpload(), false, '成功才清 pending_upload');
  });
});

describe('删除链路必须用严格列探测（2026-10-09 数据安全 P1-4）', () => {
  // ── 为什么这是独立的一条，而不是「统一改成 fail-closed」 ────────────────
  //
  // supportsOpStamp() 的结果被四条链路消费，**只有删除链路不能 fail-open**：
  //   上传（upload.ts:364）  → 少带一列，退化但仍能上传     → fail-open 正确
  //   下载（download.ts:185）→ 退化成 select('*')，照常成功 → fail-open 正确
  //   digest（probe.ts:182） → 退化成最小列集              → fail-open 正确
  //   删除广播（upload.ts:761）→ 「不知道有没有列」被翻译成「按没有来写墓碑」
  //
  // 删除广播 fail-open 的具体后果：plain 墓碑不带 last_op_seq，云端印记停在旧值；
  // 对端合并要求云端墓碑印记**严格大于**本地才服从（持平 → compareStamps>=0 → 本地赢），
  // 于是删除被静默吞掉、对端保留该组，之后任一编辑就把它复活。
  //
  // 【第一版修法已被现有测试证否】直接让 supportsOpStamp() 抛错：守卫绿，
  // 但全量 fail 7 —— 打红的正是 downloadChain.test.ts:783「宁可少选列，不可让
  // 整次下载失败」，那条断言有意且正确。所以正确方向是**按调用方分流**。
  const PROBE = 'src/utils/supabase/probe.ts';
  const UPLOAD = 'src/utils/supabase/upload.ts';
  const src = read(PROBE);
  const upload = read(UPLOAD);

  it('supportsOpStampStrict 必须存在，且只在确定性缺列时返回 false', () => {
    assert.match(
      src,
      /export async function supportsOpStampStrict\(\):\s*Promise<boolean>/,
      '缺少 supportsOpStampStrict —— 删除链路没有严格版探测可用'
    );

    const start = src.indexOf('export async function supportsOpStampStrict');
    assert.ok(start > -1, '找不到 supportsOpStampStrict');
    // 切到下一个顶层定义为止
    const rest = src.slice(start + 10);
    const next = rest.search(/\n\/\*\*|\nexport (?:async )?function|\nexport const/);
    const fn = next === -1 ? rest : rest.slice(0, next);

    // 严格版的全部 return false 只能来自「确定性缺列」这一条路径
    const falseReturns = (fn.match(/return false;/g) || []).length;
    assert.equal(
      falseReturns,
      1,
      `supportsOpStampStrict 里有 ${falseReturns} 处 return false，应恰好 1 处 —— ` +
        '多出来的必然是把「非确定性失败」也当成「没有列」，那等于没改成严格版'
    );
    // 那唯一一处必须紧跟 PGRST204 / last_op_seq 判定
    assert.match(
      fn,
      /PGRST204[\s\S]{0,400}return false;/,
      '唯一的 return false 必须由 PGRST204 / last_op_seq（确定性缺列）守卫'
    );
    // 非确定性失败必须抛错，且要说清「拒绝执行」
    assert.match(
      fn,
      /throw new Error\(\s*`?\[op-stamp-strict\][\s\S]{0,200}?拒绝/,
      '非确定性失败必须抛错并明说「拒绝」—— 返回 false 就是 fail-open，删除会被静默吞掉'
    );
    // 未配置时同样不能当「没有列」
    assert.match(
      fn,
      /!isSupabaseConfigured\(\)[\s\S]{0,300}?throw new Error/,
      '未配置 Supabase 时必须抛错（无法回答列在不在），不能返回 false'
    );
  });

  it('markCloudGroupsAsDeleted 必须调 strict 版，不能调宽松版', () => {
    // 【第一版切片写错了】用 'async function markCloudGroupsAsDeleted' 定位，
    // 但它是**类方法**（`  async markCloudGroupsAsDeleted(deletedIds)`），
    // indexOf 返回 -1 → 我用 `slice(-1)` 拿到文件最后一个字符，
    // 断言于是对着一段无意义文本运行 —— 守卫看着在，其实在测空气。
    const start = upload.indexOf('async markCloudGroupsAsDeleted');
    assert.ok(start > -1, '找不到 markCloudGroupsAsDeleted（注意它是类方法，不是 async function）');
    const rest = upload.slice(start);
    const next = rest.search(/\n {2}(?:async |private |public )?\w+\s*\(/);
    const fn = next === -1 ? rest : rest.slice(0, next);

    assert.match(
      fn,
      /supportsOpStampStrict\(\)/,
      '删除广播必须用 supportsOpStampStrict() —— 宽松版会把网络抖动翻译成「按没有印记列写墓碑」。' +
        '（注意它在 Promise.all 里，没有 await 前缀；断言按调用形态写，别绑 await）'
    );
    assert.ok(
      // 负向断言要排除 strict 版，否则 /supportsOpStamp\(\)/ 不会匹配到 strict（括号不紧邻）
      !/(?<!Strict)supportsOpStamp\(\)/.test(fn),
      '删除广播仍在调宽松版 supportsOpStamp() —— 那是 P1-4 的原始缺陷形态'
    );
  });

  it('另外三条链路必须继续用宽松版（不能一刀切改成严格）', () => {
    // 一刀切的代价是实测过的：会让「宁可少选列，不可让整次下载失败」失效，
    // 一次网络抖动就可能让整次下载失败。分流是有意的，不是遗漏。
    for (const file of ['src/utils/supabase/download.ts', 'src/utils/supabase/probe.ts']) {
      const code = read(file);
      assert.match(
        code,
        /supportsOpStamp\(\)/,
        `${file} 应继续使用宽松版 supportsOpStamp() —— ` +
          '它们的 fail-open 退化是安全的（少选一列 / 最小列集），改成严格会造成真实可用性回退'
      );
    }
    // 上传路径同理
    assert.match(
      upload,
      /await supportsOpStamp\(\)/,
      '上传路径应继续使用宽松版（少带一列仍能上传）'
    );
  });
});
