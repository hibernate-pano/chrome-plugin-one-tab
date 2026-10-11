// 缺陷 2 端到端：锁定但零标签的组跨同步周期必须存活（2026-10-10 拍板「锁定跨同步周期有效」）。
//
// ── 这条链路修复前会把用户的会话**永久删掉** ─────────────────────────────────
//   用户锁定会话 L → 删掉它最后一个标签
//     → applyRemoveTab 走 shouldAutoDeleteAfterTabRemoval 的锁定豁免
//       ⇒ 本地留下「0 标签 + isLocked=true」的组（**合法的、等着被再填的状态**）
//   → 下一次后台同步（≤60s）：downloadAndMerge 走
//       mergeOpStamped → dropEmptyGroups（isEmptyGroup = 只看有无活跃标签，**不看锁定**）
//     ⇒ L 被剔除 → removedGroupIds → storage.addPendingDeleteIds([L])
//     ⇒ 下一轮 upload：markCloudGroupsAsDeleted([L]) → 云端行 is_deleted=true 墓碑
//     ⇒ mergeOpStamped「云端墓碑 vs 本地活跃」把另一台设备上的 L 也不留
//   ⇒ 结果：**该会话在所有设备上被永久删除，无回收站，用户毫不知情**。
// 把用户按下锁定键的意图（「别自动清掉我」）翻译成「跨设备永久删除」。
//
// ── 为什么这条修复必须精确命中「同步合并导致的自动剔除」这一条路径 ──────────
// 三条路径的语义不同，混用就会按下葫芦起了瓢：
//   · 同步合并落盘（syncEngine）→ **锁定豁免**（本文件要钉的，也是缺陷 2 的修复）
//   · 导入 / UI 视图过滤（toActiveGroupsView、applyImportGroups）→ 不豁免
//     （2026-09-30 真实故障：两条逐字相同的锁定空组躺 7 个月，双栏撞 React 重复 key）
//   · 用户当场动作（applyRemoveTab / applyMoveTab / applyCleanDuplicates）→ 豁免
// 所以修法是**新增** dropSyncMergedGroups（锁定豁免）给同步路径用，
// 而不是改 isEmptyGroup 的全局语义（那会连带改变导入时的空壳合并行为）。
//
// ── 本文件跑真 syncEngine + 真 storage + 真 mutation 编排 ───────────────────
// 假云端与 tests/syncRoundTripWalkthrough.test.ts 同一套 PostgREST 子集契约
// （GET 解析 order / POST / PATCH / DELETE、eq./in()./lt. 过滤、select 投影、
// PGRST204 缺列降级、两个 BEFORE UPDATE 守卫的逐条判定）。不另造第四套方言。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
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
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'locked-empty-user';
const SESSION_KEY = 'sb-stub-auth-token';
const DEV_A = 'devA';
const DEV_B = 'devB';
const NOW = '2026-10-10T08:00:00.000Z';
const LATER = '2026-10-10T09:00:00.000Z';

// ── 本地存储底座（两台设备各一份，与 syncRoundTripWalkthrough 同一套）───────
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

// ── 假云端（PostgREST 子集，与 syncRoundTripWalkthrough 同一套契约）───────────
interface CloudRow {
  id: string;
  user_id: string;
  [k: string]: unknown;
}
const cloud = {
  columns: { is_deleted: true, last_op_seq: true, deleted_at: true } as Record<string, boolean>,
  rows: new Map<string, CloudRow>(),
  ops: [] as string[],
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

const jsonBody = (init: RequestInit | undefined): any =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const params = url.searchParams;

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'locked@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    return jsonRes({ message: 'not found' }, 404);
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
    const order = parseOrder(params);
    const sorted = [...cloud.rows.values()].filter(r => matches(r, params)).sort((a, b) => {
      for (const { col, asc } of order) {
        const av = String(a[col] ?? '');
        const bv = String(b[col] ?? '');
        if (av === bv) continue;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
    return jsonRes(sorted.slice(offset, offset + limit).map(r => project(r, cols)));
  }

  if (method === 'DELETE') {
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (matches(row, params)) {
        cloud.rows.delete(id);
        cloud.ops.push(`DELETE:${id}`);
      }
    }
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written = rows.map(row => writeRow(row.id, row));
    cloud.ops.push(`UPSERT:${written.map(r => r.id).join(',')}`);
    return jsonRes(written);
  }

  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      touched.push(writeRow(id, body));
    }
    cloud.ops.push(`PATCH:${touched.map(r => `${r.id}:del=${String(r.is_deleted)}`).join(',')}`);
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
}) as typeof fetch;

