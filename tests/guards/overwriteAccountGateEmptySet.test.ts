/**
 * 覆盖上传遇���「账号闸门放行 0 个」时，**绝不删云端**（2026-10-23 回归审计 **R-1** · P0）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 *
 * 覆盖上传（overwriteCloud）的语义是「云端完全以本机为准」：先 DELETE 掉
 * **当前账号**的云端全部行，再把本机的写回去。
 *
 * 而**上行集合**是过完**账号闸门**（`filterGroupsByAccount`）之后的那一批。
 * 换过账号之后（本机的会话都属于上一个账号），闸门**放行 0 个** ⇒
 *
 *   旧行为 = DELETE 照做、upsert 写 0 行
 *          ⇒ **当前账号的云端被整个删空**，而界面上报的是「上传成功」。
 *          （实测：云端操作序列 = `['DELETE:b-1,b-2,b-3']`，云端剩余行 = `[]`。）
 *
 * 两句话是**两处**撒谎：数据没了（纯数据丢失，v1.22.0 起无回收站、不可逆），
 * 而用户看到的是「成功」。
 *
 * ── 本守卫盯的三件事（都是**行为**，不是字面量）──────────────────────────
 *
 * ① **写入层**：闸门放行 0 个时，云端**一个字节都不许动**（没有 DELETE）。
 * ② **诚实层**：跳过必须**被报上来**（`overwriteSkipped`），一路传到
 *    `syncEngine` 的 `skippedOverwrite` ⇒ 界面不说「已覆盖云端」。
 * ③ **自证检测力**：同一段代码、同一套假云端，只把归属改一下（让闸门放行 1 个）
 *    ⇒ 覆盖**照常发生**（DELETE 出现）⇒ 说明 ① 的断言看得见「删了」这件事。
 *
 * ── 为什么判据落在**这一层**（真正写云端的那一层）────────────────────────
 * 上传有 4 条路径（手动 SYNC / 快路径 / 后台轮询 / alarm 兜底），全都汇到
 * `utils/supabase/upload.ts` 的 `uploadTabGroups`；放在调用方 ⇒ 漏一条路径就
 * 漏一次。引擎那层已有的「空本地保护」按**全部本地活跃组**判，看不见
 * 「闸门放行 0 个」这一档（闸门在更下面）⇒ 引擎挡不住这个洞。
 *
 * ── 自证检测力（写在用例注释里）────────────────────────────────────────
 * ① 摘掉写入层的跳过 ⇒ 用例 ① 红（云端被删空）。
 * ② 跳过但不回报 ⇒ 用例 ② 红（界面会说「已覆盖云端」）。
 * ③ 把闸门放行判据改坏（恒放行）⇒ 用例 ① 也红（越权写）。
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from '../_helpers/stubSession.ts';
import { skippedOverwriteNotice } from '@/components/sync/skippedOverwriteNotice';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

/** 当前登录的账号（B）。 */
const USER_B = 'user-r43-overwrite-b';
/** 这台机器上会话的真正主人（A）—— 换账号之前登录的那个。 */
const USER_A = 'user-r43-overwrite-a';
const SESSION_KEY = 'sb-stub-auth-token';
const NOW = '2026-10-23T08:00:00.000Z';
const DEVICE_ID = 'devLocal';

// ══════════════════════════════════════════════════════════════════════════
// 装置：本地存储桩 + 假云端（PostgREST 子集）
// ══════════════════════════════════════════════════════════════════════════

const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() { return lsData.size; },
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

interface CloudRow {
  id: string;
  user_id: string;
  is_deleted?: boolean;
  last_op_device?: string | null;
  last_op_seq?: number | null;
  [k: string]: unknown;
}

const cloud = {
  rows: new Map<string, CloudRow>(),
  /** 按发生顺序记录写操作（用于断言删除范围）。 */
  ops: [] as string[],
};

function jsonRes(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method ?? 'GET').toUpperCase();
  const params = url.searchParams;

  if (url.pathname.endsWith('/auth/v1/user')) {
    return jsonRes({ id: USER_B, aud: 'authenticated', role: 'authenticated' });
  }
  if (!url.pathname.endsWith('/rest/v1/tab_groups')) return jsonRes({ message: 'not found' }, 404);

  if (method === 'GET') {
    const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
    const hit = [...cloud.rows.values()].filter(r => matches(r, params));
    return jsonRes(hit.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))));
  }
  if (method === 'DELETE') {
    const deleted: string[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      cloud.rows.delete(id);
      deleted.push(id);
    }
    cloud.ops.push(`DELETE:${deleted.sort().join(',')}`);
    return jsonRes([]);
  }
  if (method === 'POST') {
    const body = init.body ? JSON.parse(String(init.body)) : [];
    const list: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
    for (const row of list) {
      cloud.rows.set(String(row.id), {
        id: String(row.id),
        user_id: String(row.user_id ?? ''),
        ...row,
      });
    }
    cloud.ops.push(`UPSERT:${list.map(r => String(r.id)).sort().join(',')}`);
    return jsonRes(list);
  }
  if (method === 'PATCH') {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const touched: Record<string, unknown>[] = [];
    for (const [id, row] of [...cloud.rows.entries()]) {
      if (!matches(row, params)) continue;
      const next = { ...row, ...body };
      cloud.rows.set(id, next);
      touched.push(next);
    }
    cloud.ops.push(`PATCH:${touched.map(t => String(t.id)).sort().join(',')}`);
    return jsonRes(touched);
  }
  return jsonRes({ message: `假云端不认识的请求: ${method}` }, 405);
}) as typeof fetch;

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

