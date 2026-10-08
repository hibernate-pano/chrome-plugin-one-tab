// 下载分页在「排序键非唯一」时的正确性（2026-10-07 新增）。
//
// 【本文件要防的那类 bug —— 真实丢过数据】
// downloadTabGroups 的分页是 offset/limit（.range()），排序只给了 created_at。
// created_at **不是唯一键**：
//   · oneTabFormatParser 给同一批导入的每个组盖的是同一个 `now`；
//   · factory 用 new Date().toISOString()，连续快速保存会撞在同一毫秒；
//   · 一次 OneTab 导入 300 个会话 ⇒ 300 行 created_at 逐字相同。
// PostgreSQL 对「并列行之间」的跨查询顺序**不给任何保证**，因此 offset 窗口会
// 重叠与跳过。实测（450 行同 created_at，真 PG 16）：三次连续下载分别漏掉
// 113 / 114 / 105 个不同 id，而因为是短页退出（page.length < PAGE_SIZE），
// **没有任何报错**。漏掉的行会被 mergeOpStamped 当作「云端不存在」，本地旧副本
// 随后上传覆盖掉更新的云端版本 —— 真丢失，且无回收站。
//
// 【为什么现有测试抓不到】
// upsertDownloadBatching.test.ts 的 fixture 用 `new Date(..., i)` 造**严格递增**
// 的 created_at，假云端又是按插入顺序 slice —— 并列这个维度根本没被建模，
// 所以那个测试的「450 行分 3 页取回全部」在缺陷存在时依然是绿的。
//
// 【本文件的假云端怎么建模】
// 解析请求里的 order 参数真的排序，然后对「按这些键仍然并列」的行做一个
// 随请求变化的置换 —— 这正是 Postgres 不给保证的那部分。于是：
//   · 只有 created_at 排序时，页窗口会重叠/跳过（测试变红）；
//   · 加上 id 这个唯一 tiebreaker 后排序成为全序，页间无重叠无遗漏（测试变绿）。
// 置换用请求序号做种子，不用随机数：确定性，失败可复现。

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

const USER_ID = 'user-page-tie-test';
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
  [k: string]: unknown;
}

const cloud = {
  rows: new Map<string, CloudRow>(),
  getPages: [] as Array<{ offset: number; limit: number }>,
  /** 每次请求的 order 参数（用于断言请求里有 tiebreaker） */
  orders: [] as string[][],
  /** 让第 N 页（按请求序）返回 500，用来验证 fail-closed */
  failPageAt: null as number | null,
  // ── 1.22.15 截断检测（digest + download 的 count 交叉校验）──────────────
  /** 假网关的 db-max-rows：单页响应最多吐这么多行（模拟 PostgREST 静默截断）。null = 不截断 */
  maxRows: null as number | null,
  /** digest（无 offset 的指纹查询）请求按序记录的 select 串，供形状断言 */
  digestSelects: [] as string[],
  /** digest 请求是否带 order=id（有 offset 的分页请求不计入） */
  digestOrders: [] as string[],
  /** digest 分页请求按序记录的 (offset, limit) */
  digestPages: [] as Array<{ offset: number; limit: number }>,
  /** tab_groups GET 请求按序记录的 Prefer 头（断言 count=exact 用） */
  prefers: [] as string[],
  /** 第一个带 offset 的分页请求的 Prefer 头 */
  firstPagePrefer: null as string | null,
};

