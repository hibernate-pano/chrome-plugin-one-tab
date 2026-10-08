// 上传分批 upsert + 下载分页（1.22.14）的回归测试。
//
// Bug：此前 uploadTabGroups 把整库塞进单个 upsert、downloadTabGroups 用单次
// 全表 select —— 大库下两者都撞网关体积/超时上限，表现为「同步卡死报错、
// 60s alarm 无限整库重传」。修复：upsert 按 UPSERT_ROW_BATCH_SIZE=50 分批，
// download 按 DOWNLOAD_PAGE_SIZE=200 分页（offset/limit 参数）。
//
// 断言真实的云端落库与请求形状（批次大小 / 页参数），复用
// overwriteTombstone.test.ts 的 fetch 层假云端模式。

import { describe, it, before } from 'node:test';
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

before(async () => {
  register(LOADER_PATH);
});

const USER_ID = 'user-batch-test';
const SESSION_KEY = 'sb-stub-auth-token';

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
store.set(SESSION_KEY, stubSessionJson(USER_ID));

interface CloudRow {
  id: string;
  user_id: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  tabs_data?: unknown;
  is_deleted?: boolean;
  last_op_device?: string | null;
  last_op_seq?: number | null;
  version?: number | null;
  [k: string]: unknown;
}

const cloud = {
  rows: new Map<string, CloudRow>(),
  /** 每次 POST（upsert）的行数，按发生顺序 */
  upsertBatches: [] as number[],
  /** 每次 GET 的 (offset, limit)，按发生顺序 */
  getPages: [] as Array<{ offset: number; limit: number }>,
  // ── 1.22.15：tabs 表回填的截断保护 ────────────────────────────────
  /** 假网关 db-max-rows：GET 响应单次最多吐这么多行（静默截断，不报错）。null = 不截断 */
  maxRows: null as number | null,
  /** /rest/v1/tabs GET 的回填行（1.22.15 回填截断用例；空 = 旧行为返回空） */
  tabsBackfillRows: [] as CloudRow[],
};

function resetCloud() {
  cloud.rows.clear();
  cloud.upsertBatches.length = 0;
  cloud.getPages.length = 0;
  cloud.maxRows = null;
  cloud.tabsBackfillRows.length = 0;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'on_conflict', 'order'].includes(key)) continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    }
  }
  return true;
}

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups') && !url.pathname.endsWith('/rest/v1/tabs')) {
    return jsonRes({ message: 'not found' }, 404);
  }

  const params = url.searchParams;

  if (method === 'GET') {
    // 1.22.15：{ count: 'exact' } 走 Prefer 头 → 响应必须回 Content-Range 头
    // （supabase-js 从这里解析 count）。init.headers 可能是 Headers 实例，统一走 API 读。
    const wantsCount =
      new Headers((init.headers as HeadersInit | undefined) ?? {}).get('Prefer')?.includes('count=exact') ?? false;
    const withCountHeaders = (payload: unknown, total: number) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-range': `0-${total - 1}/${total}`,
        },
      });
    if (url.pathname.endsWith('/rest/v1/tabs')) {
      // 空组回退查询：默认返回空（测试数据都带 tabs_data: []）；
      // tabsBackfillRows 非空时回这些行（1.22.15 回填截断用例）。
      // 同时支持假网关 db-max-rows 截断（静默截到 maxRows 行，与 PostgREST 一致不报错）。
      const total = cloud.tabsBackfillRows.filter(r => matches(r, params)).length;
      let data = cloud.tabsBackfillRows
        .filter(r => matches(r, params))
        .map(r => ({ ...r } as CloudRow));
      if (cloud.maxRows !== null && data.length > cloud.maxRows) data = data.slice(0, cloud.maxRows);
      if (wantsCount) return withCountHeaders(data, total);
      return jsonRes(data);
    }
    // supportsOpStamp() 等列探测也是对 tab_groups 的 GET，带 limit=1 但没有
    // offset —— 只记录真正带 offset 的下载页请求。
    if (params.has('offset')) {
      cloud.getPages.push({
        offset: Number(params.get('offset') ?? 0),
        limit: Number(params.get('limit') ?? 0),
      });
    }
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    const offset = Number(params.get('offset') ?? 0);
    const limit = Number(params.get('limit') ?? Number.POSITIVE_INFINITY);
    const total = [...cloud.rows.values()].filter(r => matches(r, params)).length;
    let data = [...cloud.rows.values()]
      .filter(r => matches(r, params))
      .slice(offset, offset + limit)
      .map(r => {
        const out: CloudRow = {} as CloudRow;
        for (const c of cols) {
          if (c === '*') Object.assign(out, r);
          else (out as any)[c] = (r as any)[c];
        }
        return out;
      });
    if (cloud.maxRows !== null && data.length > cloud.maxRows) data = data.slice(0, cloud.maxRows);
    if (wantsCount) return withCountHeaders(data, total);
    return jsonRes(data);
  }

  if (method === 'POST') {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '[]');
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    cloud.upsertBatches.push(rows.length);
    for (const row of rows) {
      cloud.rows.set(row.id, { ...row });
    }
    return jsonRes(rows);
  }

  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (matches(row, params)) cloud.rows.delete(id);
    }
    return jsonRes([]);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