/** 云端属于**当前账号**（B）的两行活数据 —— 覆盖上传若发生，它们会被删光。 */
function seedCloudForB(ids: string[]): void {
  for (const id of ids) {
    cloud.rows.set(id, {
      id,
      user_id: USER_B,
      is_deleted: false,
      last_op_device: 'otherDevice',
      last_op_seq: 4,
    });
  }
}

before(async () => {
  await register(LOADER_PATH);
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set(SESSION_KEY, stubSessionJson(USER_B));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_B));
  lsData.set('tabvaultpro_device_id', JSON.stringify(DEVICE_ID));
});

beforeEach(async () => {
  cloud.rows.clear();
  cloud.ops.length = 0;
  const { storage, invalidateGroupsCache } = await import('@/utils/storage');
  invalidateGroupsCache();
  await storage.setGroupsImmediate([]);
  invalidateGroupsCache();
  chromeData.delete('local_account_scope');
});

after(() => {
  // 归属记录是**本机状态** ⇒ 测试之间必须清干净，否则会串味。
  chromeData.delete('local_account_scope');
});

// ══════════════════════════════════════════════════════════════════════════
// 一、写入层：闸门放行 0 个 ⇒ 云端一个字节都不许动
// ══════════════════════════════════════════════════════════════════════════