// ── 数据与 harness ────────────────────────────────────────────────────────
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
    scheduleUpload: async () => { await storage.setPendingUpload(true); },
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
  cloud.columns = { is_deleted: true, last_op_seq: true, deleted_at: true };
  for (const [name, deviceId] of [['A', DEV_A], ['B', DEV_B]] as const) {
    const s = deviceStores[name];
    s.clear();
    s.set('storage_version', JSON.stringify(5));
    s.set('tabvaultpro_device_id', JSON.stringify(deviceId));
    s.set('op_stamp_migrated', JSON.stringify(true));
    // 上传保护窗口（UPLOAD_GUARD_MS=35s）视为已过期
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
const pendingDeletes = async (): Promise<string[]> => {
  const { storage } = await import('@/utils/storage');
  return storage.getPendingDeleteIds();
};
const uploadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.upload({ syncSettings: false, forcePending: true });
};
const downloadNow = async () => {
  const { syncEngine } = await import('@/services/syncEngine');
  return syncEngine.downloadAndMerge();
};
/** 把上传保护窗口「等出」，不引入 sleep */
async function expireUploadGuard() {
  const { storage } = await import('@/utils/storage');
  await storage.setLastUploadTime(new Date(Date.now() - 60_000).toISOString());
}

const tombstoneRow = (id: string) => cloud.rows.get(id)?.is_deleted === true;