function mkGroup(id: string) {
  return {
    id,
    name: id,
    tabs: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    isLocked: false,
    version: 1,
    lastOp: { d: 'devBatch', s: 1 },
  } as any;
}

async function loadModules() {
  resetCloud();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  const { uploadSync } = await import('@/utils/supabase/upload');
  const { downloadSync } = await import('@/utils/supabase/download');
  return {
    uploadTabGroups: uploadSync.uploadTabGroups,
    downloadTabGroups: downloadSync.downloadTabGroups,
  };
}

describe('uploadTabGroups 分批 upsert（1.22.14）', () => {
  it('超过 50 行时拆成多批 POST，每批 ≤50，总和等于总行数', async () => {
    const { uploadTabGroups } = await loadModules();
    const groups = Array.from({ length: 130 }, (_, i) => mkGroup(`g-${i}`));
    await uploadTabGroups(groups, false);

    assert.equal(cloud.rows.size, 130, '全部 130 行应落库');
    assert.ok(cloud.upsertBatches.length === 3, `应分 3 批，实际 ${cloud.upsertBatches.length}`);
    for (const size of cloud.upsertBatches) {
      assert.ok(size <= 50, `每批应 ≤50 行，实际 ${size}`);
    }
    assert.equal(cloud.upsertBatches.reduce((a, b) => a + b, 0), 130, '分批总和应等于总行数');
  });

  it('30 行单批完成（不强制拆分）', async () => {
    const { uploadTabGroups } = await loadModules();
    const groups = Array.from({ length: 30 }, (_, i) => mkGroup(`g-${i}`));
    await uploadTabGroups(groups, false);

    assert.equal(cloud.rows.size, 30);
    assert.equal(cloud.upsertBatches.length, 1, '30 行应单批完成');
  });
});

