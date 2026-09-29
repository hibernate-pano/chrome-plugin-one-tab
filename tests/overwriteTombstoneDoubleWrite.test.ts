// ITEM 1 回归：覆盖上传不得把同一个墓碑写两遍（tombstone double-write）。
//
// 修复前的链路（src/services/syncEngine.ts::upload）：
//   1) overwriteCloud 时把 allGroups（含墓碑）交给 uploadTabGroups，
//      覆盖 upsert 已按「本机印记」把每个墓碑写上云（seq=5/devB, is_deleted=true）
//   2) 紧接着又对同一批 id 调 markCloudGroupsAsDeleted(deletedIds)
//      → 其 stamp 分支读云端 OLD.last_op_seq 再 +1、last_op_device 换成本设备
//        （src/utils/supabase/upload.ts 的 'stamp' 分支）
//      → 同一行被写两遍：多 N 次 UPDATE + 一次读回 SELECT，
//        且与覆盖 upsert 的写入互相竞争；严格 LT 守卫一旦吞掉其中一次，
//        verifyUploadReadback 的 checkStamp 永远对不上 → 抛错 → pending_upload
//        保留 → 上传永久卡在重试循环。
//   今天只因为「覆盖的 DELETE 删在 upsert 前」（于是 upsert 是 INSERT，两个守卫
//   都是 BEFORE UPDATE 不参与）才没出事——那是 upload.ts 内部的隐式不变量。
//
// 修复：uploadTabGroups 返回本次真正写上云的墓碑 id（writtenTombstoneIds），
//       upload() 据此把同批 id 从 markCloudGroupsAsDeleted 的输入里剔除。
//
// 本文件钉死修复后的语义（假云端 = PostgREST 子集，跑真实 syncEngine.upload）：
//   A) 覆盖上传：墓碑行只被写一次，印记 = 本机印记；全程零 PATCH
//   B) 「第二遍写」确实会改写印记（见证旧行为不是 no-op）——直接调
//      markCloudGroupsAsDeleted 后 seq 由 5 变 6、device 变成本设备
//   C) 合并模式（overwriteCloud=false）：墓碑仍走 markCloudGroupsAsDeleted
//      （防止修复过度过滤，把删除意图整批丢掉）；墓碑 seq 的断言已从
//      「= 云端 OLD+1」改为「> 本机观察到的最大印记」，并在下方
//      「P1-2 墓碑 stamp 语义」里用真实 mergeOpStamped 钉住合并方向
//   D) 覆盖被跳过（本地无活跃组）时，墓碑仍走 markCloudGroupsAsDeleted
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

// 本文件跑真实 syncEngine（印记迁移、上传读回校验等会打大量日志）。在 `node --test`
// 下被测代码的原始 stdout 会与 test runner 自己的 v8 序列化结果消息共用同一条
// pipe，交错时父进程会随机报 "Unable to deserialize cloned data"（断言其实全过）。
// 故本文件静音 console；需要看日志用 VERBOSE=1 跑。
if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'user-under-test';
const SESSION_KEY = 'sb-stub-auth-token';
const DEVICE_ID = 'devLocal';
const NOW = '2026-09-24T08:00:00.000Z';

// ── localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）────────────
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
        for (const [key, v] of Object.entries(obj)) chromeData.set(key, v);
      },
      remove: async (k: string) => void chromeData.delete(k),
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
  alarms: { create: () => undefined, clear: async () => true, onAlarm: { addListener: () => undefined } },
};

// ── 假云端（PostgREST 子集，记录写操作顺序）────────────────────────────
interface CloudRow {
  id: string;
  user_id: string;
  is_deleted?: boolean;
  last_op_device?: string | null;
  last_op_seq?: number | null;
  [k: string]: unknown;
}

const cloud = {
  columns: { is_deleted: true, last_op_seq: true },
  rows: new Map<string, CloudRow>(),
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
    { code: 'PGRST204', message: `Could not find the '${col}' column`, details: null, hint: null },
    400
  );
}

