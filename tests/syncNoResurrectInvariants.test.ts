// 「删掉的东西不会被同步复活」不变量——把跑不了的 e2e 变成每次提交都会跑的断言。
//
// 【为什么有这份文件】
// 上一轮把三个断言旧墓碑语义的 e2e 脚本按 v1.22.0（无墓碑·删除即物理移除）重写了：
//   scripts/e2e-tab-delete-no-resurrect.mjs   （单标签删除的跨设备传播）
//   scripts/e2e-local-delete-no-resurrect.mjs（组删除 / 点开标签 不被后台同步覆盖）
//   scripts/e2e-stress-no-resurrect.mjs       （云端持续写入下的高压力不复活）
//   scripts/e2e-hard-delete-empty-group.mjs   （删最后一个标签 → 整组硬删）
// 但 scripts/run-e2e.mjs 需要 headed Chrome + 真实 Supabase 账号，会写线上库并残留
// 测试账号，**本地与 CI 都跑不了**。也就是说它们提供的安全网是假的：v1.22.0 没有
// 回收站，任何导致内容永久消失的路径都是最高级别事故，却没有一条在每次提交时执行过。
// 本文件把那些判据搬进 node:test，跑的是真 syncEngine + 真 storage + 真 mutation
// 编排，假云端用与 tests/syncUploadDownloadSafety.test.ts / overwriteTombstone 系列
// 完全同一套 PostgREST 子集契约（GET/POST/PATCH/DELETE、eq./in()./lt. 过滤、select
// 投影、PGRST204 缺列降级、两个 BEFORE UPDATE 守卫的逐条判定），不另造第三套方言。
//
// 【两台「设备」怎么模拟】
// 同一个进程里两套独立 localStorage 底座（KV 驱动在无 indexedDB 时回退
// window.localStorage，见 src/storage-kv/localStorageFallback.ts）+ 两个 deviceId。
// asDevice() 换底座时顺手整体失效 storage 的 30s 进程内缓存。
// 诚实说明这一行的实际作用：独立复审员实测把下面 asDevice() 里那行 clear()
// 去掉，5 条用例**全部仍然通过**（# pass 5 / # fail 0）——因为每条写路径自己
// 就调 invalidateGroupsCache（src/utils/storage.ts 的 setGroupsImmediate 等），
// 而本文件的 seed 走的正是 setGroupsImmediate，缓存本来就被打掉了。
// 所以它是**无害的双保险**，不是「不清就会假绿」的必要条件。保留它的理由是
// 将来若 seed 换成不失效缓存的写法能兜住；不保留的理由是不该用一句假的理由
// 给一行代码背书——注释声称「已验证」而实际没验证过，比不写更糟。
// session 放在共享的 chrome.storage.local 上——两台设备是同一个账号，这是对的。
//
// 【刻意不做的事】
// - 不写 sleep、不轮询等待。延迟上传的定时器不属于被钉的不变量，mutation 的
//   scheduleUpload 只绑「置位 pending_upload」这一条生产契约（见 mutationService.ts
//   的注释：置位必须先于调用方返回），闹钟那一拍由用例显式调 syncEngine.upload 复现。
// - 断言钉不变量（"B 端看不到这一组"），不钉具体 seq 号——实现策略微调时正确的
//   测试不该被挡住。
//
// 【反向验证：这些用例确实会在代码退化时变红】
// 每条都临时改坏过一处生产判据、确认对应用例转红、再原样改回（src 无残留）：
//   opStampMerge 去掉「云端墓碑 vs 本地活跃」分支   → 用例 1/2/4 转红
//   mutationOps  关掉「拿空最后一个标签→整组删除」 → 用例 2/3 转红
//   tabGroupUtils 去掉锁定组豁免                  → 用例 3 转红
//   readback 废掉 isConcededToCloudTombstone      → 用例 4 转红（reason=pending_upload_failed，
//                                                    即 P0「整台设备卡在上传失败循环」的原样）
//   syncEngine 跳过 markCloudGroupsAsDeleted      → 用例 1/2/4 转红
//   mutationHandlers 取消 noteGroupDeleted 登记    → 用例 1/2/3/4 转红
//   opStampMerge 废掉「活跃 vs 活跃」组级 LWW      → 用例 5 转红
// 注意：只关掉 upload.ts 的「写前认输预检」用例 4 **不会**转红——读回层的认输兜底
// 会独立兜住同一条链路。这是真实的双层防御，不是漏网；想验证预检单独失效需要
// 同时废掉两层判据。
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
const DEV_A = 'devA';
const DEV_B = 'devB';
const NOW = '2026-09-29T08:00:00.000Z';
const LATER = '2026-09-29T09:00:00.000Z';