describe('R-1 覆盖上传：账号闸门放行 0 个 ⇒ 云端不许被删', () => {
  it('本机会话都属于上一个账号时，覆盖被跳过，云端原封不动', async () => {
    // 归属记录：本机这批会话归 A；当前登录的是 B。
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_A,
      foreignOwners: {},
      pendingNotice: null,
    });
    seedCloudForB(['g-b1', 'g-b2', 'g-b3']);

    const { uploadSync } = await import('@/utils/supabase/upload');
    const localGroups = [mkGroup('g-a1'), mkGroup('g-a2')];
    const res = await uploadSync.uploadTabGroups(localGroups, true);

    // ① 云端数据一个字节都没动。
    assert.deepEqual(
      [...cloud.rows.keys()].sort(),
      ['g-b1', 'g-b2', 'g-b3'],
      '当前账号的云端被删空了 —— 覆盖上传在「什么都不会写」的时候照样执行了 DELETE'
    );
    assert.deepEqual(
      cloud.ops.filter(op => op.startsWith('DELETE')),
      [],
      `云端不该收到任何 DELETE：${cloud.ops.join(' | ')}`
    );

    // ② 如实回报「覆盖没发生」，而不是让上层以为覆盖过了。
    assert.equal(
      res.overwriteSkipped,
      'no-account-groups',
      '跳过必须被报上来（否则界面会说「已覆盖云端」）'
    );
    // ③ 属于别的账号的那批被回报为「被挡下」（上层对账要靠它）。
    assert.deepEqual(
      [...(res.blockedAccountIds ?? [])].sort(),
      ['g-a1', 'g-a2'],
      '被账号闸门挡下的会话必须回报给调用方（否则对账会把它们当成已提交）'
    );
  });

  it('自证检测力：闸门放行 1 个时，覆盖照常发生（说明上面那条断言看得见「删了」）', async () => {
    // 同样的装置，只把归属改一下：g-a1 归 A（被挡），g-b9 归 B（放行）。
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_B,
      foreignOwners: { 'g-a1': USER_A },
      pendingNotice: null,
    });
    seedCloudForB(['g-b1', 'g-b2']);

    const { uploadSync } = await import('@/utils/supabase/upload');
    const res = await uploadSync.uploadTabGroups(
      [mkGroup('g-a1'), mkGroup('g-b9', { lastOp: { d: DEVICE_ID, s: 7 } })],
      true
    );

    // 正控：覆盖**真的**发生了 ⇒ 云端被 DELETE 过 ⇒ ① 的断言不是空转的。
    assert.ok(
      cloud.ops.some(op => op.startsWith('DELETE')),
      '正控失��：闸门放行时覆盖必须照常执行（否则上面那条断言没有检测力）'
    );
    assert.equal(
      res.overwriteSkipped,
      undefined,
      '覆盖真的发生了 ⇒ 不得报告「跳过」'
    );
  });

  it('本机一个会话都没有时，理由是「空本地」而不是「换账号」', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_B,
      foreignOwners: {},
      pendingNotice: null,
    });
    seedCloudForB(['g-b1']);

    const { uploadSync } = await import('@/utils/supabase/upload');
    const res = await uploadSync.uploadTabGroups([], true);

    assert.equal(
      res.overwriteSkipped,
      'no-active-groups',
      '本机压根没会话 ⇒ 理由是空本地保护（用户该知道是「没东西可传」而不是「换账号了」）'
    );
    assert.deepEqual(
      [...cloud.rows.keys()],
      ['g-b1'],
      '空本地时也不许清空云端'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、诚实层：跳过必须一路传到界面，且界面不能说「成功」
// ══════════════════════════════════════════════════════════════════════════

describe('R-1 覆盖被跳过：必须被如实上报（不许谎报成功）', () => {
  it('引擎把后端报的「覆盖被跳过」透传给上层', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_A,
      foreignOwners: {},
      pendingNotice: null,
    });
    seedCloudForB(['g-b1', 'g-b2']);

    // 本机留一个属于 A 的会话 ⇒ 引擎的「空本地保护」不触发（本地**有**活跃组），
    // 真正挡住覆盖的只有账号闸门 ⇒ 正好复现 R-1 的原始场景。
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    invalidateGroupsCache();
    await storage.setGroupsImmediate([mkGroup('g-a1', { lastOp: { d: DEVICE_ID, s: 3 } })]);
    invalidateGroupsCache();

    const { syncEngine } = await import('@/services/syncEngine');
    const res = await syncEngine.upload({
      overwriteCloud: true,
      syncSettings: false,
      forcePending: true,
    });

    assert.equal(
      res.skippedOverwrite,
      'no-account-groups',
      '引擎必须把「覆盖被跳过」报给界面（否则界面报「上传成功」，而云端被删空了）'
    );
    assert.deepEqual(
      [...cloud.rows.keys()].sort(),
      ['g-b1', 'g-b2'],
      '引擎这一层跑完，云端仍然原封不动'
    );
  });

  it('界面文案：两种跳过理由各有一句实话，且都不说「成功」', () => {
    const account = skippedOverwriteNotice('no-account-groups');
    assert.ok(account, '换账号导致的跳过必须有话可说');
    assert.match(account!.text, /跳过/, '文案必须说清「没覆盖」');
    assert.match(account!.text, /云端数据保持不变/, '文案必须说清「云端没被动过」');
    assert.equal(account!.level, 'warning', '换账号是用户需要知道的情况 ⇒ 级别是 warning');

    const empty = skippedOverwriteNotice('no-active-groups');
    assert.ok(empty, '空本地导致的跳过必须有话可说');
    assert.match(empty!.text, /云端数据保持不变/);

    assert.equal(
      skippedOverwriteNotice(undefined),
      null,
      '没有跳过 ⇒ 一个字都不多说（弹一句「0 个会话」是纯噪音）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、界面层：两处消费点必须走**同一份**文案（不许各写一份）
// ══════════════════════════════════════════════════════════════════════════
//
// 【为什么要盯这一层】引擎报上来了「覆盖被跳过」，如果界面不接，用户看到的
// 仍然是「上传成功」。而接的方式有两种：走共享函数（对），或各写一句
// （改一处忘一处 ⇒ 用户在 A 处看到「云端保持不变」、在 B 处看到「已同步」）。
//
// 判据钉的是**「同一份声明只有一个版本」**这个不变量，不是某句文案：
// 「云端数据保持不变」这句话只允许出现在 skippedOverwriteNotice.ts 里。

describe('R-1 界面层：跳过的说法只有一份（两个消费点都走它）', () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
  const SYNC_BUTTON = 'src/components/sync/SyncButton.tsx';
  const DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';
  const NOTICE = 'src/components/sync/skippedOverwriteNotice.ts';

  it('顶栏同步按钮用共享函数产出提示（不是自己写死一句）', () => {
    const source = read(SYNC_BUTTON);
    assert.match(
      source,
      /skippedOverwriteNotice\(\s*payload\?\.skippedOverwrite\s*\)/,
      '顶栏的提示必须由 skippedOverwriteNotice 产出（且读的是后端报上来的那个理由）'
    );
    assert.ok(
      !source.includes('本地没有活跃会话，覆盖上传已跳过'),
      '顶栏还留着旧的内联文案 ⇒ 同一份声明有两个版本'
    );
  });

  it('菜单里的「删光后补覆盖」也走同一份', () => {
    const source = read(DROPDOWN);
    assert.match(
      source,
      /skippedOverwriteNotice\(\s*res\.payload\.skippedOverwrite\s*\)/,
      '菜单里的补覆盖必须用同一份文案（否则两处说法会分叉）'
    );
  });

  it('「云端数据保持不变」这句话只允许出现在那一个文件里', () => {
    // 去掉注释再找：注释里**提到**这句话不算「写了一份」（否则下次有人补一句
    // 注释就要改测试 —— 那是「守卫钉死字面量 ⇒ 改对了实现反而红」的老毛病）。
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const offenders = [SYNC_BUTTON, DROPDOWN].filter(f =>
      stripComments(read(f)).includes('云端数据保持不变')
    );
    assert.deepEqual(
      offenders,
      [],
      `这几个文件各自写了一份跳过文案：${offenders.join('、')}。同一份声明只能有一个版本。`
    );
    assert.ok(
      read(NOTICE).includes('云端数据保持不变'),
      '共享文案模块里必须有这句话（否则上面两条只是在钉「没人写」）'
    );
  });
});
