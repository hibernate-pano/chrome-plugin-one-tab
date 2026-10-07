// 云端下行链路（src/utils/supabase/download.ts）的集成测试——这个文件此前零直接断言，
// 而它正是历史上「把用户仅存于云端的数据删掉」那次事故的所在地。
//
// 本文件钉死的行为（每条都有用例；标 [回归] 的用例在对应修复前失败、修复后通过）：
//
// 1. 正常路径：多行混合（部分有 stamp、部分没有；加密串 / 明文 / wrapper 对象三种形状）
//    → 选列、解析、归一化、排序、组级与标签级 stamp 还原都正确。
// 2. [回归·历史事故点] 单行解密失败 → 整行跳过、**不产出零标签空组**、其余行照常。
// 3. [回归] tabs_data 形状完全不可恢复 → 同上。JSONB 对象形状修复前已覆盖；
//    「加密串解出来是个没有数组字段的对象」这条修复前会漏判成空组。
// 4. [回归·P1 截断洞] 部分标签还原不出来且还原率过低 → 整组跳过。
//    1 个 https + 9 个浏览器内部页的组，修复前会被还原成 1 个标签的组，
//    mergeOpStamped 再把它当赢家整组回写云端 → 那 9 个标签在所有设备上永久消失。
// 5. 老版本兼容分支：组没有 tabs_data 但 tabs 表有数据 → 走 tabs 表回填；
//    回填同样受还原率判据约束（不过关的组从结果里整个拿掉，而不是留成空组）。
// 6. supportsOpStamp 探测失败/缺列 → 降级到不带 stamp 的列选择（select=*）。
// 7. 下载结果不得让本地独有的组消失；[回归] 端到端：部分失败的那一组在
//    「下载 → 合并 → 上传」一轮之后，云端行里的标签一个都不能少。
//
// 假云端 = tests/overwriteTombstone.test.ts 与 tests/syncUploadDownloadSafety.test.ts
// 那套 PostgREST 子集桩（增删改查四类请求、select 投影、eq./in.()、缺列时的
// PGRST204 降级回应），沿用同样的 matches/project 写法，只补本场景必需的两处：
//   1) /rest/v1/tabs 端点（老版本兼容分支的回填源）；
//   2) 请求记录（用来断言「发了哪条 select」——列选择降级只能从这里看）。
// 不另造第三套。
//
// 文件样板与 tests/syncUploadDownloadSafety.test.ts 一致：@/ 别名模块只能动态 import
// （client.ts 在模块求值时就读环境变量桩，静态 import 会在桩就位前跑掉），
// 且 localStorage / fetch / chrome 桩必须在 import 被测模块之前就位。
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
const EARLIEST = '2026-09-28T08:00:00.000Z';
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
  /** 云端实际存在的列（决定 supports* 探测落在哪个分支） */
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true, version: true } as Record<
    string,
    boolean
  >,
  /** last_op_seq 探测请求的强制失败（模拟网络抖动，非 PGRST204 → 不缓存） */
  probeFailure: 0 as number,
  rows: new Map<string, CloudRow>(),
  /** 老版本 tabs 表（回填源） */
  tabs: [] as CloudRow[],
  /** 逐条请求记录，用来断言「发了哪条 select」 */
  requests: [] as { path: string; method: string; select: string }[],
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

/** 极简 PostgREST 过滤：user_id=eq.X、group_id=eq.X、id=in.(a,b)、deleted_at=lt.X */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'offset' || key === 'on_conflict' || key === 'order') continue;
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
  // select=* 时先摊平整行（downloadTabGroups 会发 `*, last_op_device, last_op_seq, version`）
  const out: CloudRow = (cols.includes('*') ? { ...row } : {}) as CloudRow;
  for (const c of cols) {
    if (c === '*') continue;
    (out as any)[c] = row[c];
  }
  return out;
}