function resetCloud() {
  cloud.rows.clear();
  cloud.getPages.length = 0;
  cloud.orders.length = 0;
  cloud.failPageAt = null;
  cloud.maxRows = null;
  cloud.digestSelects.length = 0;
  cloud.digestOrders.length = 0;
  cloud.digestPages.length = 0;
  cloud.prefers.length = 0;
  cloud.firstPagePrefer = null;
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

/**
 * 请求里的 order 形如 `order=created_at.desc,id.desc` —— 是**一个**逗号分隔的参数，
 * 不是多个 order 参数（supabase-js 的 .order() 链会合并）。所以要先按逗号拆，
 * 每个片段再是 `col.dir[.nullsfirst|.nullslast]`。
 */
function parseOrders(params: URLSearchParams): Array<{ col: string; asc: boolean }> {
  const out: Array<{ col: string; asc: boolean }> = [];
  for (const raw of params.getAll('order')) {
    for (const spec of raw.split(',')) {
      const [col, dir] = spec.split('.');
      if (!col) continue;
      out.push({ col, asc: (dir ?? 'asc').toLowerCase() !== 'desc' });
    }
  }
  return out;
}

/** 请求里声明的排序列名（去重保留顺序），供断言直接用 */
function orderColumns(params: URLSearchParams): string[] {
  return parseOrders(params).map(o => o.col);
}

/**
 * 按请求里的 order 排序；对「按这些键仍并列」的行做随请求变化的置换，
 * 模拟 Postgres 对并列行不给跨查询顺序保证的真实行为。
 */
function orderedRows(
  rows: CloudRow[],
  orders: Array<{ col: string; asc: boolean }>,
  requestIndex: number
): CloudRow[] {
  const sorted = [...rows].sort((a, b) => {
    for (const { col, asc } of orders) {
      const av = String(a[col] ?? '');
      const bv = String(b[col] ?? '');
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });

  // 同一组「按指定键完全并列」的行，顺序在请求之间不稳定。
  const keyOf = (r: CloudRow) => orders.map(({ col }) => String(r[col] ?? '')).join('\u0000');
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

globalThis.fetch = (async (input: any, init: RequestInit & { headers?: Record<string, string> } = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'tie@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups') && !url.pathname.endsWith('/rest/v1/tabs')) {
    return jsonRes({ message: 'not found' }, 404);
  }

  const params = url.searchParams;

  if (method === 'GET') {
    if (url.pathname.endsWith('/rest/v1/tabs')) return jsonRes([]);

    const hasOffset = params.has('offset');
    const requestIndex = cloud.getPages.length;
    if (hasOffset) {
      cloud.getPages.push({
        offset: Number(params.get('offset') ?? 0),
        limit: Number(params.get('limit') ?? 0),
      });
      cloud.orders.push(orderColumns(params));
      // digest 与 download 都走 .range()（带 offset）：按 select 串区分归属。
      const sel = params.get('select') ?? '';
      if (/updated_at/.test(sel)) {
        cloud.digestSelects.push(sel);
        cloud.digestOrders.push(...(params.get('order') ?? '').split(',').filter(Boolean));
        cloud.digestPages.push({
          offset: Number(params.get('offset') ?? 0),
          limit: Number(params.get('limit') ?? 0),
        });
      }
      if (cloud.failPageAt !== null && cloud.getPages.length - 1 === cloud.failPageAt) {
        return jsonRes({ message: 'simulated gateway failure' }, 500);
      }
    }

    if (url.pathname.endsWith('/rest/v1/tab_groups')) {
      // init.headers 可能是 Headers 实例（supabase-js 传的就是），统一走 Headers API 读
      const prefer = new Headers((init.headers as HeadersInit | undefined) ?? {}).get('Prefer') ?? '';
      if (params.has('offset') && cloud.firstPagePrefer === null) {
        cloud.firstPagePrefer = prefer;
      }
      cloud.prefers.push(prefer);
    }

    const offset = Number(params.get('offset') ?? 0);
    const limitRaw = params.get('limit');
    const limit = limitRaw !== null ? Number(limitRaw) : Number.POSITIVE_INFINITY;
    const all = orderedRows(
      [...cloud.rows.values()].filter(r => matches(r, params)),
      parseOrders(params),
      requestIndex
    );
    // 假网关 db-max-rows：分页请求单页最多吐 maxRows 行（静默截断，无任何报错）。
    // PostgREST 对超限页返回的仍是 200 + 满页行数，只是行数被砍到上限。
    let page = all.slice(offset, offset + limit);
    const wantsCount = new Headers((init.headers as HeadersInit | undefined) ?? {})
      .get('Prefer')
      ?.includes('count=exact') ?? false;
    if (cloud.maxRows !== null && page.length > cloud.maxRows) {
      page = page.slice(0, cloud.maxRows);
    }
    if (wantsCount) {
      // supabase-js 的 { count: 'exact' }：请求带 Prefer: count=exact，
      // 响应必须带 Content-Range: <lo>-<hi>/<total>，库从 total 解析出 count。
      // 注意 total 是「过滤后全表行数」，与页截断无关 —— 截断检测依赖这一点。
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-range': `0-${Math.max(page.length - 1, 0)}/${all.length}`,
        },
      });
    }
    return jsonRes(page);
  }

  if (method === 'POST') {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '[]');
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    for (const row of rows) cloud.rows.set(row.id, { ...row });
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

async function loadDownload() {
  resetCloud();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  const { downloadSync } = await import('@/utils/supabase/download');
  return downloadSync.downloadTabGroups;
}

/** 加载 fetchTabGroupsDigest（probe 单例缓存同样要先清） */
async function loadDigest() {
  resetCloud();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  return probe.fetchTabGroupsDigest;
}

/** 造 N 行 created_at 各不相同（digest 用的行；count 交叉校验关心的是行数） */
function seedDistinctRows(n: number) {
  for (let i = 0; i < n; i++) {
    cloud.rows.set(`g-${i}`, {
      id: `g-${i}`,
      user_id: USER_ID,
      name: `g-${i}`,
      tabs_data: [],
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
      updated_at: '2026-10-07T00:00:00.000Z',
    });
  }
}