describe('downloadTabGroups 分页（1.22.14）', () => {
  it('450 行分 3 页（每页 200），取回全部', async () => {
    const { downloadTabGroups } = await loadModules();
    for (let i = 0; i < 450; i++) {
      cloud.rows.set(`g-${i}`, {
        id: `g-${i}`,
        user_id: USER_ID,
        name: `g-${i}`,
        tabs_data: [],
        created_at: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
        updated_at: '2026-10-07T00:00:00.000Z',
      });
    }

    const groups = await downloadTabGroups();

    assert.equal(groups.length, 450, `应取回全部 450 行，实际 ${groups.length}`);
    assert.equal(cloud.getPages.length, 3, `应发 3 页请求，实际 ${cloud.getPages.length}`);
    assert.deepEqual(
      cloud.getPages,
      [
        { offset: 0, limit: 200 },
        { offset: 200, limit: 200 },
        { offset: 400, limit: 200 },
      ],
      '页参数应为 (0,200) (200,200) (400,200)'
    );
  });

  it('50 行单页完成', async () => {
    const { downloadTabGroups } = await loadModules();
    for (let i = 0; i < 50; i++) {
      cloud.rows.set(`g-${i}`, {
        id: `g-${i}`,
        user_id: USER_ID,
        name: `g-${i}`,
        tabs_data: [],
        created_at: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
        updated_at: '2026-10-07T00:00:00.000Z',
      });
    }

    const groups = await downloadTabGroups();
    assert.equal(groups.length, 50);
    assert.equal(cloud.getPages.length, 1, '50 行应单页完成');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1.22.15：旧 tabs 表回填的截断保护
//
// 老版本组的 tabs_data 为空，下载时逐组回查 /rest/v1/tabs。该查询此前既无分页
// 也无 count：网关 db-max-rows（默认 1000）静默截断响应后，还原率检查拿**截断
// 后**的 tabs.length 当分母 → 比值恒 1.0 → 截断组被接受并回写云端（w2 复现）。
// 修复：查询带 { count: 'exact' }；tabs.length != count 时把该组并入
// truncatedByTabsTable 整组跳过（与还原率判据的「截断组整组拿掉」同策略）；
// 还原率分母改用真实 count。
describe('1.22.15：tabs 表回填的截断保护', () => {
  /** 造一个 tabs_data 为空的老版本组（触发 tabs 表回填路径） */
  function seedLegacyGroup(id: string) {
    cloud.rows.set(id, {
      id,
      user_id: USER_ID,
      name: id,
      tabs_data: [],
      created_at: new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
      updated_at: '2026-10-07T00:00:00.000Z',
    });
  }

  it('回填行数超 db-max-rows 被静默截断 → 该组整组跳过，绝不带着截断数据回写', async () => {
    const { downloadTabGroups } = await loadModules();
    seedLegacyGroup('g-legacy-huge');
    // 云端真实有 700 行，假网关单响应最多吐 300 行（静默截断）
    cloud.tabsBackfillRows = Array.from({ length: 700 }, (_, i) => ({
      id: `lt-${i}`,
      group_id: 'g-legacy-huge',
      user_id: USER_ID,
      url: `https://legacy.example.com/t${i}`,
      title: `t${i}`,
      created_at: '2026-01-01T00:00:00.000Z',
      last_accessed: '2026-01-01T00:00:00.000Z',
      pinned: false,
    })) as unknown as CloudRow[];
    cloud.maxRows = 300;

    const groups = await downloadTabGroups();

    assert.equal(
      groups.some(g => g.id === 'g-legacy-huge'),
      false,
      '回填被截断的组必须整组跳过：旧行为（无 count 校验）会把它当成 300/300 还原率 ' +
        '1.0 的完整组接受并回写云端，剩余 400 行在所有设备上永久消失'
    );
    assert.equal(
      groups.some(g => g.tabs.length === 0),
      false,
      '更不能退化成零标签空组（会被下游硬删并登记 purge）'
    );
  });

  it('count 与实际一致时正常回填：还原率判据分母用真实 count', async () => {
    const { downloadTabGroups } = await loadModules();
    seedLegacyGroup('g-legacy-ok');
    cloud.tabsBackfillRows = [
      {
        id: 'lt-ok-1',
        group_id: 'g-legacy-ok',
        user_id: USER_ID,
        url: 'https://legacy.example.com/a',
        title: 'A',
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed: '2026-01-01T00:00:00.000Z',
        pinned: false,
      },
      {
        id: 'lt-ok-2',
        group_id: 'g-legacy-ok',
        user_id: USER_ID,
        url: 'https://legacy.example.com/b',
        title: 'B',
        created_at: '2026-01-01T00:00:00.000Z',
        last_accessed: '2026-01-01T00:00:00.000Z',
        pinned: false,
      },
    ] as unknown as CloudRow[];

    const groups = await downloadTabGroups();

    const legacy = groups.find(g => g.id === 'g-legacy-ok');
    assert.ok(legacy, '未截断时回填组必须正常出现在结果里');
    assert.equal(legacy!.tabs.length, 2, '全部标签正常回填');
  });
});