/**
 * 服务端 BEFORE UPDATE 守卫（照抄 migration 的 plpgsql，与 syncUploadDownloadSafety 一致）。
 * 端到端那条要真上传，守卫吞写的语义必须还原，否则「上传成功」是假象。
 *   - guard_tab_group_version
 *   - guard_tab_group_op_stamp
 */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) return old;

  const oSeq = old.last_op_seq;
  const nSeq = next.last_op_seq;
  if (oSeq != null && nSeq == null) return old; // 清空印记拒收
  if (oSeq == null || nSeq == null) return next; // 任一侧无印记 → 放行
  if ((nSeq as number) < (oSeq as number)) return old; // 仅拒收严格更旧的写入
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
  const params = url.searchParams;

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' });
  }
  if (url.pathname.endsWith('/rest/v1/tabs')) {
    cloud.requests.push({ path: 'tabs', method, select: params.get('select') ?? '' });
    if (method !== 'GET') return jsonRes([], 405);
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    return jsonRes(cloud.tabs.filter(r => matches(r, params)).map(r => project(r, cols)));
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    return jsonRes({ message: 'not found' }, 404);
  }

  cloud.requests.push({ path: 'tab_groups', method, select: params.get('select') ?? '' });

  // supportsOpStamp 的探测请求：可注入非确定性失败（网络抖动）
  if (params.get('select') === 'last_op_seq' && params.get('limit') === '1' && cloud.probeFailure) {
    return jsonRes({ message: 'probe failed' }, cloud.probeFailure);
  }

  if (method === 'GET') {
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
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
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    return jsonRes(rows.map(row => writeRow(row.id, row)));
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
/** 一行 TabData（云端 tabs_data 数组元素 / tabs 表行的形状） */
function tabData(id: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url,
    title: id,
    created_at: NOW,
    last_accessed: NOW,
    last_op_device: null,
    last_op_seq: null,
    ...overrides,
  };
}

/** 一条云端 tab_groups 行的完整形状（对齐 uploadTabGroups 写出的列） */
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
    tabs_data: JSON.stringify([tabData(`${id}-t1`, `https://${id}.example.com/`)]),
    ...overrides,
  } as CloudRow;
}

/** 浏览器/扩展自己的页面：isInternalUrl 会拦一部分，sanitizeTabUrl 全部拦掉 */
const INTERNAL_URLS = [
  'chrome://newtab/',
  'chrome://settings/',
  'chrome://extensions/',
  'edge://favorites/',
  'chrome-extension://abcdef/popup.html',
  'chrome://downloads/',
  'edge://settings/',
  'chrome://history/',
  'edge://newtab/',
];

/** n 个 https 标签 + (total - n) 个内部协议标签，凑成指定还原率 */
function tabsWithRestoreRate(id: string, restorable: number, total: number) {
  return Array.from({ length: total }, (_, i) =>
    i < restorable
      ? tabData(`${id}-ok-${i}`, `https://${id}.example.com/${i}`)
      : tabData(`${id}-bad-${i}`, INTERNAL_URLS[i % INTERNAL_URLS.length])
  );
}

function seedGroup(row: CloudRow) {
  cloud.rows.set(row.id, row);
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
  // 存量印记迁移跑过：本文件要考的是下载链路本身，不让迁移改写种子数据的 stamp
  lsData.set('op_stamp_migrated', JSON.stringify(true));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.tabs.length = 0;
  cloud.requests.length = 0;
  cloud.probeFailure = 0;
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true, version: true };
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