function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (key === 'select' || key === 'limit' || key === 'on_conflict') continue;
    if (raw.startsWith('eq.')) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith('in.(')) {
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
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) return jsonRes({ message: 'not found' }, 404);

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
    cloud.ops.push('DELETE');
    return jsonRes([]);
  }

  if (method === 'POST') {
    const body = jsonBody(init);
    const rows: CloudRow[] = Array.isArray(body) ? body : [body];
    const written: CloudRow[] = [];
    for (const row of rows) {
      cloud.rows.set(row.id, { ...row });
      written.push(row);
    }
    cloud.ops.push(`UPSERT:${written.map(r => r.id).join(',')}`);
    return jsonRes(written);
  }

  if (method === 'PATCH') {
    const body = jsonBody(init) ?? {};
    const touched: CloudRow[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      cloud.rows.set(id, { ...row, ...body });
      touched.push({ ...row, ...body });
    }
    cloud.ops.push(`PATCH:${touched.map(t => t.id).join(',')}`);
    return jsonRes(touched);
  }

  return jsonRes({ message: `假云端不认识的请求: ${method}` }, 405);
}) as typeof fetch;

// ── 本地测试数据 ────────────────────────────────────────────────────────
function mkGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  } as any;
}

const ACTIVE = mkGroup('g-active', { lastOp: { d: DEVICE_ID, s: 3 } });
const TOMB_A = mkGroup('g-tomb-a', { isDeleted: true, lastOp: { d: DEVICE_ID, s: 5 } });
const TOMB_B = mkGroup('g-tomb-b', { isDeleted: true, lastOp: { d: DEVICE_ID, s: 6 } });

/**
 * case C 云端旧行的印记。它**故意远小于**本机观察到的最大印记（6），
 * 正是「墓碑 stamp 取云端 OLD+1」这个 bug 的触发形状：那样写出来的墓碑
 * （seq 2）在 mergeOpStamped 里会输给本地活跃副本（seq 5/6），本地组被保留
 * 并在下次上传时把 is_deleted 改回 false = 删除被静默撤销。
 */
const CLOUD_OLD_SEQ = 1;

before(async () => {
  await register(LOADER_PATH);
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set('tabvaultpro_device_id', JSON.stringify(DEVICE_ID));

  const { store } = await import('@/store');
  const { setFromCache } = await import('@/store/slices/authSlice');
  store.dispatch(setFromCache({ user: { id: USER_ID } as never, isAuthenticated: true }));
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  const { invalidateGroupsCache } = await import('@/utils/storage');
  const { storage } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setGroupsImmediate([ACTIVE, TOMB_A, TOMB_B]);
  invalidateGroupsCache();
});

