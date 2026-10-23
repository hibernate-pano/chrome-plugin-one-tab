// Supabase 下载层的「按 id 取回」（2026-10-23，第 53 轮）。
//
// ── 这个文件在防什么 ───────────────────────────────────────────────────────
//
// 整条「出网量 ∝ 变更量」的链路上，最容易**悄悄失效**的一环是**这一层**：
// 上面（core/cloudDelta.ts）算出「只要那几行」，若这一层没把请求真的收窄，
// 那么「省下带宽」就只是账面上的一句话 —— 云端照样把整个库发过来，
// 配额照样被吃光，项目照样被封（Supabase 的 egress 封禁是**项目级**的：
// 连 /auth/v1/health 都返回 402 ⇒ 整个项目不可用）。
//
// 而且这一层的失效是**静默**的：结果照样「对」（拿到的是全部行，
// 合并结果与全量一致）⇒ 任何只看结果的守卫都绿 ⇒ 只有**断言请求形状**
// 与**断言响应体变窄**才抓得住。
//
// ⇒ 本文件的断言钉在两处：
//   ① 请求 URL 里必须出现 `id=in.(...)`（不是「源码里写了 .in()」）；
//   ② 假云端**实际吐回**的行数必须等于「被点名的行数」，而不是库的总行数。
//
// ⚠️ 为什么还要第 ③ 条（切块）：`id=in.(...)` 走 URL 查询串 ⇒ id 太多会
//   把 URL 撑爆 ⇒ 必须切块 ⇒ 切块的边界（50/块）是**实现细节**，
//   但「切块后必须把点名的行**全部**取回来、且**不多取**」是**不变量** ⇒
//   本文件断言的是不变量（并集 = 点名集合，每块都不越界），不是块大小。
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
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const USER_ID = 'user-incremental-test';
const SESSION_KEY = 'sb-stub-auth-token';

/**
 * localStorage 桩（supabase-js 的会话存放在这里）。
 *
 * 没有它 ⇒ `getSession()` 读不到会话 ⇒ 下载前置的核账号会抛
 * 「用户未登录或会话已过期」——那是**装置**问题，不是被测行为。
 */
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

const sessionStore = installLocalStorageStub();
sessionStore.set(SESSION_KEY, stubSessionJson(USER_ID));

interface CloudRow {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  version: number;
  is_deleted: boolean;
  last_op_device: string;
  last_op_seq: number;
  tabs_data: unknown;
}

const cloud = {
  rows: new Map<string, CloudRow>(),
  /** 每次 tab_groups GET 的记录：请求里点名的 id（null = 全量）与实际吐回的行数。 */
  requests: [] as Array<{ inIds: string[] | null; returned: number }>,
};

function resetCloud(): void {
  cloud.rows.clear();
  cloud.requests.length = 0;
}

function makeRow(id: string, overrides: Partial<CloudRow> = {}): CloudRow {
  return {
    id,
    user_id: USER_ID,
    name: `g-${id}`,
    created_at: '2026-10-23T08:00:00.000Z',
    updated_at: '2026-10-23T08:00:00.000Z',
    version: 1,
    is_deleted: false,
    last_op_device: 'dev-A',
    last_op_seq: 1,
    tabs_data: [
      {
        id: `${id}-t1`,
        url: `https://${id}.example.com/`,
        title: id,
        createdAt: '2026-10-23T08:00:00.000Z',
        lastAccessed: '2026-10-23T08:00:00.000Z',
        pinned: false,
      },
    ],
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 解析 `id=in.(a,b,c)` ⇒ ['a','b','c']；没有 in 过滤则 null。 */
function parseInFilter(params: URLSearchParams): string[] | null {
  const raw = params.get('id');
  if (!raw) return null;
  const m = /^in\.\((.*)\)$/.exec(raw);
  if (!m) return null;
  return m[1] === '' ? [] : m[1].split(',');
}

globalThis.fetch = (async (input: any, init: RequestInit & { headers?: Record<string, string> } = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated' });
  }
  if (url.pathname.endsWith('/rest/v1/tabs')) return jsonRes([]);
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) return jsonRes({ message: 'not found' }, 404);

  const params = url.searchParams;
  const offset = Number(params.get('offset') ?? 0);
  const limitRaw = params.get('limit');
  const limit = limitRaw !== null ? Number(limitRaw) : Number.POSITIVE_INFINITY;

  let rows = [...cloud.rows.values()].filter(r => {
    // supabase-js 的 .eq() 编码成 `列名=eq.值`（仓库既有假网关同款解析）。
    const eq = params.get('user_id');
    if (eq !== null) {
      const want = eq.startsWith('eq.') ? eq.slice(3) : eq;
      if (String(want) !== r.user_id) return false;
    }
    return true;
  });

  const inIds = parseInFilter(params);
  if (inIds !== null) {
    const want = new Set(inIds);
    rows = rows.filter(r => want.has(r.id));
  }

  const page = rows.slice(offset, offset + limit);
  cloud.requests.push({ inIds, returned: page.length });

  const wantsCount =
    new Headers((init.headers as HeadersInit | undefined) ?? {}).get('Prefer')?.includes('count=exact') ?? false;
  if (wantsCount) {
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-range': `0-${Math.max(page.length - 1, 0)}/${rows.length}`,
      },
    });
  }
  return jsonRes(page);
}) as typeof fetch;