// ── 本地存储：两套可切换的底座（模拟两台设备各自的 storage）────────────────
const deviceStores: Record<string, Map<string, string>> = { A: new Map(), B: new Map() };
let activeStore: Map<string, string> = deviceStores.A;

(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return activeStore.size;
    },
    key: (i: number) => [...activeStore.keys()][i] ?? null,
    getItem: (k: string) => (activeStore.has(k) ? (activeStore.get(k) as string) : null),
    setItem: (k: string, v: string) => void activeStore.set(k, String(v)),
    removeItem: (k: string) => void activeStore.delete(k),
    clear: () => activeStore.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (globalThis as any).window.localStorage;

// session 与账号同源：两台设备共用（chrome.storage.local，与生产一致）
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

// ── 假云端（PostgREST 子集，与 syncUploadDownloadSafety.test.ts 同一套契约）───
interface CloudRow {
  id: string;
  user_id: string;
  [k: string]: unknown;
}

const cloud = {
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作 */
  ops: [] as string[],
  /** 每次 upsert **请求体**里的 id（未被守卫吞掉之前），用于断言「谁写了什么」 */
  upsertAttempts: [] as string[][],
  /**
   * 每个请求进来时触发一次。用它把「上传进行到一半、用户又删了一个组」这个
   * 竞态确定性地插进广播与清队之间——这是 syncEngine.upload 里队列读走之后、
   * clearPendingDeleteIds 执行之前那段时间窗。设 null 取消。
   */
  onRequest: null as null | ((url: URL, method: string) => void),
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

/** 极简 PostgREST 过滤：user_id=eq.X、id=in.(...)、is_deleted=eq.true、deleted_at=lt.X */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'on_conflict' || key === 'order') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
      const ids = raw.slice(4, -1).split(',').map(s => s.replace(/"/g, '').trim());
      if (!ids.includes(String(row.id))) return false;
    } else if (raw.startsWith('lt.')) {
      // 缺失值（undefined）比任何 ISO 串都大 → 不判过期，与 Postgres NULL 比较一致
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
 * 服务端两个 BEFORE UPDATE 守卫的逐条判定（照抄 supabase/migrations 的 plpgsql）。
 * 没有它，假云端会「老实接受」被守卫静默吞掉的写入，「云端墓碑不会被旧副本改回
 * 活跃」这条不变量就变成一厢情愿。
 */
function applyGuards(old: CloudRow, next: CloudRow): CloudRow {
  // guard_tab_group_version：规则 1 墓碑翻转总是放行；规则 2 仅拒收严格更旧的 version
  const oldDel = old.is_deleted === true;
  const nextDel = next.is_deleted === true;
  const ov = old.version;
  const nv = next.version;
  if (oldDel === nextDel && typeof ov === 'number' && typeof nv === 'number' && nv < ov) {
    return old;
  }
  // guard_tab_group_op_stamp：两个守卫独立，任一 RETURN NULL 即整行丢弃
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
  cloud.onRequest?.(url, method);

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
    cloud.upsertAttempts.push(rows.map(r => String(r.id)));
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
    cloud.ops.push(`PATCH:${touched.map(t => `${t.id}:del=${String(t.is_deleted)}:seq=${String(t.last_op_seq)}`).join(',')}`);
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 测试数据 ──────────────────────────────────────────────────────────────
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

function withTabs(id: string, n: number, overrides: Record<string, unknown> = {}) {
  return mkGroup(id, {
    tabs: Array.from({ length: n }, (_, j) => mkTab(`${id}-t${j + 1}`, `https://${id}.example.com/${j + 1}`)),
    ...overrides,
  });
}

const tabsIn = (groups: any[], url: string) => groups.flatMap(g => g.tabs || []).filter((t: any) => t.url === url);
/** 写路径绝不允许产出的东西：本地组级墓碑 / tab 级墓碑 */
const localTombstones = (groups: any[]) => [
  ...groups.filter(g => g.isDeleted === true).map(g => `组:${g.id}`),
  ...groups.flatMap(g => (g.tabs || []).filter((t: any) => t.isDeleted === true).map((t: any) => `tab:${t.id}`)),
];

// ── 设备 harness ──────────────────────────────────────────────────────────
/**
 * 切换「当前设备」：换 KV 底座 + 顺手失效 storage 缓存。
 * 缓存失效是双保险而非必需：写路径自己就调 invalidateGroupsCache，且本文件的
 * seed 走的正是 setGroupsImmediate——实测去掉下面那行，5 条用例仍全绿。
 * 理由详见文件头同一说明。
 */
async function asDevice(which: 'A' | 'B'): Promise<void> {
  activeStore = deviceStores[which];
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').clear();
}

type Handlers = { mutate: (cmd: any) => Promise<{ ok: boolean; error?: string; scheduled: number[] }> };

let handlers: Handlers;

before(async () => {
  register(LOADER_PATH);
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));

  // SW 语义命令执行器：依赖按 src/background/mutationService.ts 的生产绑定复刻，
  // 差别只有一处——scheduleUpload 只做「置位 pending_upload」，不挂真实定时器
  // （定时器不属于被钉的不变量，闹钟那一拍由用例显式 upload 复现）。
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
    noteGroupDeleted: (id: string) => storage.addPendingDeleteId(id),
  });
  handlers = {
    mutate: async (cmd: any) => {
      const scheduled: number[] = [];
      const res = await h.handle(cmd);
      return { ok: res.ok, error: res.error, scheduled };
    },
  };
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  cloud.upsertAttempts.length = 0;
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true };

  for (const [name, deviceId] of [['A', DEV_A], ['B', DEV_B]] as const) {
    const store = deviceStores[name];
    store.clear();
    store.set('storage_version', JSON.stringify(5));
    store.set('tabvaultpro_device_id', JSON.stringify(deviceId));
    // 存量印记迁移不参与本文件：要考的是删除广播与合并，不是迁移
    store.set('op_stamp_migrated', JSON.stringify(true));
    // 上传保护窗口（UPLOAD_GUARD_MS=35s）视为已过期，等价于「下一拍闹钟」
    store.set('last_upload_time', JSON.stringify(new Date(Date.now() - 60_000).toISOString()));
  }

  activeStore = deviceStores.A;
  const { cacheManager } = await import('@/utils/performance');
  cacheManager.getCache('storage').clear();
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
});