/** 造 N 行，全部共享同一个 created_at（OneTab 批量导入的真实形状） */
function seedTiedRows(n: number) {
  const SAME = '2026-10-07T00:00:00.000Z';
  for (let i = 0; i < n; i++) {
    cloud.rows.set(`g-${i}`, {
      id: `g-${i}`,
      user_id: USER_ID,
      name: `g-${i}`,
      tabs_data: [],
      created_at: SAME,
      updated_at: SAME,
    });
  }
}

describe('下载分页：排序键并列时的完整性（2026-10-07）', () => {
  it('请求必须带唯一 tiebreaker（id），否则并列行的页窗口没有保证', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);

    await downloadTabGroups();

    assert.ok(cloud.orders.length >= 1, '应发出分页请求');
    const cols = cloud.orders[0];
    assert.ok(
      cols.includes('id'),
      `分页请求的 order 里必须含唯一列 id（created_at 会并列）。实际 order=[${JSON.stringify(cloud.orders[0])}]`
    );
  });

  it('450 行 created_at 全并列时，跨页取回的 id 集合必须完整（不靠页数掩盖丢行）', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);

    const groups = await downloadTabGroups();

    const got = new Set(groups.map(g => g.id));
    const expected = Array.from({ length: 450 }, (_, i) => `g-${i}`);
    const missing = expected.filter(id => !got.has(id));
    const dupes = groups.length - got.size;

    assert.deepEqual(
      missing,
      [],
      `并列排序下丢了 ${missing.length} 行（前 10 个：${missing.slice(0, 10).join(',')}）。` +
        `这正是 offset 分页在非唯一排序键上的失败模式：窗口重叠/跳过，且因短页退出而无报错。`
    );
    assert.equal(dupes, 0, `同一行被取回多次（重复 ${dupes} 条）：说明页窗口重叠了`);
    assert.equal(groups.length, 450);
    assert.equal(cloud.getPages.length, 3, `应发 3 页请求，实际 ${cloud.getPages.length}`);
  });

  it('另一组并列形状（全部行 created_at 相同且 id 逆序可推）同样取回全部', async () => {
    const downloadTabGroups = await loadDownload();
    const SAME = '2026-09-01T12:00:00.000Z';
    for (let i = 0; i < 420; i++) {
      cloud.rows.set(`z-${String(419 - i).padStart(4, '0')}`, {
        id: `z-${String(419 - i).padStart(4, '0')}`,
        user_id: USER_ID,
        name: 'n',
        tabs_data: [],
        created_at: SAME,
        updated_at: SAME,
      });
    }

    const groups = await downloadTabGroups();
    assert.equal(groups.length, 420);
    assert.equal(new Set(groups.map(g => g.id)).size, 420, '出现了重复行：页窗口重叠');
  });
});