before(async () => {
  register(LOADER_PATH, import.meta.url);
});

beforeEach(() => {
  resetCloud();
});

async function loadDownload() {
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  const { downloadSync } = await import('@/utils/supabase/download');
  return downloadSync.downloadTabGroups;
}

describe('按 id 取回：请求真的被收窄了', () => {
  it('点名的行才会被取回（响应体只含被点名的那些行）', async () => {
    for (let i = 0; i < 10; i += 1) cloud.rows.set(`g${i}`, makeRow(`g${i}`));
    const downloadTabGroups = await loadDownload();

    const result = await downloadTabGroups({ onlyIds: ['g3', 'g7'] });

    assert.deepEqual(
      result.map(g => g.id).sort(),
      ['g3', 'g7'],
      '只该取回被点名的两行'
    );
    const req = cloud.requests.find(r => r.inIds !== null);
    assert.ok(req, '必须发出带 id=in.(...) 的请求');
    assert.deepEqual(req!.inIds!.sort(), ['g3', 'g7']);
    assert.equal(
      req!.returned,
      2,
      '这一次的响应体只能有 2 行 —— 响应体的大小就是出网量，' +
        '多一行就是多一份配额（tabs_data 占响应体的 93.5%）'
    );
  });

  it('不传 onlyIds 时行为不变（仍是全量）', async () => {
    for (let i = 0; i < 5; i += 1) cloud.rows.set(`g${i}`, makeRow(`g${i}`));
    const downloadTabGroups = await loadDownload();

    const result = await downloadTabGroups();

    assert.equal(result.length, 5, '全量路径必须照旧取回全部');
    assert.ok(
      cloud.requests.every(r => r.inIds === null),
      '全量路径不该带 id 过滤'
    );
  });

  it('id 很多时切块，但并集必须正好是点名的集合（不多取、不少取）', async () => {
    // 用 400 个（> 网关 URL 上限对应的批大小）⇒ 必然切块。
    // ⚠️ 断言钉的是**不变量**（并集 = 点名集合、每块不多取），
    //   不是「块大小是几」—— 那是实现细节（idBatches.ID_BATCH_SIZE），
    //   它变了这条守卫不该红，而「切块后取错行」必须红。
    const wanted: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      cloud.rows.set(`g${i}`, makeRow(`g${i}`));
      wanted.push(`g${i}`);
    }
    const downloadTabGroups = await loadDownload();

    const result = await downloadTabGroups({ onlyIds: wanted });

    assert.equal(result.length, 400, '点名 400 行 ⇒ 必须取回 400 行');
    assert.deepEqual(
      result.map(g => g.id).sort(),
      [...wanted].sort(),
      '切块后取回的必须是点名的全部，且不多取'
    );
    const chunked = cloud.requests.filter(r => r.inIds !== null);
    assert.ok(chunked.length > 1, '400 个 id 必须切块（URL 放不下）');
    for (const r of chunked) {
      assert.ok(
        r.returned <= r.inIds!.length,
        '每一块取回的行数不得超过这一块点名的行数'
      );
    }
  });

  it('id 为空时一个请求都不发（零网络往返）', async () => {
    for (let i = 0; i < 3; i += 1) cloud.rows.set(`g${i}`, makeRow(`g${i}`));
    const downloadTabGroups = await loadDownload();

    const result = await downloadTabGroups({ onlyIds: [] });

    assert.deepEqual(result, []);
    assert.equal(
      cloud.requests.length,
      0,
      '没有要取的行时不该发任何请求 —— 这一轮是「云端什么都没变」的常态，' +
        '每次都白付一次往返就是在给正在计配额的项目加伤口'
    );
  });
});
