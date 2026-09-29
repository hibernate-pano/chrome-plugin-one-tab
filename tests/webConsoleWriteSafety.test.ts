// Web 控制台（src/web/webApi.ts）写入安全性 + 读路径消毒的回归锁定测试。
//
// 锁住的四条不变量（与扩展端同口径，判据来源见各 describe 头注）：
//   1. renameGroup / deleteGroup 写出的 UPDATE 必须盖组级 opStamp（本设备 + OLD+1），
//      否则扩展端合并按 seq 打平判「本地赢」，改名/删除被静默撤销并回传云端。
//   2. deleteGroup 写墓碑时必须同时写 deleted_at（= updated_at 同一时刻），
//      否则 purgeExpiredCloudTombstones 的 deleted_at < cutoff 恒 false，墓碑永不过期。
//   3. 读路径的每个 tab.url 都必须过共享协议白名单 sanitizeTabUrl：
//      javascript: / data: 等危险协议整条丢弃，绝不进 <a href>。
//   4. 解密失败 / 形状不可恢复的行整行跳过，绝不降级成 tabs: [] 的「合法空组」。
//
// 本文件用 fetch 层假云端（PostgREST / GoTrue 子集）跑真实的 webApi 写操作：
// 断言落库的 update 载荷，而不是断言内部调用次数。假云端形状沿用
// tests/overwriteTombstone.test.ts（含列缺失 → PGRST204 的探测桩）。
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

before(async () => {
  register(LOADER_PATH);
});

const USER_ID = 'web-user-under-test';
// supabase-js 默认 storageKey：sb-<hostname 首段>-auth-token
const SESSION_KEY = 'sb-stub-auth-token';
// storage-kv 的 localStorage driver（无 IndexedDB / 无 chrome.storage 时）
const DEVICE_KEY = 'tabvaultpro_device_id';
const DEVICE_ID = 'web-device-test';
const EARLIER = '2026-09-20T10:00:00.000Z';

// ── 环境桩 1：localStorage（supabase session 持久化 + 设备 ID） ─────────────
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
  // storage-kv 的 localStorage driver 走 window.localStorage（Node 里没有 window）
  (globalThis as any).window = globalThis;
  return map;
}

const store = installLocalStorageStub();
store.set(SESSION_KEY, stubSessionJson(USER_ID));
// 固定设备 ID：last_op_device 的断言必须可读，不能是每次调用新生成的随机串
store.set(DEVICE_KEY, JSON.stringify(DEVICE_ID));

// ── 环境桩 2：假云端（PostgREST / GoTrue 子集） ────────────────────────────
interface CloudRow {
  id: string;
  user_id: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  is_locked?: boolean;
  is_deleted?: boolean;
  deleted_at?: string | null;
  last_op_device?: string | null;
  last_op_seq?: number | null;
  tabs_data?: unknown;
  [k: string]: unknown;
}

const ALL_COLUMNS = { is_deleted: true, last_op_seq: true, deleted_at: true };

const cloud = {
  /** 云端实际存在的列（决定列探测落在「支持」还是「降级」分支） */
  columns: { ...ALL_COLUMNS },
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录 PATCH 载荷，用于断言写操作真正落库的字段 */
  patches: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<string>,
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

/** 极简 PostgREST 过滤：只认 eq.X（其余 select/limit/order 一律忽略） */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (!raw.startsWith('eq.')) continue;
    if (String(row[key]) !== raw.slice(3)) return false;
  }
  return true;
}

function project(row: CloudRow, cols: string[]): CloudRow {
  if (cols.includes('*')) return { ...row };
  const out: CloudRow = {} as CloudRow;
  for (const c of cols) (out as any)[c] = row[c];
  return out;
}

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'web@test.dev' });
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
      if (c === 'deleted_at' && !cloud.columns.deleted_at) return missingColumnRes(c);
    }
    const limitRaw = params.get('limit');
    const limit = limitRaw ? Number(limitRaw) : Number.POSITIVE_INFINITY;
    const data = [...cloud.rows.values()]
      .filter(r => matches(r, params))
      .slice(0, limit)
      .map(r => project(r, cols));
    return jsonRes(data);
  }

  if (method === 'PATCH') {
    const body = (typeof init.body === 'string' ? JSON.parse(init.body) : {}) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      const next = { ...row, ...body };
      cloud.rows.set(id, next);
      touched.push(next);
    }
    cloud.patches.push(body);
    return jsonRes(touched);
  }

  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (matches(row, params)) cloud.rows.delete(id);
    }
    cloud.deletes.push((params.get('id') ?? '').replace(/^eq\./, ''));
    return jsonRes([]);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 测试脚手架 ────────────────────────────────────────────────────────────