/** 结构层断言用：读仓库源码（剥块注释，避免注释里出现的名字造成误判） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel: string): string =>
  readFileSync(resolve(REPO_ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ══════════════════════════════════════════════════════════════════════════
describe('缺陷 2 · 锁定空组跨同步周期：不得被自动剔除并广播云端删除', () => {
  it('锁定会话删掉最后一个标签 → 下一轮同步后仍在本地，且**未**登记删除广播', async () => {
    say('\n=== 设备 A：建 2 个会话，其中 L 锁定，然后删掉 L 的最后一个标签 ===');
    await asDevice('A');
    await seed([
      mkGroup('L', { isLocked: true, lastOp: { d: DEV_A, s: 2 } }),
      mkGroup('K', { lastOp: { d: DEV_A, s: 3 } }),
    ]);

    // 首轮上云：两条活跃行都在
    const up0 = await uploadNow();
    assert.equal(up0.success, true, `前置：首轮上传必须成功（${up0.error ?? '无'}）`);
    assert.equal(cloud.rows.get('L')?.is_deleted, false, '前置：L 云端行应为活跃');

    // 用户当场动作：删掉 L 的最后一个标签 → applyRemoveTab 锁定豁免 → 留下 0 标签锁定组
    const del = await handlers.mutate({ op: 'removeTab', groupId: 'L', tabId: 'L-t1' });
    assert.equal(del.ok, true, `前置：removeTab 必须成功（${del.error ?? '无'}）`);
    const afterDel = await localGroups();
    const localL = afterDel.find(g => g.id === 'L');
    assert.ok(localL, '前置：锁定组删完最后一个标签后应仍然存在（锁定豁免）');
    assert.equal(localL.tabs.length, 0, '前置：它确实已经是零标签组');
    assert.equal(localL.isLocked, true, '前置：仍是锁定态');
    assert.deepEqual(
      await pendingDeletes(),
      [],
      '前置：用户当场删除 tab 走锁定豁免，不得登记组删除广播（否则这次修复毫无意义）'
    );

    // ── 关键一轮：下一次后台同步（≤60s 发生的那次 downloadAndMerge）─────
    say('\n=== 下一轮后台同步（downloadAndMerge）===');
    await expireUploadGuard();
    const down = await downloadNow();
    say(`   download success=${down.success}；reason=${down.reason ?? '-'}`);
    assert.equal(down.success, true, `同步必须成功（${down.reason ?? ''}）`);

    const afterSync = await localGroups();
    assert.ok(
      afterSync.find(g => g.id === 'L'),
      '锁定空组在同步后必须仍然存在 —— 修复前 dropEmptyGroups 会把它剔除'
    );
    assert.deepEqual(
      await pendingDeletes(),
      [],
      '锁定空组绝不能被登记进删除广播队列：那个队列会让 upload 把云端行打成墓碑，' +
        '于是该会话在**所有设备**上被永久删除（v1.22.0 起无回收站）。'
    );
    assert.equal(tombstoneRow('L'), false, '云端行此刻仍未被标墓碑');

    // ── 再走一轮上传：确认云端行也没有被标删 ──────────────────────────────
    say('\n=== 下一轮上传（把删除广播队列落地的那一步）===');
    const up1 = await uploadNow();
    say(`   upload success=${up1.success}；云端 L.is_deleted=${String(cloud.rows.get('L')?.is_deleted)}`);
    assert.equal(up1.success, true, `上传必须成功（${up1.error ?? '无'}）`);
    assert.equal(
      tombstoneRow('L'),
      false,
      '云端行必须仍是活跃行。若这里被标墓碑，说明删除意图还是被广播出去了 —— ' +
        '而锁定意味着用户明确不要这个会话消失。'
    );
  });

  it('未锁定的零标签组在同一轮同步里仍然被剔除（不得把空壳清理整体关掉）', async () => {
    // 修复只把「锁定」豁免出去，不能顺手把自动清理废掉——那会让空壳组（老版本
    // 设备写入的、导入剔空的）永久堆积，UI 视图层虽不渲染空卡，但 storage 会一直涨。
    say('\n=== 对照：未锁定空壳在同一轮同步里照旧被剔除 ===');
    await asDevice('A');
    await seed([
      mkGroup('L', { isLocked: true, lastOp: { d: DEV_A, s: 2 } }),
      mkGroup('U', { tabs: [], lastOp: { d: DEV_A, s: 3 } }),
    ]);
    assert.equal((await uploadNow()).success, true, '前置：首轮上传必须成功');

    // 云端把 U 换成零标签形状（老版本设备写入的空壳随 LWW 赢家到达）。
    // ⚠️ 必须**同时**推进 updated_at 与印记：探活（hasRemoteChanges）只看指纹列
    // （id/updated_at/version/is_deleted/印记），只改 tabs_data 的话 digest 与本地
    // 一致 → up_to_date 短路命中 → 根本不下载，下游的剔除路径压根没被触发，
    // 那这条用例就变成「什么都没发生也绿」。真实的对端写入必然同时改这两项。
    cloud.rows.set('U', {
      ...(cloud.rows.get('U') as CloudRow),
      tabs_data: JSON.stringify([]),
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      last_op_device: DEV_B,
      last_op_seq: 99,
    });

    await expireUploadGuard();
    const down = await downloadNow();
    assert.equal(down.success, true, `同步必须成功（${down.reason ?? ''}）`);

    const ids = (await localGroups()).map(g => g.id);
    say(`   同步后本地: ${ids.join(',')}`);
    assert.ok(ids.includes('L'), '锁定空组保留');
    assert.equal(
      ids.includes('U'),
      false,
      '未锁定的空壳必须照旧被剔除 —— 自动清理的主要收益不能因为这次修复而丢失'
    );
    assert.ok(
      cloud.ops.some(op => op.startsWith('UPSERT')),
      '同步后的合并结果必须真的被上传（空壳剔除的语义 = 登记删除意图 → 云端标墓碑）'
    );
    // 【断言钉的是「最终结果」而不是「队列在某刻的快照」】
    // 被剔除的 id 会进 pendingDeleteIds，紧接着的一轮 upload 把它广播成云端墓碑
    // 并清队 —— 于是队列在断言时已经空了（U 在那轮上传里被一并上行/广播）。
    // 早期版本这条断言读 pendingDeleteIds，在「上传已消费队列」的时序下不稳定；
    // 钉「云端行确实被标墓碑」既稳定、又更贴近用户可见的后果。
    const upAfter = await uploadNow();
    say(`   upload success=${upAfter.success}；云端 U.is_deleted=${String(cloud.rows.get('U')?.is_deleted)}`);
    assert.equal(upAfter.success, true, `上传必须成功（${upAfter.error ?? '无'}）`);
    assert.equal(
      tombstoneRow('U'),
      true,
      '未锁定的空壳必须照旧走完「剔除 → 登记删除 → 云端墓碑」整条自动清理链路；' +
        '这条用例防的是「本次修复顺手把自动清理整体关掉」。'
    );
    assert.equal(tombstoneRow('L'), false, '对照组：锁定的 L 绝不能跟着变成墓碑');
  });

  it('锁定空组在设备 B 上也拿不到墓碑（跨设备不删除）', async () => {
    // 单设备断言只证明「本地没被剔除」。真正的后果在**对端**：
    // 一旦 A 端把 L 打成墓碑，B 上的活跃副本会在下一轮合并里被服从掉。
    say('\n=== 设备 B：拿到 A 的会话后，A 清空锁定组 → B 不得丢这个会话 ===');
    await asDevice('A');
    await seed([mkGroup('L', { isLocked: true, lastOp: { d: DEV_A, s: 2 } })]);
    assert.equal((await uploadNow()).success, true, '前置：A 首轮上传必须成功');

    // B 首次下载 → 拿到 L
    await asDevice('B');
    await expireUploadGuard();
    assert.equal((await downloadNow()).success, true, '前置：B 首次下载必须成功');
    const bLocal = await localGroups();
    assert.deepEqual(bLocal.map(g => g.id), ['L'], '前置：B 必须拿到 L');
    say(`   B 本地: ${bLocal.map(g => `${g.id}(tabs=${g.tabs.length},locked=${g.isLocked})`).join(',')}`);

    // A 端删掉 L 的最后一个标签（锁定豁免 → 留下空壳），再跑两轮
    await asDevice('A');
    const del = await handlers.mutate({ op: 'removeTab', groupId: 'L', tabId: 'L-t1' });
    assert.equal(del.ok, true, `前置：A 的 removeTab 必须成功（${del.error ?? '无'}）`);
    await expireUploadGuard();
    assert.equal((await downloadNow()).success, true, 'A 的同步必须成功');
    const up = await uploadNow();
    assert.equal(up.success, true, `A 的上传必须成功（${up.error ?? '无'}）`);
    assert.equal(tombstoneRow('L'), false, 'A 不得把锁定的 L 打成墓碑');

    // B 再下载一轮
    await asDevice('B');
    await expireUploadGuard();
    const downB = await downloadNow();
    assert.equal(downB.success, true, `B 的下载必须成功（${downB.reason ?? ''}）`);
    const bAfter = await localGroups();
    say(`   B 同步后: ${bAfter.map(g => `${g.id}(tabs=${g.tabs.length})`).join(',') || '（空）'}`);
    assert.ok(
      bAfter.some(g => g.id === 'L'),
      '锁定的会话不得因为 A 端清空了标签而在 B 上消失 —— 用户锁定 = 「别自动清掉我」'
    );
  });
});

describe('缺陷 2 · 语义分层：两条判据不许互相污染', () => {
  it('同步合并路径用锁定豁免、导入与视图过滤仍用无保护判据', () => {
    // 结构层：钉住「修法是新增 dropSyncMergedGroups，而不是改 isEmptyGroup 的全局语义」。
    // 改了 isEmptyGroup 会连带把导入时的空壳清理也变成锁定豁免，
    // 而 2026-09-30 的真实故障（两条逐字相同的锁定空组躺 7 个月）正是导入路径引入的。
    const src = readSrc('src/services/syncEngine.ts');
    assert.match(
      src,
      /dropSyncMergedGroups\(mergedGroups\)/,
      '同步合并落盘必须走锁定豁免版'
    );
    assert.doesNotMatch(
      src,
      /dropEmptyGroups\(mergedGroups\)/,
      '同步合并落盘不得再用无保护判据 —— 那正是「锁定空组被跨设备永久删除」的直接原因'
    );
  });

  it('导入与视图过滤仍用 isEmptyGroup（不看锁定）', () => {
    const helpers = readSrc('src/store/slices/tabSliceHelpers.ts');
    assert.match(
      helpers,
      /\.filter\(g => !isEmptyGroup\(g\)\)/,
      'UI 视图过滤仍用无保护判据（2026-09-30 故障的修复不能被这次改动回退）'
    );
  });

  it('用户当场动作（applyMoveTab / applyCleanDuplicates）仍用锁定豁免判据', () => {
    const src = readSrc('src/core/mutationOps.ts');
    const start = src.indexOf('export function applyMoveTab');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    assert.match(
      body,
      /shouldAutoDeleteAfterTabRemoval\(movedSource, ''\)/,
      '拖走最后一个标签必须走锁定豁免（否则等于「锁定白锁」）'
    );
    assert.match(
      src,
      /if \(shouldAutoDeleteAfterTabRemoval\(after, ''\)\)/,
      '手动清理必须走锁定豁免（按钮文案就写着「锁定的会话除外」）'
    );
  });
});