describe('ITEM 1 覆盖上传：墓碑只写一遍（不再 tombstone double-write）', () => {
  it('A) 覆盖上传后墓碑行 = 本机印记，且全程零 PATCH（第二遍写已消除）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.upload({ overwriteCloud: true, syncSettings: false, forcePending: true });

    assert.equal(res.success, true, `覆盖上传应成功：${res.error ?? ''}`);
    assert.equal(res.skippedOverwrite, undefined, '本地有活跃组时不应报告跳过覆盖');

    // 墓碑行：只被 upsert 写过一次，印记 = 本机印记（seq 5 / 6，未被 +1 抬到 6 / 7）
    assert.equal(cloud.rows.get('g-tomb-a')?.is_deleted, true);
    assert.equal(cloud.rows.get('g-tomb-a')?.last_op_seq, 5, '墓碑印记必须保持本机 seq 5');
    assert.equal(cloud.rows.get('g-tomb-a')?.last_op_device, DEVICE_ID, '墓碑归属必须是本设备');
    assert.equal(cloud.rows.get('g-tomb-b')?.last_op_seq, 6, '墓碑印记必须保持本机 seq 6');
    assert.equal(cloud.rows.get('g-tomb-b')?.last_op_device, DEVICE_ID);
    assert.equal(cloud.rows.get('g-active')?.is_deleted, false);

    // 关键：没有任何 markCloudGroupsAsDeleted 的 UPDATE
    const patches = cloud.ops.filter(op => op.startsWith('PATCH'));
    assert.deepEqual(patches, [], `覆盖上传不允许再对墓碑行发 UPDATE（实得 ${patches.join(' | ')}）`);
    assert.equal(cloud.ops.filter(op => op.startsWith('UPSERT')).length, 1, '所有行应并入同一次 upsert');
  });

  it('B) 见证：第二遍写（markCloudGroupsAsDeleted）确实会改写印记 —— 旧行为不是 no-op', async () => {
    // 直接复现修复前 upload() 的那一步：对同一批 id 调 markCloudGroupsAsDeleted
    const { syncEngine } = await import('@/services/syncEngine');
    await syncEngine.upload({ overwriteCloud: true, syncSettings: false, forcePending: true });
    const before = { ...cloud.rows.get('g-tomb-a')! };
    assert.equal(before.last_op_seq, 5);

    const { markCloudGroupsAsDeleted } = await import('@/services/tabGroupSyncService');
    await markCloudGroupsAsDeleted(['g-tomb-a']);

    const after = cloud.rows.get('g-tomb-a')!;
    assert.equal(after.last_op_seq, 6, '第二遍写会把 seq 从 5 抬到 OLD+1');
    assert.equal(after.last_op_device, DEVICE_ID);
    // 若修复前 upload() 走了这一步，checkStamp 的期望值（本机 5）与云端 6 就不再
    // 同源——这正是「双写 = 多一次往返 + 多一份打架风险」的实质。
    assert.notEqual(after.last_op_seq, before.last_op_seq, '第二遍写确实改变了云端印记');
  });

  it('C) 合并模式（overwriteCloud=false）：墓碑仍走 markCloudGroupsAsDeleted（未被过度过滤）', async () => {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    const { maxObservedSeq } = await import('@/utils/seqRegistry');
    // 基准从 fixture 推导，不写死数字：墓碑 stamp 走本机 Lamport 时钟
    // （createSeqRegistry = 持久化 device_seq + 观察到的全网最大印记），
    // 不变式是「本设备发出的序号必须大于它观察到的任何设备的任何印记」。
    const observedMaxBefore = maxObservedSeq(await storage.getGroups());
    // 云端预置两条旧行（印记远小于本机观察值），合并模式下 upsert 走 onConflict 覆盖，
    // 墓碑不在本次 upsert 列表里 → 必须由 markCloudGroupsAsDeleted 处理
    cloud.rows.set('g-tomb-a', {
      id: 'g-tomb-a', user_id: USER_ID, is_deleted: false,
      last_op_device: 'devOld', last_op_seq: CLOUD_OLD_SEQ,
    });
    cloud.rows.set('g-tomb-b', {
      id: 'g-tomb-b', user_id: USER_ID, is_deleted: false,
      last_op_device: 'devOld', last_op_seq: CLOUD_OLD_SEQ,
    });

    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `合并上传应成功：${res.error ?? ''}`);

    const patched = cloud.ops.filter(op => op.startsWith('PATCH'));
    assert.ok(patched.length > 0, '合并模式必须对墓碑行发 UPDATE（markCloudGroupsAsDeleted）');
    assert.equal(cloud.rows.get('g-tomb-a')?.is_deleted, true, 'g-tomb-a 必须被标成墓碑');
    assert.equal(cloud.rows.get('g-tomb-b')?.is_deleted, true, 'g-tomb-b 必须被标成墓碑');
    // 合并模式墓碑由 markCloudGroupsAsDeleted 盖「本机 Lamport 印记」。
    // 旧断言写死 seq = 云端 OLD+1 = 2，而本机观察到的最大印记是 6 ——
    // 那个数字就是 bug 本身：seq 2 的墓碑在 mergeOpStamped 里输给 seq 5/6 的
    // 本地活跃副本，删除被撤销（见下方「墓碑 stamp 语义」用例）。
    assert.equal(cloud.rows.get('g-tomb-a')?.last_op_device, DEVICE_ID);
    assert.ok(
      observedMaxBefore !== null &&
        typeof cloud.rows.get('g-tomb-a')?.last_op_seq === 'number' &&
        (cloud.rows.get('g-tomb-a')!.last_op_seq as number) > observedMaxBefore,
      `墓碑 seq（${String(cloud.rows.get('g-tomb-a')?.last_op_seq)}）必须严格大于本机观察到的最大印记 ` +
        `（${String(observedMaxBefore)}）：取云端 OLD+1 会写出输给本地活跃副本的墓碑 = 删除被撤销`
    );
  });

  it('D) 覆盖被跳过（本地无活跃组）：墓碑仍走 markCloudGroupsAsDeleted', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    await storage.setGroupsImmediate([TOMB_A, TOMB_B]);
    invalidateGroupsCache();

    cloud.rows.set('g-tomb-a', {
      id: 'g-tomb-a', user_id: USER_ID, is_deleted: false,
      last_op_device: 'devOld', last_op_seq: 1,
    });

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.upload({ overwriteCloud: true, syncSettings: false, forcePending: true });

    assert.equal(res.success, true);
    assert.equal(res.skippedOverwrite, 'no-active-groups', '空本地必须报告覆盖被跳过');
    assert.ok(
      !cloud.ops.includes('DELETE'),
      '覆盖被跳过时绝不能 DELETE 云端（否则清空云端数据）'
    );
    assert.equal(
      cloud.rows.get('g-tomb-a')?.is_deleted,
      true,
      '覆盖没发生时，删除意图必须仍然由 markCloudGroupsAsDeleted 播出（不能随过滤一起丢掉）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P1-2 墓碑 stamp 的**语义**（不钉死任何具体数字）
//
// 危害不在「墓碑 seq 是 2 还是 7」，在**合并时墓碑会输给本地活跃组**：
// compareStamps 判本地赢 → mergeOpStamped 保留本地副本 → 下次上传把
// is_deleted 改回 false → 删除被静默撤销。下面的用例把「本机盖出的墓碑
// 印记」直接喂给真实的 mergeOpStamped 来断言这个方向，因此不依赖任何
// 取号策略的具体数值；将来实现怎么微调都不会失效，也不会被写死的数字挡住。
// ─────────────────────────────────────────────────────────────────────────
describe('P1-2 墓碑 stamp 语义：合并时墓碑必须赢过本地活跃副本', () => {
  /** 跑一次合并上传，让 markCloudGroupsAsDeleted 真的给云端行盖上本机墓碑印记 */
  async function broadcastTombstone(
    cloudRow: Record<string, unknown>
  ): Promise<{ device: string; seq: number }> {
    const { syncEngine } = await import('@/services/syncEngine');
    const { storage } = await import('@/utils/storage');
    cloud.rows.set('g-tomb-a', {
      id: 'g-tomb-a', user_id: USER_ID, is_deleted: false, ...cloudRow,
    } as any);
    await storage.clearPendingDeleteIds();
    const res = await syncEngine.upload({ syncSettings: false, forcePending: true });
    assert.equal(res.success, true, `合并上传应成功：${res.error ?? ''}`);
    const row = cloud.rows.get('g-tomb-a')!;
    assert.equal(row.is_deleted, true, '墓碑必须真的落云（否则下面的合并断言没有意义）');
    return { device: String(row.last_op_device), seq: row.last_op_seq as number };
  }

  /** 把云端墓碑行还原成 mergeOpStamped 认识的形状（只靠真实落库的那枚印记） */
  function asCloudTombstone(stamp: { device: string; seq: number }) {
    return {
      ...TOMB_A,
      isDeleted: true,
      lastOp: { d: stamp.device, s: stamp.seq },
    } as any;
  }

  it('云端旧印记远小于本机观察值时，本机盖出的墓碑仍然赢（本地活跃副本被移除）', async () => {
    const stamp = await broadcastTombstone({ last_op_device: 'devOld', last_op_seq: CLOUD_OLD_SEQ });
    const { mergeOpStamped } = await import('@/core/opStampMerge');

    // 本地活跃副本：把残留墓碑还原成「对端还没收到删除广播时的活跃组」
    const localActive = { ...TOMB_A, isDeleted: false } as any;
    const merged = mergeOpStamped([localActive], [asCloudTombstone(stamp)]);

    assert.deepEqual(
      merged.map(g => g.id),
      [],
      '墓碑赢时本地活跃副本必须被判为已删除（不进合并结果 → 不会被重新上传成活跃）'
    );
  });

  it('云端行 last_op_seq 为 NULL 时（本 bug 的直接触发条件），墓碑同样赢', async () => {
    // 旧实现 (null ?? 0) + 1 = 1：seq 1 的墓碑输给本地任何 seq >= 2 的组 = 删除被撤销
    const stamp = await broadcastTombstone({ last_op_device: null, last_op_seq: null });
    const { mergeOpStamped } = await import('@/core/opStampMerge');

    const localActive = { ...TOMB_A, isDeleted: false } as any;
    const merged = mergeOpStamped([localActive], [asCloudTombstone(stamp)]);

    assert.deepEqual(
      merged.map(g => g.id),
      [],
      '云端没有旧印记时，墓碑也必须赢——否则 seq 1 会被本地 seq 5/6 盖过，删除被撤销'
    );
  });

  it('对照：墓碑印记比本地旧时本地赢（compareStamps 方向不能反）', async () => {
    const { mergeOpStamped } = await import('@/core/opStampMerge');
    const localActive = { ...TOMB_A, isDeleted: false } as any;
    // 一枚**故意更旧**的墓碑（seq 0，设备号排在本机之后，不影响 s 的比较）
    const staleTombstone = { ...TOMB_A, isDeleted: true, lastOp: { d: 'devOld', s: 0 } } as any;

    const merged = mergeOpStamped([localActive], [staleTombstone]);
    assert.deepEqual(
      merged.map(g => g.id),
      ['g-tomb-a'],
      '墓碑比本地旧时必须保留本地活跃组（离线期间的本地修改赢过删除广播）'
    );
  });
});