function mkRow(overrides: Partial<CloudRow> & { id: string }): CloudRow {
  return {
    user_id: USER_ID,
    name: `组 ${overrides.id}`,
    created_at: EARLIER,
    updated_at: EARLIER,
    is_locked: false,
    is_deleted: false,
    ...overrides,
  };
}

/** 每次加载都重置列探测缓存（探测结果是进程内单例，否则列形态切换后串味） */
async function loadWebApi() {
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  return import('@/web/webApi');
}

async function resetCloud(columns: Partial<typeof ALL_COLUMNS> = {}) {
  cloud.columns = { ...ALL_COLUMNS, ...columns };
  cloud.rows.clear();
  cloud.patches.length = 0;
  cloud.deletes.length = 0;
}

function lastPatch(): Record<string, unknown> {
  assert.ok(cloud.patches.length > 0, '本次调用没有向云端发出任何 UPDATE');
  return cloud.patches[cloud.patches.length - 1];
}

beforeEach(async () => {
  await resetCloud();
});

// ── 1 · 写操作必须盖组级 opStamp（P0：改名/删除被扩展端撤销） ───────────────
describe('renameGroup：写操作盖组 stamp（OLD+1、归属本设备）', () => {
  it('载荷带 last_op_device = 本设备', async () => {
    const { renameGroup } = await loadWebApi();
    cloud.rows.set('g-1', mkRow({ id: 'g-1', last_op_device: 'devExt', last_op_seq: 7 }));

    await renameGroup('g-1', '新名字');

    const patch = lastPatch();
    assert.equal(patch.name, '新名字');
    assert.equal(
      patch.last_op_device,
      DEVICE_ID,
      '改名必须归属写者本设备；不盖印记时扩展端合并保留自己的旧副本，改名被静默撤销'
    );
    assert.equal(cloud.rows.get('g-1')?.last_op_device, DEVICE_ID, '印记必须真的落库');
  });

  it('载荷带 last_op_seq，且严格大于云端原值（7 → 8）', async () => {
    const { renameGroup } = await loadWebApi();
    cloud.rows.set('g-1', mkRow({ id: 'g-1', last_op_device: 'devExt', last_op_seq: 7 }));

    await renameGroup('g-1', '新名字');

    const patch = lastPatch();
    assert.equal(typeof patch.last_op_seq, 'number', '改名必须推进 last_op_seq');
    assert.ok(
      (patch.last_op_seq as number) > 7,
      `seq 必须严格大于云端原值（否则过不了上传侧严格 LT 守卫），实得 ${String(patch.last_op_seq)}`
    );
    assert.equal(patch.last_op_seq, 8);
    assert.equal(cloud.rows.get('g-1')?.last_op_seq, 8);
  });

  it('云端行无印记（迁移前数据）→ seq 从 1 起', async () => {
    const { renameGroup } = await loadWebApi();
    cloud.rows.set('g-legacy', mkRow({ id: 'g-legacy' }));

    await renameGroup('g-legacy', '改个名');

    assert.equal(lastPatch().last_op_seq, 1);
    assert.equal(lastPatch().last_op_device, DEVICE_ID);
  });
});