/** 把 groups 直接写进当前设备的 storage（extra 用于铺 device_seq 等基础状态） */
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

const recycleBin = async (): Promise<any[]> => {
  const { storage } = await import('@/utils/storage');
  return storage.getDeletedGroups();
};

const uploadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.upload({ syncSettings: false, forcePending: true });
};

const downloadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.downloadAndMerge();
};

/** 把上传保护窗口「等出」：等价于 e2e 里 waitOutUploadGuard，不引入 sleep */
async function expireUploadGuard() {
  const { storage } = await import('@/utils/storage');
  await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
}

/** 把「时间前进到下一拍闹钟」需要的前置状态补齐后跑一次下载 */
async function backgroundTick() {
  await expireUploadGuard();
  return downloadNow();
}

// ─────────────────────────────────────────────────────────────────────────
// 不变量 1/2/3：组删除 → 物理消失 → 云端行标删 → 对端不复活 → 反向同步不回弹
// （对应 scripts/e2e-local-delete-no-resurrect.mjs 的判据①②④⑤与终检）
// ─────────────────────────────────────────────────────────────────────────
describe('组删除的跨设备传播：删掉的东西不会被同步复活', () => {
  it('A 删组 → A 本地物理消失 + 队列登记 → 上传后云端行 is_deleted → B 下载后看不到 → B 反传不改回', async () => {
    const victim = 'g-victim';
    const keep = 'g-keep';

    // ── 前置：A 持有两个组并已上云（B 稍后会拿到同样的旧副本）──────────
    await asDevice('A');
    await seed(
      [withTabs(victim, 2, { lastOp: { d: DEV_A, s: 2 } }), withTabs(keep, 1, { lastOp: { d: DEV_A, s: 2 } })],
      { device_seq: 2 }
    );
    const up0 = await uploadNow();
    assert.equal(up0.success, true, `前置：A 首次上传必须成功（${up0.error ?? '无'}）`);
    assert.equal(cloud.rows.get(victim)?.is_deleted, false, '前置：victim 云端行应为活跃');

    // ── 不变量 1：A 删除 → 本地物理消失 + 删除广播入队 ────────────────
    const del = await handlers.mutate({ op: 'deleteGroup', groupId: victim });
    assert.equal(del.ok, true, `deleteGroup 必须成功（${del.error ?? '无'}）`);

    const aAfterDelete = await localGroups();
    assert.equal(
      aAfterDelete.filter(g => g.id === victim).length,
      0,
      'A 本地必须物理删除该组（v1.22.0 没有回收站，不留任何痕迹）'
    );
    assert.deepEqual(
      aAfterDelete.filter(g => g.id === keep).map(g => g.id),
      [keep],
      '其余数据不能被误删（正控）'
    );
    assert.deepEqual(
      localTombstones(aAfterDelete),
      [],
      '写路径不得产出任何组级/tab 级墓碑（无墓碑模型的硬要求）'
    );
    assert.deepEqual(
      await recycleBin(),
      [],
      '不得进回收站——v1.22.0 已废除回收站'
    );
    assert.ok(
      (await pendingDeletes()).includes(victim),
      '删除意图必须登记进 pending_delete_ids：它是对端唯一的服从载体'
    );

    // ── 不变量 1（续）：上传后云端行必须标 is_deleted，队列才清空 ───────
    const up1 = await uploadNow();
    assert.equal(up1.success, true, `A 上传必须成功（${up1.error ?? '无'}）`);
    assert.equal(
      cloud.rows.get(victim)?.is_deleted,
      true,
      '云端行必须被标记删除——行保留是对端服从删除的唯一载体；行保持活跃 = 下轮合并复活'
    );
    assert.deepEqual(
      await pendingDeletes(),
      [],
      '队列只能在云端标记读回确认之后清空（清早了 = 删除意图丢失）'
    );
    assert.equal(
      cloud.rows.get(keep)?.is_deleted,
      false,
      '未删除的组不能被顺手标删（正控：其余数据没被误删）'
    );

    // ── 不变量 2：B 从云端下载合并后也看不到这一组 ────────────────────
    await asDevice('B');
    await seed([
      withTabs(victim, 2, { lastOp: { d: DEV_A, s: 2 } }),
      withTabs(keep, 1, { lastOp: { d: DEV_A, s: 2 } }),
    ]);
    assert.equal(
      (await localGroups()).filter(g => g.id === victim).length,
      1,
      '前置：B 本地必须先有删除前的旧副本，否则「没复活」是废话'
    );

    const syncBefore = (await import('@/utils/storage')).storage.getLastSyncTime();
    const downB = await backgroundTick();
    assert.equal(downB.success, true, `B 下载必须成功（${downB.reason ?? '无'}）`);
    assert.notEqual(
      await (await import('@/utils/storage')).storage.getLastSyncTime(),
      syncBefore,
      '正控：B 的下载必须真的执行过（last_sync_time 前进），否则后面都是空断言'
    );

    const bMerged = await localGroups();
    assert.equal(
      bMerged.filter(g => g.id === victim).length,
      0,
      '已删除的组不能在 B 端被云端带回来（跨设备不复活）'
    );
    assert.ok(
      bMerged.some(g => g.id === keep),
      '正控：未删除的组必须仍在 B 端（不是把数据一起删了）'
    );

    // ── 不变量 3：B 反向同步一轮，云端那行必须仍是 is_deleted ──────────
    const attemptsBeforeB = cloud.upsertAttempts.length;
    const upB = await uploadNow();
    assert.equal(upB.success, true, `B 上传必须成功（${upB.error ?? '无'}）`);
    const rowAfterB = cloud.rows.get(victim)!;
    assert.equal(rowAfterB.is_deleted, true, 'B 的旧副本不得把云端删除位改回 false');
    assert.equal(
      rowAfterB.last_op_device,
      DEV_A,
      '云端墓碑的归属必须仍是执行删除的那台设备（不被 B 冒用改写）'
    );
    const tombstoneStamp = Number(rowAfterB.last_op_seq);
    for (const ids of cloud.upsertAttempts.slice(attemptsBeforeB)) {
      assert.ok(
        !ids.includes(victim),
        `B 的本轮 upsert 不该包含已删除的组（实际写了 ${ids.join(',')}）`
      );
    }

    // ── 不变量 3（续）：A 再上传 → B 再下载，反向回路无回弹 ────────────
    await asDevice('A');
    assert.equal((await uploadNow()).success, true, 'A 的第二轮上传必须成功');
    await asDevice('B');
    const downB2 = await backgroundTick();
    assert.equal(downB2.success, true, `B 的二次下载必须成功（${downB2.reason ?? '无'}）`);
    assert.equal(
      (await localGroups()).filter(g => g.id === victim).length,
      0,
      '二次同步后已删除的组仍未复活'
    );
    assert.equal(
      cloud.rows.get(victim)?.is_deleted,
      true,
      '二次同步后云端删除位仍在'
    );
    assert.equal(
      Number(cloud.rows.get(victim)?.last_op_seq),
      tombstoneStamp,
      '二次同步后墓碑印记不得被回退'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 不变量 4：删掉最后一个标签 → 整组硬删（对应 scripts/e2e-hard-delete-empty-group.mjs）
// ─────────────────────────────────────────────────────────────────────────
describe('空组硬删除：拿空最后一个标签 → 整组从两端物理消失', () => {
  it('删唯一标签：本地不留痕、不进回收站、不产墓碑；上传后对端也看不到这一组', async () => {
    const solo = 'g-solo';
    const keep = 'g-keep';
    const soloUrl = `https://${solo}.example.com/1`;

    await asDevice('A');
    await seed(
      [withTabs(solo, 1, { lastOp: { d: DEV_A, s: 2 } }), withTabs(keep, 1, { lastOp: { d: DEV_A, s: 2 } })],
      { device_seq: 2 }
    );
    assert.equal((await uploadNow()).success, true, '前置：A 首次上传必须成功');

    // ── 删掉唯一的标签 ──────────────────────────────────────────────
    const rm = await handlers.mutate({ op: 'removeTab', groupId: solo, tabId: `${solo}-t1` });
    assert.equal(rm.ok, true, `removeTab 必须成功（${rm.error ?? '无'}）`);

    const aAfter = await localGroups();
    assert.equal(
      aAfter.filter(g => g.id === solo).length,
      0,
      '拿空最后一个标签的组必须物理消失（空组无内容可恢复）'
    );
    assert.deepEqual(localTombstones(aAfter), [], '写路径不得产出墓碑组/墓碑 tab');
    assert.deepEqual(await recycleBin(), [], '空组不进回收站（对应 e2e 脚本的「不留墓碑」判据）');
    assert.ok(
      (await pendingDeletes()).includes(solo),
      '空组同样要走删除广播：云端那一行若保持活跃，对端下载会把它连同旧标签带回来'
    );

    const up = await uploadNow();
    assert.equal(up.success, true, `A 上传必须成功（${up.error ?? '无'}）`);
    assert.equal(
      cloud.rows.get(solo)?.is_deleted,
      true,
      '云端行必须被标记删除（保持活跃 = 对端复活入口）'
    );

    // ── B 端：删除前的老副本必须在下载后消失 ─────────────────────────
    await asDevice('B');
    await seed([
      withTabs(solo, 1, { lastOp: { d: DEV_A, s: 2 } }),
      withTabs(keep, 1, { lastOp: { d: DEV_A, s: 2 } }),
    ]);
    const down = await backgroundTick();
    assert.equal(down.success, true, `B 下载必须成功（${down.reason ?? '无'}）`);

    const bAfter = await localGroups();
    assert.equal(bAfter.filter(g => g.id === solo).length, 0, '空组不得在 B 端复活');
    assert.equal(tabsIn(bAfter, soloUrl).length, 0, '被删标签的 URL 不得在 B 端出现');
    assert.ok(bAfter.some(g => g.id === keep), '正控：多标签的组必须仍在（只删了一个标签）');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 不变量 5：锁定组豁免自动删除（删最后一个标签不触发整组删除）
// ─────────────────────────────────────────────────────────────────────────
describe('锁定组豁免：删最后一个标签也不触发整组删除', () => {
  it('同一次会话里，锁定组留空保留且不入删除广播，未锁定组照常整组删除', async () => {
    const locked = 'g-locked';
    const open = 'g-open';

    await asDevice('A');
    await seed([
      withTabs(locked, 1, { isLocked: true, lastOp: { d: DEV_A, s: 2 } }),
      withTabs(open, 1, { lastOp: { d: DEV_A, s: 2 } }),
    ]);

    const rmLocked = await handlers.mutate({ op: 'removeTab', groupId: locked, tabId: `${locked}-t1` });
    assert.equal(rmLocked.ok, true, `锁定组的 removeTab 必须成功（${rmLocked.error ?? '无'}）`);

    const afterLocked = await localGroups();
    const lockedGroup = afterLocked.find(g => g.id === locked);
    assert.ok(lockedGroup, '锁定组删空后必须保留（锁定是用户显式的防误删保护）');
    assert.equal(lockedGroup.tabs.length, 0, '标签本身仍被物理移除');
    assert.ok(
      !(await pendingDeletes()).includes(locked),
      '锁定组留空不属于「组被删除」，不得登记云端删除广播——否则会误删对端数据'
    );

    const rmOpen = await handlers.mutate({ op: 'removeTab', groupId: open, tabId: `${open}-t1` });
    assert.equal(rmOpen.ok, true, `未锁定组的 removeTab 必须成功（${rmOpen.error ?? '无'}）`);

    const afterOpen = await localGroups();
    assert.equal(afterOpen.filter(g => g.id === open).length, 0, '未锁定组拿空后照常整组删除（对照组）');
    assert.ok(afterOpen.some(g => g.id === locked), '正控：锁定组仍在（豁免只对锁定生效）');
    assert.deepEqual(
      await pendingDeletes(),
      [open],
      '删除广播队列里只应有未锁定那一组'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 不变量 6：认输场景——A 删除、B 离线编辑过 → 收敛到「已删除」且不卡死循环
// （P0：合并上传撞更新的云端墓碑 → 整台设备永久卡在 pending_upload_failed）
// ─────────────────────────────────────────────────────────────────────────
describe('认输场景：本地旧副本遇到更新的云端墓碑时收敛，且不会卡进上传失败循环', () => {
  it('B 的离线旧印记输给云端墓碑 → 本地组被物理移除、上传成功、下一拍仍能同步', async () => {
    const doomed = 'g-doomed';
    const keep = 'g-keep';

    // A 是活跃设备：持久化号位远高于 B，删除时盖出的墓碑印记必然压过 B 的离线编辑
    await asDevice('A');
    await seed(
      [withTabs(doomed, 1, { lastOp: { d: DEV_A, s: 7 } }), withTabs(keep, 1, { lastOp: { d: DEV_A, s: 7 } })],
      { device_seq: 20 }
    );
    assert.equal((await uploadNow()).success, true, '前置：A 首次上传必须成功');
    const aDelete = await handlers.mutate({ op: 'deleteGroup', groupId: doomed });
    assert.equal(aDelete.ok, true, `前置：A 删除必须成功（${aDelete.error ?? '无'}）`);
    assert.equal((await uploadNow()).success, true, '前置：A 删除后的上传必须成功');

    const tombstone = cloud.rows.get(doomed)!;
    assert.equal(tombstone.is_deleted, true, '前置：云端行已是墓碑');
    const tombstoneSeq = Number(tombstone.last_op_seq);
    assert.ok(
      tombstoneSeq > 8,
      `前置：墓碑印记必须压得过 B 的离线印记 8（实得 ${tombstoneSeq}）`
    );

    // B：离线期间改过这一组（本地印记 {B, 8}），且改动还没推上云
    await asDevice('B');
    await seed(
      [
        withTabs(doomed, 1, { name: 'B 离线改名过', lastOp: { d: DEV_B, s: 8 } }),
        withTabs(keep, 1, { lastOp: { d: DEV_A, s: 7 } }),
      ],
      { device_seq: 8, pending_upload: true }
    );
    const { storage } = await import('@/utils/storage');
    assert.equal(await storage.getPendingUpload(), true, '前置：B 有未推送的离线改动');

    // ── 关键一轮：downloadAndMerge 会先走 upload_first ────────────────
    // 修复前这里必然失败：旧印记 upsert 撞服务端 op-stamp 守卫被静默吞写 →
    // 读回发现 is_deleted 仍是 true → 抛错 → pending_upload 永不清 →
    // 之后每轮都撞 upload_first，这台设备一次都下载不了。
    const down = await backgroundTick();
    assert.notEqual(down.reason, 'pending_upload_failed', 'B 的下载不得被上传失败卡住（P0 复发）');
    assert.notEqual(down.reason, 'already_syncing', '同步器状态必须是干净的');
    assert.equal(down.success, true, `B 下载必须成功（${down.reason ?? '无'}）`);

    const bAfter = await localGroups();
    assert.equal(
      bAfter.filter(g => g.id === doomed).length,
      0,
      'B 的旧副本必须服从云端墓碑被物理移除（收敛到「已删除」）'
    );
    assert.ok(bAfter.some(g => g.id === keep), '正控：未冲突的组必须留下（不是把数据清空了）');
    assert.equal(
      await storage.getPendingUpload(),
      false,
      'pending_upload 必须被清掉——它不清就意味着永久重试循环'
    );
    assert.deepEqual(
      await pendingDeletes(),
      [],
      '认输的组云端已是墓碑，无需再广播删除（否则会把仅存的那份也删掉）'
    );

    const row = cloud.rows.get(doomed)!;
    assert.equal(row.is_deleted, true, '云端墓碑必须原样保留：认输不是撤销对方的删除');
    assert.equal(row.last_op_device, DEV_A, '墓碑归属不得被 B 的旧副本改写');
    assert.equal(Number(row.last_op_seq), tombstoneSeq, '墓碑印记不得被 B 的旧值覆盖');
    // B 离线期间有未推送改动：只检查 B 自己的 upsert，别把 A 的合法写入算进来
    const attemptsBeforeB = cloud.upsertAttempts.length;
    for (const ids of cloud.upsertAttempts.slice(attemptsBeforeB)) {
      assert.ok(!ids.includes(doomed), `B 的本轮 upsert 不该包含认输的组（实际 ${ids.join(',')}）`);
    }

    // ── 下一拍闹钟：证明没有卡进失败循环 ────────────────────────────
    const down2 = await backgroundTick();
    assert.equal(down2.success, true, `第二轮下载必须成功（${down2.reason ?? '无'}）`);
    const up2 = await uploadNow();
    assert.equal(up2.success, true, `第二轮上传也必须成功（${up2.error ?? '无'}）——否则就是卡在重试循环`);
    assert.equal(
      (await localGroups()).filter(g => g.id === doomed).length,
      0,
      '第二轮同步后该组仍未复活'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 标签增删的跨设备传播：组级 LWW 整组覆盖
// （对应 scripts/e2e-tab-delete-no-resurrect.mjs 的判据①②③）
// ─────────────────────────────────────────────────────────────────────────
describe('标签删除的跨设备传播：组级 LWW 整组覆盖，被删的 URL 不会回来', () => {
  it('B 删中间那个标签 → A 下载后该组也只剩 2 个 → 目标 URL 在 A 整个 storage 里不存在 → 反向回路无回弹', async () => {
    const grp = 'g-multi';
    const victimUrl = `https://${grp}.example.com/2`;

    await asDevice('A');
    await seed([withTabs(grp, 3, { lastOp: { d: DEV_A, s: 2 } })], { device_seq: 2 });
    assert.equal((await uploadNow()).success, true, '前置：A 首次上传必须成功');

    // B 登录后从云端下载（走真实链路，不手工铺数据）
    await asDevice('B');
    const down0 = await backgroundTick();
    assert.equal(down0.success, true, `B 首次下载必须成功（${down0.reason ?? '无'}）`);
    const bInit = await localGroups();
    assert.equal(bInit.length, 1, '正控：B 必须真的拿到 A 的 3 标签会话');
    assert.equal(bInit[0].tabs.length, 3, '正控：B 拿到的必须是 3 个标签');

    // B 删中间那个标签：组非空 → 组保留，stamp 提升，整组行覆盖上云
    const rm = await handlers.mutate({ op: 'removeTab', groupId: grp, tabId: `${grp}-t2` });
    assert.equal(rm.ok, true, `B 的 removeTab 必须成功（${rm.error ?? '无'}）`);

    const bAfterDel = await localGroups();
    assert.equal(bAfterDel.find(g => g.id === grp)?.tabs.length, 2, 'B 本地该组剩 2 个标签');
    assert.equal(tabsIn(bAfterDel, victimUrl).length, 0, '目标标签在 B 整个 storage 里物理消失');
    assert.deepEqual(localTombstones(bAfterDel), [], '写路径不得产出 tab 级墓碑');

    const upB = await uploadNow();
    assert.equal(upB.success, true, `B 上传必须成功（${upB.error ?? '无'}）`);
    const { decryptData } = await import('@/utils/encryptionUtils');
    const cloudTabs = await decryptData<any[]>(String(cloud.rows.get(grp)?.tabs_data), USER_ID);
    assert.equal(cloudTabs.length, 2, '云端行必须被整组覆盖成 2 个标签（组级 LWW 整组覆盖）');
    assert.equal(
      cloudTabs.filter((t: any) => t.url === victimUrl).length,
      0,
      '被删标签不得留在云端行里（它会随下一轮下载被带回来）'
    );

    // A 下载合并：整组赢，A 端该组也只剩 2 个
    await asDevice('A');
    const downA = await backgroundTick();
    assert.equal(downA.success, true, `A 下载必须成功（${downA.reason ?? '无'}）`);
    const aAfter = await localGroups();
    assert.equal(aAfter.find(g => g.id === grp)?.tabs.length, 2, 'A 端该组收到 B 的 2 标签覆盖');
    assert.equal(
      tabsIn(aAfter, victimUrl).length,
      0,
      '被删的标签不得在 A 端复活（跨设备不复活）——跨组也不许出现'
    );

    // 反向回路：A 上传 → B 下载，仍不回弹
    assert.equal((await uploadNow()).success, true, 'A 的反向上传必须成功');
    await asDevice('B');
    const downB = await backgroundTick();
    assert.equal(downB.success, true, `B 的二次下载必须成功（${downB.reason ?? '无'}）`);
    const bFinal = await localGroups();
    assert.equal(bFinal.find(g => g.id === grp)?.tabs.length, 2, '二次同步后 B 端仍是 2 个标签');
    assert.equal(tabsIn(bFinal, victimUrl).length, 0, '被云端带回来的 URL 必须为 0');
    assert.deepEqual(localTombstones(bFinal), [], '同步后 storage 里不得出现墓碑 tab');
    assert.equal(
      bFinal.filter(g => (g.tabs || []).length === 0).length,
      0,
      '同步后不得出现空壳组（老版本设备写入的空壳不再落地）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 竞态回归：上传进行到一半，用户又删了一个组
//
// 背景（这个洞连着被交付了两次，所以这里钉的是**调用方**而不是库函数）：
//   storage.clearPendingDeleteIds 新增了「按确认清单消费」的重载，但两处生产
//   调用方（syncEngine 的覆盖下载前广播、覆盖上传后广播）**都还在无参调用**，
//   正好落进「整队清空」分支。配套的库函数单测全绿——它直接调
//   storage.clearPendingDeleteIds(清单)，测的是新能力，不是生产路径有没有用上。
//   换句话说：库函数是对的、接缝是断的，而没有任何测试从 syncEngine 这一侧看。
//   这条用例就是从 syncEngine 那一侧看的——它会因为「调用方没传清单」而失败。
//
// 复现窗口（syncEngine.upload 内）：
//   t0 读走队列（内容 A） → t1 广播 A 成功 → t2 清队
//                    ↑ 在 t1 广播进行中、t2 之前，用户删了 B，
//                      且 B 的 KV 写失败 → 只落进内存兜底
// 旧行为：t2 整队清空把 B 连坐抹掉 → B 已本地物理删除、云端行仍是活跃行
//         → 任何设备下次合并走 `cg && !lg` 整组加回来 → 永久丢失、零提示
// 正确行为：清队只点名 A，B 留在队列里等下一轮被广播
// ─────────────────────────────────────────────────────────────────────────
describe('竞态：广播期间新登记的删除意图不得被连坐清队', () => {
  /** 让 localStorage 底座对指定键的写入抛错，模拟一次瞬时 KV 写失败。 */
  function breakKvWriteFor(key: string): () => void {
    const ls = (globalThis as any).localStorage;
    const original = ls.setItem;
    ls.setItem = (k: string, v: string) => {
      if (k === key) throw new Error('KV 瞬时写失败');
      return original.call(ls, k, v);
    };
    return () => { ls.setItem = original; };
  }

  it('A 的删除已广播 → 广播途中新删的 B 仍留在队列里等下一轮', async () => {
    await asDevice('A');
    cloud.rows.clear();
    cloud.ops.length = 0;
    cloud.upsertAttempts.length = 0;

    const mk = (id: string, url: string) => ({
      id, name: id.toUpperCase(),
      tabs: [{ id: `${id}-t1`, url, title: id }],
      createdAt: NOW, updatedAt: NOW, isLocked: false, version: 1,
    });
    await seed([mk('g-a', 'https://a.example/1'), mk('g-b', 'https://b.example/1')]);

    // 先正常上传一轮把云端行建起来（不手工塞 cloud.rows —— 读回校验要比对
    // updated_at/印记，手写的行形状对不上，那是测试脚手架的问题不是被测行为）
    const up0 = await uploadNow();
    assert.equal(up0.success, true, `前置：首轮上传必须成功（${up0.error ?? '无'}）`);
    assert.equal(cloud.rows.get('g-a')?.is_deleted, false, '前置：g-a 云端行应为活跃');

    // A 只删了 g-a（进待广播队列）
    const del = await handlers.mutate({ op: 'deleteGroup', groupId: 'g-a' });
    assert.equal(del.ok, true, `前置：deleteGroup 必须成功（${del.error ?? '无'}）`);
    assert.deepEqual((await pendingDeletes()).slice().sort(), ['g-a'], '前置：队列里只有 g-a');

    // 广播 g-a 的过程中（PATCH 打到云端那一刻）用户又删了 g-b，且 KV 写失败
    const { storage } = await import('@/utils/storage');
    const restoreKv = breakKvWriteFor('pending_delete_ids');
    let injected = false;
    cloud.onRequest = (url, method) => {
      if (injected || method !== 'PATCH' || !url.pathname.endsWith('/rest/v1/tab_groups')) return;
      injected = true;
      // 此刻 g-a 正在被广播、清队还没执行——正是竞态窗口
      void storage.addPendingDeleteId('g-b').catch(() => undefined);
    };
    try {
      const res = await uploadNow();
      assert.equal(res.success, true, `本轮上传应成功：${res.error ?? ''}`);
      assert.equal(injected, true, '必须真的把删除注入到广播途中，否则本用例无效');
      assert.equal(cloud.rows.get('g-a')?.is_deleted, true, '前置复核：g-a 应已被广播成墓碑');
    } finally {
      cloud.onRequest = null;
      restoreKv();
    }

    // 关键断言：B 的删除意图必须还在队列里，等下一轮广播
    const left = await pendingDeletes();
    assert.ok(
      left.includes('g-b'),
      `g-b 的删除意图被连坐清掉了 —— 队列只剩 [${left.join(',')}]。它已本地物理删除而云端行仍活跃，`
      + '下次任何设备合并都会整组复活，且 v1.22.0 起无回收站。'
    );
    assert.ok(!left.includes('g-a'), 'g-a 确实已广播成功，不该留在队列里');
  });
});