/** 主查询（不是探针）实际发出的 select 串，按列名拆开（URL 里空格会被吞掉） */
function mainSelects(): string[][] {
  return cloud.requests
    .filter(r => r.path === 'tab_groups' && r.method === 'GET' && r.select !== 'last_op_seq')
    .map(r => r.select.split(',').map(c => c.trim()));
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 正常路径
// ─────────────────────────────────────────────────────────────────────────
describe('下载：正常路径（多行混合）', () => {
  it('三种 tabs_data 形状 + 有/无 stamp 都能正确解析、归一化、排序', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { downloadSync } = await import('@/utils/supabase/download');

    // g-enc：真加密串，组级与标签级印记俱全
    seedGroup(
      cloudRow('g-enc', {
        created_at: NOW,
        last_op_device: REMOTE_DEVICE,
        last_op_seq: 7,
        tabs_data: await encryptData(
          [
            tabData('t-a', 'https://a.example.com/', {
              last_op_device: REMOTE_DEVICE,
              last_op_seq: 3,
            }),
            tabData('t-b', 'ftp://files.example.com/pub'),
          ],
          USER_ID
        ),
      })
    );
    // g-plain：老版本明文 JSON 数组，印记列为 NULL
    seedGroup(
      cloudRow('g-plain', {
        created_at: LATER,
        last_op_device: null,
        last_op_seq: null,
        tabs_data: JSON.stringify([
          tabData('t-c', 'https://c.example.com/'),
          tabData('t-d', 'about:blank'),
        ]),
      })
    );
    // g-wrap：JSONB wrapper 对象（形状坏行，normalizeTabsData 能恢复）
    seedGroup(
      cloudRow('g-wrap', {
        created_at: EARLIEST,
        tabs_data: { tabs: [tabData('t-e', 'https://e.example.com/')] },
      })
    );

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(
      groups.map(g => g.id),
      ['g-plain', 'g-enc', 'g-wrap'],
      '必须按 created_at 倒序返回'
    );
    assert.deepEqual(mainSelects(), [['*', 'last_op_device', 'last_op_seq', 'version']],
      '探测到印记列时必须显式把印记列选出来');

    const byId = new Map(groups.map(g => [g.id, g]));

    const enc = byId.get('g-enc')!;
    assert.deepEqual(
      enc.tabs.map(t => t.url),
      ['https://a.example.com/', 'ftp://files.example.com/pub'],
      '加密行必须真的走解密路径还原（白名单内的 ftp: 放行）'
    );
    assert.deepEqual(enc.lastOp, { d: REMOTE_DEVICE, s: 7 }, '组级印记必须还原');
    assert.deepEqual(
      enc.tabs[0].lastOp,
      { d: REMOTE_DEVICE, s: 3 },
      '标签级印记必须还原'
    );
    assert.equal(enc.tabs[0].group_id, 'g-enc', '标签必须挂回自己的组');
    assert.equal(enc.name, 'g-enc', '组名/时间戳等标量列必须透传');
    assert.equal(enc.createdAt, NOW);
    assert.equal(enc.updatedAt, LATER);

    const plain = byId.get('g-plain')!;
    assert.deepEqual(
      plain.tabs.map(t => t.url),
      ['https://c.example.com/', 'about:blank'],
      '明文行必须能直解（decryptData 对无前缀串直接 JSON.parse）'
    );
    assert.equal(plain.lastOp, undefined, '印记列为 NULL → lastOp 留 undefined（视作全序最小值）');
    assert.equal(plain.tabs[0].lastOp, undefined, '标签级 NULL 印记同样留 undefined');

    const wrap = byId.get('g-wrap')!;
    assert.equal(wrap.tabs.length, 1, 'wrapper 对象必须被归一化回数组');
    assert.equal(wrap.tabs[0].url, 'https://e.example.com/');
  });

  it('真的空组（tabs_data 为空数组）仍要进结果——空组语义归下游空组规则管', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-empty', { tabs_data: JSON.stringify([]) }));
    seedGroup(cloudRow('g-null', { tabs_data: null }));

    const groups = await downloadSync.downloadTabGroups();
    assert.deepEqual(
      groups.map(g => g.id).sort(),
      ['g-empty', 'g-null'],
      '空组不是「读不出来」，不能在这里被跳过（否则老版本组的 tabs 表回填就没机会跑）'
    );
    for (const g of groups) assert.equal(g.tabs.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. [回归] 单行解密失败
// ─────────────────────────────────────────────────────────────────────────
describe('下载：单行读不出来（历史事故点）', () => {
  it('解密失败的行整行跳过、不产出空组，其余行照常', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    // 真·解密失败：合法前缀 + 垃圾密文（base64 解得出、AES-GCM 校验必然失败）
    seedGroup(
      cloudRow('g-cipher', { tabs_data: `ENCRYPTED_V2_S:${'A'.repeat(96)}` })
    );
    seedGroup(cloudRow('g-ok'));

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(
      groups.map(g => g.id),
      ['g-ok'],
      '解密失败的行必须整行跳过'
    );
    for (const g of groups) {
      assert.ok(g.tabs.length > 0, `不允许出现零标签空组（${g.id}）——下游会把它硬删并登记 purge`);
    }
    assert.equal(cloud.rows.has('g-cipher'), true, '云端行必须原封保留，等问题修好后自然恢复');
  });

  it('并发解密不得错位：组数超过并发度时，每组的标签仍归各自所有', async () => {
    // v1.22.9 起下载侧的逐组解密改为有界并发（CRYPTO_CONCURRENCY）。
    // 保序是硬要求：明文按下标写回 resolvedShapes[index]，一旦错位就是
    // 「A 组的标签出现在 B 组名下」—— 那是静默的数据损坏，且合并后整组回写云端，
    // 会扩散到所有设备。既有两条失败用例只有 2 个组（低于并发度，恒不会乱序完成），
    // 测不到这条路径，所以这里专门造「组数 > 并发度 + 每组内容互不相同」的场景。
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { downloadSync } = await import('@/utils/supabase/download');
    const { CRYPTO_CONCURRENCY } = await import('@/utils/concurrency');

    const N = CRYPTO_CONCURRENCY * 3; // 远超并发度，保证 worker 反复取任务、完成顺序被打乱
    for (let i = 0; i < N; i++) {
      // 组序号与 URL 里的 owner 必须用**同一个**字符串：错位检测靠比对两者，
      // 若一个补零一个不补零，测试会把自己判成失败（这个坑已经踩过一次）。
      const owner = String(i).padStart(2, '0');
      const gid = `g-enc-${owner}`;
      // 每组 3 个标签，URL 里带 owner 序号：错位会立刻体现在 tabs 的 URL 上
      const tabs = [0, 1, 2].map(k =>
        tabData(`${gid}-t${k}`, `https://owner-${owner}.example.com/page-${k}`)
      );
      seedGroup(cloudRow(gid, { tabs_data: await encryptData(tabs, USER_ID) }));
    }

    const groups = await downloadSync.downloadTabGroups();
    assert.equal(groups.length, N, '所有加密组都必须解析出来');

    for (const g of groups) {
      const expectedOwner = g.id.replace('g-enc-', ''); // 例如 '07'（与 URL 里的 owner 同源）
      assert.equal(g.tabs.length, 3, `${g.id} 应解出 3 个标签`);
      for (const t of g.tabs) {
        assert.ok(
          t.url.startsWith(`https://owner-${expectedOwner}.example.com/`),
          `${g.id} 的标签 URL 是 ${t.url}，不属于该组 —— 并发解密发生了下标错位`
        );
      }
    }
  });

  it('明文也解析不了的行（不是加密串但语法坏）同样整行跳过', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-broken', { tabs_data: '{not json at all' }));
    seedGroup(cloudRow('g-ok'));

    const groups = await downloadSync.downloadTabGroups();
    assert.deepEqual(groups.map(g => g.id), ['g-ok']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. [回归] 形状完全不可恢复
// ─────────────────────────────────────────────────────────────────────────
describe('下载：tabs_data 形状不可恢复', () => {
  it('JSONB 对象与「加密串解出非数组」两种形状都必须整行跳过', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { downloadSync } = await import('@/utils/supabase/download');

    // 形状 A：JSONB 原值是个没有标签数组字段的对象
    seedGroup(cloudRow('g-shape-obj', { tabs_data: { version: 2, note: 'no tabs here' } }));
    // 形状 B：加密串能解开，但解开后是个没有数组字段的对象
    //   ——修复前这一行走的是「解密成功」分支，没有任何形状 fail-safe，
    //   被直接归一化成空数组当成零标签空组放行（下游 → 硬删 + 登记 purge）。
    seedGroup(
      cloudRow('g-shape-blob', {
        tabs_data: await encryptData({ version: 2, note: 'no tabs here' }, USER_ID),
      })
    );
    // 对照：wrapper 对象里有数组 = 可恢复，必须照常返回
    seedGroup(
      cloudRow('g-shape-ok', { tabs_data: { tabsData: [tabData('t-ok', 'https://ok.example.com/')] } })
    );

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(
      groups.map(g => g.id),
      ['g-shape-ok'],
      '两种不可恢复形状都必须整行跳过，可恢复的 wrapper 必须照常返回'
    );
    assert.equal(groups[0].tabs.length, 1);
  });

  it('解出来就是空数组 = 真的空组，不按「读不出来」处理', async () => {
    const { encryptData } = await import('@/utils/encryptionUtils');
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-enc-empty', { tabs_data: await encryptData([], USER_ID) }));

    const groups = await downloadSync.downloadTabGroups();
    assert.deepEqual(groups.map(g => g.id), ['g-enc-empty'], '解密成功且结果为空数组 → 确认是空组');
    assert.equal(groups[0].tabs.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. [回归·P1] 还原率过低 → 整组跳过
// ─────────────────────────────────────────────────────────────────────────
describe('下载：部分标签还原失败（不可逆截断洞）', () => {
  it('1 个 https + 9 个内部页的组整组跳过，不得产出 1 个标签的截断组', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(
      cloudRow('g-heavy', {
        // 云端印记更大：截断组一旦产出，就是 mergeOpStamped 的赢家，会整组回写云端
        last_op_device: REMOTE_DEVICE,
        last_op_seq: 9,
        updated_at: LATER,
        tabs_data: JSON.stringify(tabsWithRestoreRate('g-heavy', 1, 10)),
      })
    );
    seedGroup(cloudRow('g-ok'));

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(
      groups.map(g => g.id),
      ['g-ok'],
      '还原率 1/10 的组必须整组跳过——宁可这一轮看不见它，也不能拿截断版覆盖云端'
    );
    assert.equal(
      JSON.parse(cloud.rows.get('g-heavy')!.tabs_data as string).length,
      10,
      '云端行必须原封保留（下一轮重试）'
    );
  });

  it('阈值由常量决定：恰好在阈值上放行、低一个标签就整组跳过', async () => {
    const { downloadSync, MIN_RESTORABLE_TAB_RATIO } = await import('@/utils/supabase/download');
    const TOTAL = 10;
    // 用常量推导边界而不是写死数字：调阈值时这条用例的意图不变
    const atThreshold = Math.ceil(MIN_RESTORABLE_TAB_RATIO * TOTAL);
    const belowThreshold = atThreshold - 1;
    assert.ok(belowThreshold >= 0, `阈值 ${MIN_RESTORABLE_TAB_RATIO} 与用例规模不匹配`);

    seedGroup(
      cloudRow('g-at', {
        tabs_data: JSON.stringify(tabsWithRestoreRate('g-at', atThreshold, TOTAL)),
      })
    );
    seedGroup(
      cloudRow('g-under', {
        tabs_data: JSON.stringify(tabsWithRestoreRate('g-under', belowThreshold, TOTAL)),
      })
    );

    const groups = await downloadSync.downloadTabGroups();
    const byId = new Map(groups.map(g => [g.id, g]));

    assert.ok(byId.has('g-at'), '还原率落在阈值上（>=）的组必须照常返回，不能过度跳过');
    assert.equal(byId.get('g-at')!.tabs.length, atThreshold, '允许丢弃的部分确实被丢了');
    assert.equal(byId.has('g-under'), false, '还原率低于阈值的组必须整组跳过');
  });

  it('大部分能还原时照常返回（别把判据做成「一个都不能丢」）', async () => {
    const { downloadSync, MIN_RESTORABLE_TAB_RATIO } = await import('@/utils/supabase/download');
    const TOTAL = 20;
    const restorable = Math.ceil(MIN_RESTORABLE_TAB_RATIO * TOTAL) + 2;
    seedGroup(
      cloudRow('g-mostly', {
        tabs_data: JSON.stringify(tabsWithRestoreRate('g-mostly', restorable, TOTAL)),
      })
    );

    const groups = await downloadSync.downloadTabGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs.length, restorable, '绝大多数标签可还原时不应跳过整组');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 老版本兼容分支：tabs 表回填
// ─────────────────────────────────────────────────────────────────────────
describe('下载：老版本兼容分支（tabs 表回填）', () => {
  it('没有 tabs_data 但 tabs 表有数据的组，走回填路径', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-legacy', { tabs_data: null }));
    cloud.tabs.push(
      {
        id: 'lt-1',
        group_id: 'g-legacy',
        user_id: USER_ID,
        url: 'https://legacy.example.com/a',
        title: 'A',
        created_at: NOW,
        last_accessed: NOW,
        pinned: false,
      },
      {
        id: 'lt-2',
        group_id: 'g-legacy',
        user_id: USER_ID,
        url: 'chrome://settings/',
        title: '设置',
        created_at: NOW,
        last_accessed: NOW,
        pinned: false,
      }
    );

    const groups = await downloadSync.downloadTabGroups();
    const legacy = groups.find(g => g.id === 'g-legacy');

    assert.ok(legacy, '有 tabs 表数据的组必须在结果里');
    assert.deepEqual(
      legacy!.tabs.map(t => t.url),
      ['https://legacy.example.com/a'],
      '回填同样过 sanitizeTabUrl 防线'
    );
    assert.equal(legacy!.tabs[0].group_id, 'g-legacy');
    assert.equal(legacy!.tabs[0].id, 'lt-1');
    assert.equal(
      cloud.requests.filter(r => r.path === 'tabs').length,
      1,
      '只该为无 tabs_data 的组回查一次 tabs 表'
    );
  });

  it('tabs 表回填同样受还原率判据约束：不过关的组从结果里整个拿掉（不留成空组）', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-legacy-bad', { tabs_data: null }));
    cloud.tabs.push(
      { id: 'lb-1', group_id: 'g-legacy-bad', user_id: USER_ID, url: 'https://ok.example.com/', title: 'ok', created_at: NOW, last_accessed: NOW },
      ...[1, 2, 3].map(i => ({
        id: `lb-bad-${i}`,
        group_id: 'g-legacy-bad',
        user_id: USER_ID,
        url: INTERNAL_URLS[i],
        title: 'bad',
        created_at: NOW,
        last_accessed: NOW,
      }))
    );

    const groups = await downloadSync.downloadTabGroups();

    assert.equal(
      groups.some(g => g.id === 'g-legacy-bad'),
      false,
      '回填出 1/4 的截断组必须整组跳过'
    );
    assert.equal(
      groups.some(g => g.tabs.length === 0),
      false,
      '更不能退化成零标签空组——那会被下游硬删并登记 purge'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. supportsOpStamp 探测失败 → 列选择降级
// ─────────────────────────────────────────────────────────────────────────
describe('下载：op-stamp 探测降级', () => {
  it('云端缺 last_op_seq 列时必须退回 select=*（带上不存在的列会让整次下载失败）', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    cloud.columns = { is_deleted: true, last_op_seq: false, deleted_at: true, version: true };
    seedGroup({
      id: 'g-plain',
      user_id: USER_ID,
      name: 'g-plain',
      created_at: NOW,
      updated_at: LATER,
      is_locked: false,
      version: 1,
      is_deleted: false,
      deleted_at: null,
      tabs_data: JSON.stringify([tabData('t-1', 'https://one.example.com/')]),
    } as unknown as CloudRow);

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(mainSelects(), [['*']], '探测判定不支持时只能 select=*');
    assert.equal(groups.length, 1, '降级只是列选择变了，下载本身必须照常成功');
    assert.equal(groups[0].lastOp, undefined, '没有印记列 → lastOp 留 undefined');
    assert.equal(groups[0].tabs.length, 1);
  });

  it('探测请求抛非确定性错误（网络抖动）时同样降级，且不缓存失败结果', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    cloud.probeFailure = 503;
    seedGroup(cloudRow('g-1'));

    const groups = await downloadSync.downloadTabGroups();

    assert.deepEqual(mainSelects(), [['*']], '探测失败必须按不支持处理（宁可少选列，不可让整次下载失败）');
    assert.equal(groups.length, 1, '降级后下载必须照常成功');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 下载结果与合并的配合（本地独有的组不得被下载结果挤掉）
// ─────────────────────────────────────────────────────────────────────────
describe('下载结果 × 组级 LWW 合并', () => {
  it('仅本地有的组在合并后必须原样保留', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    const { mergeOpStamped } = await import('@/core/opStampMerge');

    seedGroup(cloudRow('g-cloud', { last_op_device: REMOTE_DEVICE, last_op_seq: 5 }));
    const cloudGroups = await downloadSync.downloadTabGroups();

    const localOnly = {
      id: 'g-local',
      name: 'g-local',
      tabs: [{ id: 'lt', url: 'https://local.example.com/', title: 'l', createdAt: NOW, lastAccessed: NOW, group_id: 'g-local', pinned: false }],
      createdAt: NOW,
      updatedAt: LATER,
      isLocked: false,
    } as any;
    const merged = mergeOpStamped([localOnly], cloudGroups);

    assert.deepEqual(
      merged.map(g => g.id).sort(),
      ['g-cloud', 'g-local'],
      '下载结果里没有的组，本地那份必须留着（这条保证在 opStampMerge.ts，不在 download.ts）'
    );
  });

  it('[端到端] 部分失败的那一组：一轮「下载 → 合并 → 上传」之后云端一个标签都不能少', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { decryptData } = await import('@/utils/encryptionUtils');

    const fullTabs = tabsWithRestoreRate('g-x', 10, 10);
    // 本地：g-x 十全十美（另一个设备传过来的），外加一个只有本地才有的 g-y
    await seedLocal([
      {
        id: 'g-x',
        name: 'g-x',
        tabs: fullTabs.map(t => ({
          id: t.id,
          url: t.url,
          title: t.title,
          createdAt: NOW,
          lastAccessed: NOW,
          group_id: 'g-x',
          pinned: false,
        })),
        createdAt: NOW,
        updatedAt: LATER,
        isLocked: false,
        lastOp: { d: LOCAL_DEVICE, s: 1 },
        version: 1,
      },
      {
        id: 'g-y',
        name: 'g-y',
        tabs: [
          {
            id: 'y-1',
            url: 'https://y.example.com/',
            title: 'y',
            createdAt: NOW,
            lastAccessed: NOW,
            group_id: 'g-y',
            pinned: false,
          },
        ],
        createdAt: NOW,
        updatedAt: LATER,
        isLocked: false,
        lastOp: { d: LOCAL_DEVICE, s: 1 },
        version: 1,
      },
    ]);

    // 云端：g-x 印记更大（合并会选它），但它的 tabs_data 有 9/10 还原不出来
    const seededCloudTabs = tabsWithRestoreRate('g-x', 1, 10);
    seedGroup(
      cloudRow('g-x', {
        last_op_device: REMOTE_DEVICE,
        last_op_seq: 9,
        updated_at: LATER,
        tabs_data: JSON.stringify(seededCloudTabs),
      })
    );

    const down = await syncEngine.downloadAndMerge();
    assert.equal(down.success, true, `下载必须成功（实得：${down.reason ?? '无'}）`);

    const local = await storage.getGroups();
    const localX = local.find(g => g.id === 'g-x');
    assert.equal(localX?.tabs.length, 10, '本地那一份必须完好，绝不能被 1 个标签的截断版覆盖');
    assert.equal(
      local.some(g => g.id === 'g-y'),
      true,
      '本地独有的组不得因下载而消失'
    );
    assert.deepEqual(
      await storage.getPendingDeleteIds(),
      [],
      '被跳过的组绝不能进删除广播队列（v1.22.0 无回收站 = 永久删除）'
    );

    // 真正的事故发生在上传那一拍：截断版一旦回写，十个标签就全设备蒸发。
    // 本例本地那份的印记比云端旧，上传按设计认输（upload.ts 的严格 LT 守卫，
    // 那是另一个工作包的地界），所以这里断言的不是 up.success，而是
    // **云端行有没有被动过**——不管上传报什么，云端一个标签都不能少。
    const up = await syncEngine.upload({ syncSettings: false, forcePending: true });
    const written = await decryptData<any[]>(cloud.rows.get('g-x')!.tabs_data as string, USER_ID);
    assert.equal(
      written.length,
      10,
      `云端行回写后必须仍是 10 个标签——修复前这里会是 1 个（永久丢失）。上传结果：${String(
        up.error ?? up.success
      )}`
    );
    assert.deepEqual(
      written.map(t => t.url).sort(),
      seededCloudTabs.map(t => t.url).sort(),
      '云端行必须一个字节都没被动过（下载跳过它，上传又按印记认输）'
    );
    const localAfter = await storage.getGroups();
    assert.equal(
      localAfter.find(g => g.id === 'g-x')?.tabs.length,
      10,
      '本地那份也必须仍是 10 个标签'
    );
    assert.equal(
      localAfter.every(g => g.tabs.every(t => t.url.startsWith('https://'))),
      true,
      '本地存的必须是那份十全十美的 https 标签，没有被内部页污染'
    );
  });
});