// ── 2 · deleteGroup：盖 stamp + 写 deleted_at（P0 + P1） ───────────────────
describe('deleteGroup：墓碑行同时盖 stamp 与 deleted_at', () => {
  it('载荷带 last_op_device / 严格递增的 last_op_seq', async () => {
    const { deleteGroup } = await loadWebApi();
    cloud.rows.set('g-1', mkRow({ id: 'g-1', last_op_device: 'devExt', last_op_seq: 12 }));

    await deleteGroup('g-1');

    const patch = lastPatch();
    assert.equal(patch.is_deleted, true);
    assert.equal(patch.last_op_device, DEVICE_ID);
    assert.equal(patch.last_op_seq, 13);
    assert.ok((patch.last_op_seq as number) > 12, '删除广播必须靠推进 seq 才能压过扩展端旧副本');
    assert.equal(cloud.rows.get('g-1')?.is_deleted, true, '行保留 = 跨端删除广播载体');
  });

  it('载荷带 deleted_at，且与 updated_at 是同一时刻（不调两次 new Date()）', async () => {
    const { deleteGroup } = await loadWebApi();
    cloud.rows.set('g-1', mkRow({ id: 'g-1', last_op_seq: 3 }));

    await deleteGroup('g-1');

    const patch = lastPatch();
    assert.equal(typeof patch.deleted_at, 'string', '墓碑行不写 deleted_at → purge 的 NULL < cutoff 恒 false，永不清理');
    assert.equal(patch.deleted_at, patch.updated_at, 'deleted_at 与 updated_at 必须同一时刻');
    assert.ok(Date.parse(patch.deleted_at as string) > 0, 'deleted_at 必须是可解析的时刻');
    assert.equal(cloud.rows.get('g-1')?.deleted_at, patch.deleted_at, 'deleted_at 必须真的落库');
  });

  it('云端无 deleted_at 列 → 整列省略（写不存在的列 = PostgREST 42703 = 整次删除失败）', async () => {
    const { deleteGroup } = await loadWebApi();
    await resetCloud({ deleted_at: false });
    cloud.rows.set('g-1', mkRow({ id: 'g-1', last_op_seq: 3 }));

    await deleteGroup('g-1');

    const patch = lastPatch();
    assert.equal('deleted_at' in patch, false);
    assert.equal(patch.is_deleted, true, '缺 deleted_at 列不影响墓碑本身写入');
    assert.equal(patch.last_op_seq, 4, 'stamp 与 deleted_at 互相独立');
  });

  it('云端无 is_deleted 列 → 仍走硬删降级（不发 UPDATE）', async () => {
    const { deleteGroup } = await loadWebApi();
    await resetCloud({ is_deleted: false, last_op_seq: false, deleted_at: false });
    cloud.rows.set('g-1', mkRow({ id: 'g-1' }));

    await deleteGroup('g-1');

    assert.equal(cloud.patches.length, 0, '硬删降级路径不得发 UPDATE');
    assert.deepEqual(cloud.deletes, ['g-1']);
    assert.equal(cloud.rows.has('g-1'), false);
  });
});

// ── 3 · 读路径 URL 消毒（P1 · 安全：javascript: 可注入） ───────────────────
describe('fetchGroups：tab.url 必须过共享协议白名单 sanitizeTabUrl', () => {
  it('javascript: / data: / file: 的标签被丢弃，https: 与 loading:// 保留', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { fetchGroups } = await loadWebApi();
    // 白名单（src/utils/inputValidation.ts:238-241）只放行 http/https/ftp/about/loading，
    // 并显式黑名单 javascript:/data:/vbscript:/file:/blob: —— 与扩展端同源，
    // data:（含 data:image）也一律拒收，这是扩展端既有口径，网页端不得放宽。
    const payload = [
      { id: 't-js', url: 'javascript:alert(document.cookie)', title: 'xss', created_at: EARLIER, last_accessed: EARLIER },
      { id: 't-data', url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', title: 'xss2', created_at: EARLIER, last_accessed: EARLIER },
      { id: 't-file', url: 'file:///etc/passwd', title: 'local', created_at: EARLIER, last_accessed: EARLIER },
      { id: 't-https', url: 'https://example.com/a', title: 'ok', created_at: EARLIER, last_accessed: EARLIER },
      { id: 't-loading', url: 'loading://', title: 'loading', created_at: EARLIER, last_accessed: EARLIER },
    ];
    cloud.rows.set('g-1', mkRow({ id: 'g-1', tabs_data: await encryptData(payload, USER_ID) }));

    const groups = await fetchGroups();

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].tabs.map(t => t.id), ['t-https', 't-loading']);
    assert.ok(
      groups[0].tabs.every(t => !/^(javascript|data|file):/i.test(t.url)),
      '任何危险协议都不得进入渲染用的 tab.url'
    );
  });

  it('wrapper 明文载荷（camelCase）同样消毒，且组名等元数据从内嵌对象恢复', async () => {
    const { fetchGroups } = await loadWebApi();
    cloud.rows.set('g-2', mkRow({
      id: 'g-2',
      name: '表列里的名字',
      tabs_data: JSON.stringify({
        id: 'g-2',
        name: '内嵌名字',
        version: 3,
        tabs: [
          { id: 't-bad', url: 'javascript:void(0)', title: 'bad', createdAt: EARLIER, lastAccessed: EARLIER },
          { id: 't-good', url: 'https://example.com/b', title: 'good', createdAt: EARLIER, lastAccessed: EARLIER },
        ],
      }),
    }));

    const groups = await fetchGroups();

    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, '内嵌名字');
    assert.equal(groups[0].version, 3);
    assert.deepEqual(groups[0].tabs.map(t => t.id), ['t-good']);
    assert.equal(groups[0].tabs[0].createdAt, EARLIER, 'camelCase 方言的时间戳不得丢');
  });

  it('snake_case 方言（扩展写入形）还原为完整 Tab，并剥离标签级墓碑', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { fetchGroups } = await loadWebApi();
    const payload = [
      { id: 't-live', url: 'https://a.com', title: 'live', created_at: EARLIER, last_accessed: EARLIER, pinned: true },
      { id: 't-dead', url: 'https://b.com', title: 'dead', created_at: EARLIER, last_accessed: EARLIER, is_deleted: true },
    ];
    cloud.rows.set('g-3', mkRow({ id: 'g-3', tabs_data: await encryptData(payload, USER_ID) }));

    const groups = await fetchGroups();

    assert.deepEqual(groups[0].tabs.map(t => t.id), ['t-live'], '标签级墓碑不计入 Web 列表与统计');
    assert.equal(groups[0].tabs[0].pinned, true);
    assert.equal(groups[0].tabs[0].createdAt, EARLIER);
    assert.equal(groups[0].tabs[0].group_id, 'g-3');
  });
});

