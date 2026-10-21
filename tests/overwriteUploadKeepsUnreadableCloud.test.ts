// 覆盖上传**不得删掉**「云端有、这台设备读不出来、本机又没有副本」的那几行（2026-10-20 P1）。
//
// ── 这个文件在防什么回归 ─────────────────────────────────────────────────
//
// 覆盖上传（overwriteCloud）的语义是「云端完全以本机为准」：旧实现先 DELETE
// 掉该用户的**全部**云端行，再把本机清单 upsert 回去。
//
// 但云端有些行**这台设备读不出来**（形状不可恢复 / 还原率不达标 / tabs 表被
// 网关截断 / 单组处理异常 —— 见 src/utils/supabase/download.ts 的跳过清单）。
// 对其中「本机又没有副本」的那些行：
//
//   1. 读不出来 ⇒ 本机没有它们的内容，无法重建；
//   2. 没有副本 ⇒ 云端那一份是用户**仅存**的一份（另一台设备写的 / 本机
//      解不开设备绑定密钥）。
//
// 两条同时成立时删掉它 = **永久丢失**（v1.22.0 起无回收站、删除即物理清除），
// 而用户点的「覆盖上传」只想让云端以本机为准，并不想销毁自己仅存的数据。
//
// D-6（2026-10-20）已经在**覆盖下载**那条路径上保住了这批行；覆盖**上传**
// 这条路径当时是漏的 —— 这就是本文件。
//
// ── 本文件钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
//   1. 读不出来 + 本机无副本 ⇒ 那行云端行在覆盖上传后**仍然存在**；
//   2. 读得出来的云端独有行 ⇒ 照常被删（覆盖语义没被削弱）；
//   3. 本机有副本的读不出来的行 ⇒ 照常被本机那份**顶上去**（是修复，不是丢失）；
//   4. 没有需要保护的行时 ⇒ 行为与修复前逐字一致（一次性 DELETE 全部）。
//
// ── 装置 ──────────────────────────────────────────────────────────────────
//
// 假云端 = PostgREST 子集（GET/POST/DELETE/PATCH + eq./in.() 过滤）。
// 与 tests/overwriteTombstone.test.ts 同一套形状，但**多了**解密与还原：
// 覆盖上传要判断「哪些行读不出来」，必须真的走一遍下载侧的还原判据
// （所以这里的 tabs_data 是真加密的，坏行是**真坏**的）。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubSessionJson } from './_helpers/stubSession.ts';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_ID = 'user-overwrite-guard';
const SESSION_KEY = 'sb-stub-auth-token';
const NOW = '2026-10-20T08:00:00.000Z';
const LATER = '2026-10-20T09:00:00.000Z';

// ── 浏览器/扩展环境桩（必须在被测模块被 import 之前就位）───────────────
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
    clear: () => void lsData.clear(),
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

// ── 假云端（PostgREST 子集） ─────────────────────────────────────────────
interface CloudRow {
  id: string;
  user_id?: string;
  [k: string]: unknown;
}