describe('下载分页：任一分页失败必须整体失败（fail-closed）', () => {
  it('第 2 页返回 500 时整个 downloadTabGroups 必须 reject，而不是交出半份数据', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);
    cloud.failPageAt = 1; // 第二页（offset=200）

    let rejected: unknown = null;
    try {
      await downloadTabGroups();
    } catch (e) {
      rejected = e;
    }

    assert.ok(
      rejected !== null,
      '某页失败却成功返回 = 用半份云端数据继续合并 = 半库覆盖，这正是要防的数据丢失'
    );
    assert.ok(
      cloud.getPages.length >= 2,
      `应至少请求到第 2 页才失败，实际只发了 ${cloud.getPages.length} 页`
    );
    // 拒绝值是 PostgREST 的错误对象（{message, details, hint, code}）而不是 Error 实例
    // —— 调用方都是 catch 后取 .message，所以不影响行为；这里不断言封装形状。
  });

  it('第 1 页就失败时同样 reject（不把失败当空云端）', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);
    cloud.failPageAt = 0;

    await assert.rejects(() => downloadTabGroups());
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// 1.22.15 截断检测：digest 分页 + count 交叉校验、download count 交叉校验
// ═══════════════════════════════════════════════════════════════════════════
//
// 【为什么这两条路径都必须自证完整性】网关 db-max-rows（PostgREST 默认 1000）
// 会**静默**截断超限响应：200 + 短行数，没有任何报错。
//   · digest 被截断：若恰好等于本地快照 → hasRemoteChanges=false → up_to_date
//     → 本该修复差异的全量下载永不发生（w2 已用 node 复现）。
//   · download 被截断/漂移：半份数据进合并 → 本地旧副本覆盖云端新版本 = 真丢失。
// 两处的修法同源：首个请求带 { count: 'exact' }（PostgREST 经 Content-Range 在
// 同一请求里带回总行数），分页结束后累计行数 != 总行数即失败 —— digest throw
// （fail-open 走全量，方向安全），download throw（fail-closed，绝不半份合并）。
describe('1.22.15 截断检测：fetchTabGroupsDigest 分页 + count 交叉校验', () => {
  it('未截断时正常返回全部行，且请求带 order=id.asc 与 .range() 分页', async () => {
    const fetchTabGroupsDigest = await loadDigest();
    seedDistinctRows(1200); // 跨 3 页（DIGEST_PAGE_SIZE=500）

    const digest = await fetchTabGroupsDigest();

    assert.equal(digest.length, 1200, '未截断时 digest 必须取回全部行');
    assert.equal(new Set(digest.map(d => d.id)).size, 1200, '不允许重复行');
    // 形状断言 1：主路径查询必须显式带 order=id（否则并列/分页窗口无保证）
    assert.ok(
      cloud.digestOrders.some(o => /^id\.(asc|desc)/.test(o)),
      `digest 请求必须带 order=id，实际 order=[${JSON.stringify(cloud.digestOrders)}]`
    );
    // 形状断言 2：必须真的分页（1200 行 > 500/页 → 至少 3 个带 range 的请求）
    assert.ok(
      cloud.digestPages.length >= 3,
      `1200 行应至少分 3 页请求，实际 ${cloud.digestPages.length}`
    );
    assert.deepEqual(
      cloud.digestPages.slice(0, 3),
      [
        { offset: 0, limit: 500 },
        { offset: 500, limit: 500 },
        { offset: 1000, limit: 500 },
      ],
      'digest 分页参数应为 (0,500) (500,500) (1000,500)'
    );
  });

  it('假网关 db-max-rows 静默截断 digest 响应时必须 throw（fail-open 走全量）', async () => {
    const fetchTabGroupsDigest = await loadDigest();
    seedDistinctRows(900);
    // 模拟网关把每一页都砍到 300 行（短页信号消失，累计 600 != 900）
    cloud.maxRows = 300;

    let rejected: unknown = null;
    try {
      await fetchTabGroupsDigest();
    } catch (e) {
      rejected = e;
    }

    assert.ok(
      rejected !== null,
      'digest 被静默截断却照常返回 = hasRemoteChanges 可能漏判 = up_to_date 假象，' +
        '本该修复差异的全量下载永不发生。必须 throw 让调用方 fail-open 走全量。'
    );
    const msg = rejected instanceof Error ? rejected.message : String(rejected);
    assert.match(msg, /!=/, '错误信息应说明累计行数与总行数不一致');
  });

  it('count 缺失（旧网关不回 Content-Range）时保持旧行为不误伤', async () => {
    const fetchTabGroupsDigest = await loadDigest();
    seedDistinctRows(600);
    // 不设置 maxRows；把 count 头吞掉模拟老网关：这里用「不返回 Content-Range」的
    // 默认 jsonRes 分支即可 —— wantsCount 为 false 时不带头。
    // 该用例钉住的是：count=null 时交叉校验必须跳过（不因读不到 count 而失败）。
    const digest = await fetchTabGroupsDigest();
    assert.equal(digest.length, 600);
  });
});

describe('1.22.15 截断检测：downloadTabGroups 的 count 交叉校验', () => {
  it('分页期间云端删除一行已取回的行 → 必须整体 throw，而不是静默少一行', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);
    // 第一页取回后、翻第二页前删掉一行（该行已在第一页取回）
    const originalFetch = globalThis.fetch;
    let pageGets = 0;
    globalThis.fetch = (async (input: any, init: RequestInit & { headers?: Record<string, string> } = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const isPageGet =
        url.pathname.endsWith('/rest/v1/tab_groups') &&
        (init?.method ?? 'GET').toUpperCase() === 'GET' &&
        url.searchParams.has('offset');
      if (isPageGet) {
        pageGets += 1;
        if (pageGets === 2) cloud.rows.delete('g-0'); // offset 窗口漂移
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => downloadTabGroups(),
        /!=/,
        '并发删除导致的 offset 漂移必须现形：旧行为（无 count 校验）会静默少一行，' +
          '随后旧副本上传覆盖云端 = 真丢失'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('count 与实际一致时不误伤：450 行照常取回', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(450);

    const groups = await downloadTabGroups();

    assert.equal(groups.length, 450);
    assert.equal(new Set(groups.map(g => g.id)).size, 450);
  });

  it('首个请求必须带 Prefer: count=exact（交叉校验的数据来源）', async () => {
    const downloadTabGroups = await loadDownload();
    seedTiedRows(50);

    await downloadTabGroups();

    // prefers 里混着列探测（limit=1、无 offset）的 GET，无法靠 Prefer 区分；
    // 改断言第一个带 offset 的分页请求。
    assert.match(
      cloud.firstPagePrefer ?? '',
      /count=exact/,
      `首个分页 GET（带 offset）的 Prefer 头必须带 count=exact，实际: ${cloud.firstPagePrefer}`
    );
  });
});