// ── 4 · 读不出来 ≠ 是空的（P0：绝不降级成 tabs: [] 的合法空组） ───────────
describe('fetchGroups：解密失败 / 形状不可恢复的行整行跳过', () => {
  it('JSONB 形状不可恢复（有内容、归一化不出标签）→ 整行跳过，不产出空组', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { fetchGroups } = await loadWebApi();
    // 读不出来的真实数据被伪装成"零标签组"= 下游会当空壳处理并登记 purge
    cloud.rows.set('g-bad', mkRow({ id: 'g-bad', tabs_data: { version: 2, displayOrder: 0 } }));
    cloud.rows.set('g-good', mkRow({
      id: 'g-good',
      tabs_data: await encryptData([{ id: 't1', url: 'https://a.com', title: 'a' }], USER_ID),
    }));

    const groups = await fetchGroups();

    assert.deepEqual(groups.map(g => g.id), ['g-good'], '坏行必须整行跳过，其余组不受影响');
    assert.equal(
      groups.some(g => g.id === 'g-bad'),
      false,
      '读不出来的行绝不能变成 tabs: [] 的空组'
    );
  });

  it('密文损坏（解密与明文回退都失败）→ 整行跳过，不产出空组', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { fetchGroups } = await loadWebApi();
    cloud.rows.set('g-corrupt', mkRow({
      id: 'g-corrupt',
      // 前缀合法但密文是垃圾：AES-GCM 校验必失败，isEncrypted 为真 → 不做明文回退
      tabs_data: 'ENCRYPTED_V2_S:' + Buffer.from('not-a-real-ciphertext').toString('base64'),
    }));
    cloud.rows.set('g-good', mkRow({
      id: 'g-good',
      tabs_data: await encryptData([{ id: 't1', url: 'https://a.com', title: 'a' }], USER_ID),
    }));

    const groups = await fetchGroups();

    assert.deepEqual(groups.map(g => g.id), ['g-good']);
    assert.ok(groups.every(g => g.tabs.length > 0), '不得出现任何零标签组');
  });

  it('真的是空的（tabs_data=[] / 行内无内容）照常显示——不能连空组一起跳掉', async () => {
    const { fetchGroups } = await loadWebApi();
    cloud.rows.set('g-empty', mkRow({ id: 'g-empty', tabs_data: '[]' }));
    cloud.rows.set('g-no-data', mkRow({ id: 'g-no-data', tabs_data: null }));

    const groups = await fetchGroups();

    assert.deepEqual(groups.map(g => g.id).sort(), ['g-empty', 'g-no-data']);
    assert.ok(groups.every(g => g.tabs.length === 0));
    assert.equal(groups[0].name, '组 g-empty', '空组仍用 tab_groups 表列的名字');
  });
});