const cloud = {
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作（用于断言删除范围） */
  ops: [] as string[],
  /**
   * 模拟「服务端删多了」：DELETE 不看 id 过滤，把该用户的行全删。
   *
   * 真实世界里这对应「我们的删除语句写错了 / 网关把过滤条件丢了」这类服务端异常。
   * 它存在的意义是让**读回校验**那条防线有可测的触发条件：删除多删了 ⇒
   * 受保护的行不见了 ⇒ 必须当场现形（抛错），而不是报一句「上传成功」。
   */
  deleteOverreaches: false,
  /**
   * 模拟「读云端失败」（网络 / 网关 / 会话过期）。
   *
   * 覆盖上传在删除之前必须做一次可读性探测；探测读不出来时**必须中止**
   * （fail-closed），而不是拿「不知道哪些行读不出来」去做一次不可逆的全量删除。
   */
  readFails: false,
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

/** 极简过滤：只认 eq. 与 in.()；select/order/offset/limit/on_conflict 不是过滤器。 */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict', 'Prefer'].includes(key)) continue;
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
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    return jsonRes({ message: 'not found' }, 404);
  }

  if (method === 'GET') {
    if (cloud.readFails) {
      return jsonRes({ message: 'simulated read failure' }, 500);
    }
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    // 列探测：本装置固定「列都在」⇒ 探测一律成功。
    // （真的探测 404 的话，覆盖上传会退化成不带印记列的路径，与本文件要验的
    //   「哪些行被删」无关。）
    for (const c of cols) {
      if (c === '__never__') return missingColumnRes(c);
    }
    const limit = Number(params.get('limit') ?? Number.POSITIVE_INFINITY);
    const offset = Number(params.get('offset') ?? 0);
    const hit = [...cloud.rows.values()].filter(r => matches(r, params));
    // 排序：created_at DESC + id DESC（与 download.ts 的 order 一致）。
    hit.sort((a, b) => {
      const byCreated = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      return byCreated !== 0 ? byCreated : String(b.id).localeCompare(String(a.id));
    });
    const page = hit.slice(offset, offset + limit);
    // count=exact 走 Content-Range 回传总数（postgrest-js 读它算 count）。
    const headers: Record<string, string> =
      params.get('select')?.includes('*') || params.get('select')?.includes('tabs_data')
        ? { 'content-range': `0-${Math.max(page.length - 1, 0)}/${hit.length}` }
        : {};
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  if (method === 'DELETE') {
    const deleted: string[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      // deleteOverreaches = 模拟服务端把过滤条件丢了（该用户的行全删）。
      const hit = cloud.deleteOverreaches
        ? String(row.user_id ?? '') === (params.get('user_id') ?? '').replace(/^eq\./, '')
        : matches(row, params);
      if (hit) {
        cloud.rows.delete(id);
        deleted.push(id);
      }
    }
    cloud.ops.push(`DELETE:${deleted.sort().join(',')}`);
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
    cloud.ops.push(`UPSERT:${written.map(r => r.id).sort().join(',')}`);
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
    cloud.ops.push(`PATCH:${touched.map(r => r.id).sort().join(',')}`);
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

function tabData(id: string, url: string) {
  return {
    id,
    url,
    title: id,
    created_at: NOW,
    last_accessed: NOW,
    last_op_device: null,
    last_op_seq: null,
  };
}

async function seedCloudGroup(
  id: string,
  tabs: unknown[],
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const { encryptData } = await import('@/utils/encryptionUtils');
  cloud.rows.set(id, {
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
    tabs_data: await encryptData(tabs, USER_ID),
    ...overrides,
  } as CloudRow);
}

/** 一行**读不出来**的云端数据（形状坏 ⇒ 解密/解析失败 ⇒ 整组跳过）。 */
async function seedUnreadableCloudGroup(id: string): Promise<void> {
  cloud.rows.set(id, {
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
    // 坏形状：既不是合法密文也不是合法 JSON ⇒ 还原不出来 ⇒ 整组跳过。
    tabs_data: '{not json at all',
  } as CloudRow);
}

async function loadUploadModule() {
  const probe = await import('@/utils/supabase/probe');
  probe.__resetCloudColumnProbeCacheForTests();
  const { uploadSync } = await import('@/utils/supabase/upload');
  return { uploadTabGroups: uploadSync.uploadTabGroups };
}

before(async () => {
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
});

beforeEach(() => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  cloud.deleteOverreaches = false;
  cloud.readFails = false;
});

// ══════════════════════════════════════════════════════════════════════════
// 一、读不出来 + 本机无副本 ⇒ 那行云端行必须活下来
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖上传：云端读不出来、本机又没有副本的那几行，不得被删除', () => {
  it('那行云端行在覆盖上传后仍然存在（删了就是永久丢失）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    // 云端有两行：
    //   · g-unreadable —— 这台设备读不出来，且本机没有副本 ⇒ 必须活下来；
    //   · g-readable   —— 读得出来，且本机没有副本 ⇒ 照常被删（覆盖语义）。
    await seedUnreadableCloudGroup('g-unreadable');
    await seedCloudGroup('g-readable', [tabData('t1', 'https://a.example.com/')]);

    // 本机只有 g-local（与云端无关的一个会话）。
    await uploadTabGroups([mkGroup('g-local')], true);

    assert.ok(
      cloud.rows.has('g-unreadable'),
      '本机读不出来、又没有副本的云端行必须在覆盖上传后仍然存在（无回收站，删了就没了）'
    );
    assert.equal(
      cloud.rows.has('g-readable'),
      false,
      '读得出来的云端独有行照常被删（覆盖语义不能被削弱）'
    );
    assert.ok(
      cloud.rows.has('g-local'),
      '本机的会话必须照常写上云'
    );
  });

  it('被保住的那一行，一个字节都没被动过（仍是云端原来那份）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedUnreadableCloudGroup('g-unreadable');
    const before = JSON.stringify(cloud.rows.get('g-unreadable'));

    await uploadTabGroups([mkGroup('g-local')], true);

    assert.equal(
      JSON.stringify(cloud.rows.get('g-unreadable')),
      before,
      '被保住的云端行必须原样保留（没被删除、也没被覆盖）'
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // 「受保护集 ∩ 上行集 = ∅」这条不相交性（2026-10-20 复核补测）
  //
  // 为什么必须单独钉：core/overwriteUploadGuard.ts 的文件头把「不相交」写成
  // **前提**（受保护行若同时在上行集里，upsert 就把它变成 UPDATE，服务端两个
  // BEFORE UPDATE 守卫就会参与进来，可能把写**静默吞掉**）。
  //
  // 而这个前提的成立**依赖一个容易写错的细节**：传给 planOverwriteUpload 的
  // localIds 必须是「本机**全部**会话 id（活跃 **+ 墓碑**）」，而不是「活跃 id」。
  // 差一个字的写法：
  //   · 云端有一行 g-x，这台设备读不出来（坏形状）；
  //   · 本机有 g-x 的**墓碑**（用户在这台设备上删过它，但云端那份读不出来，
  //     所以删除意图没同步出去）；
  //   · 若 localIds 只含活跃组 ⇒ g-x 不在 local 集合里 ⇒ 被判成「本机没有副本」
  //     ⇒ **进保护集**；
  //   · 但 g-x 同时在**上行集**里（墓碑行也要上行，否则删除意图会丢）⇒
  //     upsert 把它变成 UPDATE ⇒ 守卫参与 ⇒ 可能静默吞写。
  // 两条后果都坏：要么云端那行被误改成墓碑（用户仅存的一份变成墓碑），
  // 要么写入被守卫吞掉（删除意图没上行）。
  // ────────────────────────────────────────────────────────────────────────
  it('本机有墓碑、且云端那一行读不出来时，那一行先删后写（两集合必须不相交）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    // 云端：g-tomb 这行读不出来（坏形状），且它在本机有一份墓碑。
    await seedUnreadableCloudGroup('g-tomb');
    // 本机：g-tomb 的墓碑（用户在这台设备上删过它）+ 一个普通会话。
    await uploadTabGroups(
      [mkGroup('g-tomb', { isDeleted: true }), mkGroup('g-local')],
      true
    );

    // g-tomb 既不该被判成「本机没有副本 ⇒ 受保护」（它在墓碑上行集里），
    // 也不该被这次覆盖上传改写（它是墓碑 ⇒ upsert 会写 is_deleted=true，
    // 那是对「云端仅存的那一份」做了一次 UPDATE —— 而那行读不出来，
    // upsert 会带着本机墓碑的内容去 UPDATE 它，服务端守卫就会参与）。
    const deletes = cloud.ops.filter(op => op.startsWith('DELETE:'));
    assert.ok(
      deletes.some(op => op.includes('g-tomb')),
      `g-tomb 必须先被删掉再写回（实得删除清单 ${JSON.stringify(deletes)}）—— ` +
        '本机有它的墓碑 ⇒ 它有副本 ⇒ 不受保护。' +
        '**判据是「删除+写回」这个顺序，不是「最终状态」**：' +
        '先删 ⇒ upsert 退化成 INSERT ⇒ 服务端两个 BEFORE UPDATE 守卫不参与；' +
        '若它被误判成「本机没有副本」而受保护，upsert 就变成 UPDATE，守卫就会参与，' +
        '可能把这行静默吞掉。最终云端那行仍是墓碑，但**到达那里的路径不同**。'
    );
  });

  it('云端的删除范围不含受保护的那一行（逐条看删除清单）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedUnreadableCloudGroup('g-unreadable');
    await seedCloudGroup('g-readable', [tabData('t1', 'https://a.example.com/')]);

    await uploadTabGroups([mkGroup('g-local')], true);

    const deletes = cloud.ops.filter(op => op.startsWith('DELETE:'));
    assert.ok(deletes.length > 0, '覆盖上传必须真的删过东西（否则本文件没验到东西）');
    for (const op of deletes) {
      assert.ok(
        !op.includes('g-unreadable'),
        `删除操作不得包含受保护的行（实得 ${op}）`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、其余场景：覆盖语义不被削弱
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖上传：其余场景的行为不被削弱', () => {
  it('读不出来、但**本机有副本**的那一行，照常被本机那份顶上去（是修复不是丢失）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    // 云端这行读不出来；本机有同 id 的会话 ⇒ 覆盖上传会用本机那份替换它。
    await seedUnreadableCloudGroup('g-shared');
    await uploadTabGroups([mkGroup('g-shared', { name: '本机那份' })], true);

    assert.ok(cloud.rows.has('g-shared'), '本机那份必须写上云');
    assert.equal(
      cloud.rows.get('g-shared')?.name,
      '本机那份',
      '云端那行必须被本机那份替换（读不出来的那份不该继续占着位置）'
    );
  });

  it('云端没有读不出来的行时，行为与修复前一致（一次性删掉全部云端行）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedCloudGroup('g-1', [tabData('t1', 'https://a.example.com/')]);
    await seedCloudGroup('g-2', [tabData('t2', 'https://b.example.com/')]);

    await uploadTabGroups([mkGroup('g-local')], true);

    assert.equal(cloud.rows.size, 1, '只剩本机写上去的那一行');
    assert.ok(cloud.rows.has('g-local'));
    const deletes = cloud.ops.filter(op => op.startsWith('DELETE:'));
    assert.equal(
      deletes.length,
      1,
      '没有需要保护的行时应当只发一次删除请求（保持修复前的请求形状）'
    );
  });

  it('合并模式（overwriteCloud=false）不删云端行，也不受本次修复影响', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedUnreadableCloudGroup('g-unreadable');
    await seedCloudGroup('g-readable', [tabData('t1', 'https://a.example.com/')]);

    await uploadTabGroups([mkGroup('g-local')], false);

    assert.ok(cloud.rows.has('g-unreadable'), '合并模式不删云端行');
    assert.ok(cloud.rows.has('g-readable'), '合并模式不删云端行');
    assert.equal(
      cloud.ops.filter(op => op.startsWith('DELETE:')).length,
      0,
      '合并模式不得发删除请求'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、读回校验：删除真的只删了该删的
// ══════════════════════════════════════════════════════════════════════════

describe('覆盖上传：删除多删了必须当场现形（不能报「上传成功」）', () => {
  it('服务端把受保护的那一行也删了 ⇒ 读回校验抛错（而不是静默成功）', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedUnreadableCloudGroup('g-unreadable');
    // 再放一行读得出来的：只有存在「要删的行」时才会真的发出删除请求。
    await seedCloudGroup('g-readable', [tabData('t1', 'https://a.example.com/')]);
    // 模拟服务端行为异常：删除时把过滤条件丢了 ⇒ 连受保护的那行也删掉。
    cloud.deleteOverreaches = true;

    await assert.rejects(
      () => uploadTabGroups([mkGroup('g-local')], true),
      /缺失/,
      '受保护的云端行不见了 ⇒ 必须抛错（写完不算成功，见 verifyProtectedRowsStillExist）'
    );
  });

  it('读云端失败（探测读不出来）⇒ 整次覆盖上传中止，且**一个字节都没删**', async () => {
    const { uploadTabGroups } = await loadUploadModule();

    await seedUnreadableCloudGroup('g-unreadable');
    await seedCloudGroup('g-readable', [tabData('t1', 'https://a.example.com/')]);
    cloud.readFails = true;

    await assert.rejects(
      () => uploadTabGroups([mkGroup('g-local')], true),
      '探测读不出来 ⇒ 必须中止（fail-closed：读不出来不等于没有要保护的行）'
    );

    assert.equal(
      cloud.ops.filter(op => op.startsWith('DELETE:')).length,
      0,
      '探测失败时不得发出任何删除请求（那是不可逆的全量删除）'
    );
    assert.ok(
      cloud.rows.has('g-unreadable'),
      '探测失败时云端那几行必须原样保留'
    );
  });
});
