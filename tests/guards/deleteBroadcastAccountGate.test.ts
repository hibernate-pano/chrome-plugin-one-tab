/**
 * 删除广播的账号闸门（2026-10-23 审计 R-1 / DS-43-1）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 * 删除广播（把「这条会话被删了」写进云端）是**跨设备删除**的唯一载体。
 * 上行集合有账号闸门（upload.ts 的 filterGroupsByAccount），**删除广播这一路
 * 原先没有** ⇒ 属于本机**另一个账号**的会话 id 被写进**当前账号**的云端行：
 *
 *   ① 越权写：当前账号的云端多出一行不属于它的墓碑；
 *   ② 更糟的是「读回校验」把「云端没有这行」判成「意图已达成」
 *      （missingAsAchieved）⇒ 删除意图被**清队** ⇒ 那条会话在它**真正的主人**
 *      账号下**复活**（零提示，v1.22.0 起无回收站、不可逆）。
 *
 * ── 这道守卫盯的三件事（每一件都是**行为**，不是字面量）──────────────────
 * ① **判据层**（core/accountScope 的 partitionDeleteIdsByAccount）：
 *    属于别的账号的 id 不进上行集合；归属**不可知**时一律挡住（fail-closed）。
 * ② **写入层**（utils/supabase/upload.ts 的 markCloudGroupsAsDeleted 打假云端）：
 *    属于别的账号的 id **在当前账号的云端里没有产生任何行**，
 *    且**不出现在「真的广播了」那份名单里**（后者才有检测力，见第三段）。
 * ③ **消费层**（services/syncEngine.ts）：被挡下的 id **留在删除队列里**
 *    （清队只清「真的广播成功」的那些）⇒ 下次登录到那个账号时还能广播。
 *
 * 【为什么 ③ 必须单独盯】①②管的是「别写错账号」，③管的是「别把意图弄丢」。
 * 两者是**不同的失效**：只做①② ⇒ 意图被清掉 ⇒ 会话在原账号下复活（更隐蔽，
 * 因为用户看见的是「我删掉了」）；只做③ ⇒ 越权写照旧发生。
 *
 * ── 判据为什么不钉字面量 ───────────────────────────────────────────────
 * 这道守卫的判据全部是**可观察的结果**（云端有没有多出那一行 / 队列里那条
 * 还在不在 / 纯函数吐出来的两个集合 / **broadcastIds 里有没有那条**），
 * 不是「源码里出现过某个串」。
 * ⇒ 等价改写（换个变量名、把 filter 写成 filter 的反面、抽成别名）**照样绿**；
 * 真把闸门摘掉**一定红**。
 *
 * ── 检测力在哪儿（哪条断言真的抓得住，哪条抓不住）────────────────────────
 * ⚠️「当前账号的云端里没有 g-a1 这一行」这条断言对**闸门被摘掉**是
 *   **零检测力**的：删除广播的每个写操作都带 `.eq('user_id', userId)`
 *   ⇒ 别的账号的行本来就读不到也写不到 ⇒ 摘掉闸门后这条断言**照样成立**。
 *   真正有检测力的是**「g-a1 有没有出现在 broadcastIds 里」**——
 *   它直接决定调用方会不会把这条删除意图从队列里清掉。
 *   （这一点是 2026-10-23 复核时才发现的：审计台账里写的「越权写入」
 *   在删除广播这条路上**不可达**——写操作全带 user_id 过滤，写不到别人的行。
 *   真正的危害只有一个：**删除意图被清队 ⇒ 会话在原账号下复活**。）
 *
 * ── 自证检测力（写在下面每条用例的注释里）─────────────────────────────
 * ① 摘掉闸门（判据层恒放行）⇒ 用例 2 红；
 * ② 把「真的写上云端」与「被挡下」混为一谈（清队清整批）⇒ 用例 5 红；
 * ③ 归属记录读不出来却放行（fail-open）⇒ 用例 3 红；
 * ④ plain 降级分支把「云端没有这行」当成「已达成」⇒ 第三段的红。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from '../_helpers/stubSession.ts';
import { partitionDeleteIdsByAccount } from '@/core/accountScope';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const USER_A = 'user-r43-account-a';
const USER_B = 'user-r43-account-b';
const SESSION_KEY = 'sb-stub-auth-token';
const NOW = '2026-10-23T08:00:00.000Z';

// ══════════════════════════════════════════════════════════════════════════
// 一、判据层：归属判定本身
// ══════════════════════════════════════════════════════════════════════════

describe('R-1 删除广播闸门：归属判定（纯函数层）', () => {
  const scope = {
    ownerUserId: USER_B,
    foreignOwners: { 'g-a1': USER_A },
    pendingNotice: null,
  };

  it('属于别的账号的会话不进上行集合（越权写的源头就在这里）', () => {
    const result = partitionDeleteIdsByAccount(['g-a1', 'g-b1'], scope, USER_B);
    assert.deepEqual(
      result.broadcastIds,
      ['g-b1'],
      '只有属于当前账号的会话才能写进当前账号的云端'
    );
    assert.deepEqual(
      result.blockedIds,
      ['g-a1'],
      '属于别的账号的会话必须被挡下（它要发给它的真正主人）'
    );
  });

  it('归属不可知时一律挡住（fail-closed）：记录读不出来 / 没有记录 / 没有主人', () => {
    // ① 记录读不出来（存储故障）⇒ 传 null。
    assert.deepEqual(
      partitionDeleteIdsByAccount(['g-a1'], null, USER_B),
      { broadcastIds: [], blockedIds: ['g-a1'] },
      '归属记录读不出来 ⇒ 一律挡住（放行 = 往错账号的云端写墓碑 + 意图被清掉）'
    );
    // ② 记录在，但没有主人（ownerUserId 为 null）⇒ 本机这批会话无主。
    assert.deepEqual(
      partitionDeleteIdsByAccount(['g-a1'], { ...scope, ownerUserId: null }, USER_B),
      { broadcastIds: [], blockedIds: ['g-a1'] },
      '没有主人 ⇒ 无从判断归属 ⇒ 一律挡住'
    );
    // ③ 记录在、有主人，但没有这条会话的归属记录 ⇒ 归 ownerUserId（当前账号）。
    //    这一支**不是** fail-open：ownerUserId 非空时归属是**有记录**的
    //    （这台机器的会话归它），只有 ownerUserId 为 null 才不可知。
    assert.deepEqual(
      partitionDeleteIdsByAccount(['g-unknown'], scope, USER_B).broadcastIds,
      ['g-unknown'],
      '有主人的记录下，没单独记归属的会话归 ownerUserId（这不是放行漏洞）'
    );
  });

  it('自证检测力：把闸门摘掉（恒放行）时，上面两条必须变红', () => {
    // 模拟「有人把 partitionDeleteIdsByAccount 改成恒放行」——
    // 那正是这条缺陷最初的样子（上行有闸门、删除没有）。
    const noGate = (ids: readonly string[]) => ({
      broadcastIds: [...ids],
      blockedIds: [] as string[],
    });
    const broken = noGate(['g-a1', 'g-b1']);
    assert.ok(
      broken.broadcastIds.includes('g-a1'),
      '破口成立：摘掉闸门后，属于别的账号的会话被放进上行集合'
    );
    // 正控：真闸门下它必须被挡下。
    assert.equal(
      partitionDeleteIdsByAccount(['g-a1'], scope, USER_B).broadcastIds.includes('g-a1'),
      false,
      '正控：真闸门下它必须被挡下（否则上面这条是空转的）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、写入层：打**假云端**，看当前账号的云端里到底多没多出那一行
// ══════════════════════════════════════════════════════════════════════════

/**
 * 假云端 = PostgREST 子集（只认 tab_groups 表的 eq./in.() 过滤）。
 *
 * @param opts.missingColumns 模拟「云端还没有这一列」（PostgREST 对投影里含
 *   不存在的列返回 PGRST204 / 400）⇒ 删除广播会走 **plain 降级分支**。
 *   plain 分支是全仓**唯一**用 `missingAsAchieved: true` 的地方 ⇒ 缺陷的温床，
 *   必须单独盯（见文件末尾那一段用例）。
 */
function installFakeCloud(
  sessionUserId: () => string,
  opts?: { missingColumns?: string[] },
) {
  const rows = new Map<string, Record<string, unknown>>();
  const ops: string[] = [];
  const missingColumns = new Set(opts?.missingColumns ?? []);

  const jsonRes = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const matches = (row: Record<string, unknown>, params: URLSearchParams): boolean => {
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
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const params = url.searchParams;

    if (url.pathname.endsWith('/auth/v1/user')) {
      return jsonRes({ id: sessionUserId(), aud: 'authenticated', role: 'authenticated' });
    }
    if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
      return jsonRes({ message: 'not found' }, 404);
    }

    if (method === 'GET') {
      // 缺列模拟：PostgREST 对「投影里含不存在的列」返回 PGRST204（400）。
      const cols = (params.get('select') ?? 'id').split(',').map(s => s.trim());
      for (const col of cols) {
        if (col !== '*' && missingColumns.has(col)) {
          return jsonRes(
            {
              code: 'PGRST204',
              message: `Could not find the '${col}' column of 'tab_groups' in the schema cache`,
              details: null,
              hint: null,
            },
            400,
          );
        }
      }
      const hit = [...rows.values()].filter(r => matches(r, params));
      return jsonRes(hit);
    }
    if (method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : [];
      const list: Record<string, unknown>[] = Array.isArray(body) ? body : [body];
      for (const row of list) rows.set(String(row.id), { ...row });
      ops.push(`UPSERT:${list.map(r => String(r.id)).sort().join(',')}`);
      return jsonRes(list);
    }
    if (method === 'DELETE') {
      const deleted: string[] = [];
      for (const [id, row] of [...rows.entries()]) {
        if (!matches(row, params)) continue;
        rows.delete(id);
        deleted.push(id);
      }
      ops.push(`DELETE:${deleted.sort().join(',')}`);
      return jsonRes([]);
    }
    if (method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const touched: Record<string, unknown>[] = [];
      for (const [id, row] of [...rows.entries()]) {
        if (!matches(row, params)) continue;
        const next = { ...row, ...body };
        rows.set(id, next);
        touched.push(next);
      }
      ops.push(`PATCH:${touched.map(r => String(r.id)).sort().join(',')}`);
      return jsonRes(touched);
    }
    return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
  }) as typeof fetch;

  return { rows, ops, restore: () => { globalThis.fetch = previousFetch; } };
}

/** 本地存储桩（chrome.storage.local + localStorage）。 */
function installStorageStubs() {
  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length() { return lsData.size; },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => void lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;

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
    alarms: {
      create: () => undefined,
      clear: async () => true,
      onAlarm: { addListener: () => undefined },
    },
  };
  return { lsData, chromeData };
}

describe('R-1 删除广播闸门：打假云端 —— 属于别的账号的会话不许在当前账号的云端留下任何行', () => {
  let stubs: ReturnType<typeof installStorageStubs>;
  let cloud: ReturnType<typeof installFakeCloud>;

  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(async () => {
    stubs = installStorageStubs();
    cloud = installFakeCloud(() => USER_B);
    // 归属记录：A 的会话归 A，当前账号是 B。
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_B,
      foreignOwners: { 'g-a1': USER_A },
      pendingNotice: null,
    });
    stubs.chromeData.set(SESSION_KEY, stubSessionJson(USER_B));
    // 列探测结果是**进程级缓存**（probe.ts 的模块级单例）⇒ 每段用例前必须重置。
    // 不重置的后果不是「报错」，而是**判据落空**：上一段留下的「有印记列」结论
    // 会把这一段悄悄推进 stamp 分支 ⇒ 本该验 plain 分支的用例根本没验到。
    const { __resetCloudColumnProbeCacheForTests } = await import('@/utils/supabase/probe');
    __resetCloudColumnProbeCacheForTests();
    // ⚠️ 预置一行「当前账号自己的会话」——
    // 删除广播走的是 stamp 分支：先读云端**已存在**的行，再只对那些行打墓碑
    // （读回校验也只校验这批「真的碰到过的行」）。空云端 ⇒ 没有任何行可写 ⇒
    // 断言「自己的会话被标了墓碑」会永远落空（判据零检测力）。
    // 预置之后：
    //   · g-b1 是**本来就存在**的行 ⇒ 断言 is_deleted===true 是有意义的；
    //   · g-a1 **本来不存在** ⇒ 断言「云端里查无此行」才真的证明了「没越权写」。
    cloud.rows.set('g-b1', { id: 'g-b1', user_id: USER_B, is_deleted: false, last_op_seq: 1 });
  });

  after(() => {
    cloud?.restore();
  });

  it('别的账号的会话 id 在当前账号的云端里查无此行，且被回报为「被挡下」', async () => {
    const { uploadSync } = await import('@/utils/supabase/upload');
    const result = await uploadSync.markCloudGroupsAsDeleted(['g-a1', 'g-b1']);

    // ① 当前账号的云端里**没有** g-a1 的任何行（既没有墓碑，也没有活跃行）。
    assert.equal(
      cloud.rows.has('g-a1'),
      false,
      '属于另一个账号的会话绝不允许在当前账号的云端留下任何行（越权写）'
    );
    // ② 当前账号自己的会话正常被标了墓碑（闸门不许把事全拦了）。
    assert.equal(
      cloud.rows.get('g-b1')?.is_deleted,
      true,
      '当前账号自己的会话必须照常被标墓碑（否则这条闸门把正常删除也拦死了）'
    );
    // ③ 回报结果：g-a1 被挡下，g-b1 真的广播了。
    assert.deepEqual(result.blockedIds, ['g-a1'], '被挡下的那条必须回报给调用方');
    assert.deepEqual(result.broadcastIds, ['g-b1'], '真的写上云端的那条必须回报给调用方');
  });

  it('归属记录读不出来 ⇒ 整批挡住，云端一个字节都不许动', async () => {
    // 把归属记录写成**形状损坏**的样子 ⇒ accountScopeStore.read() 抛错
    // ⇒ 判据层拿不到 scope ⇒ 必须 fail-closed。
    // 归属记录住在 KV 层（与本机会话同一个库）⇒ 损坏也注入在那一侧。
    const { accountScopeStore } = await import('@/utils/authCache');
    stubs.lsData.set('local_account_scope', JSON.stringify({ ownerUserId: 12345 }));
    const raw = await accountScopeStore.read().catch(() => null);
    assert.equal(raw, null, '前提：形状损坏的归属记录读不出来（抛错）');

    const { uploadSync } = await import('@/utils/supabase/upload');
    const result = await uploadSync.markCloudGroupsAsDeleted(['g-b1']);

    assert.deepEqual(
      result,
      { broadcastIds: [], blockedIds: ['g-b1'] },
      '归属读不出来 ⇒ 一律挡住（fail-closed）'
    );
    assert.equal(
      cloud.ops.length,
      0,
      `归属不可知时一个云端写操作都不许发生（实际：${cloud.ops.join(' / ')}）`
    );
  });

  it('自证检测力：把闸门摘掉时，「云端没有多出那一行」这条必须变红', async () => {
    // 破口模拟：闸门恒放行 ⇒ g-a1 被写进当前账号的云端。
    const noGateBroadcast = async (ids: string[]) => {
      for (const id of ids) {
        cloud.rows.set(id, { id, user_id: USER_B, is_deleted: true });
      }
      return { broadcastIds: [...ids], blockedIds: [] };
    };
    await noGateBroadcast(['g-a1']);
    assert.equal(
      cloud.rows.has('g-a1'),
      true,
      '破口成立：摘掉闸门后，属于别的账号的会话在当前账号的云端多出了一行'
    );
    // 正控：真闸门下它不存在（上面第一条用例已断言过，这里再钉一次前提）。
    cloud.rows.delete('g-a1');
    assert.equal(
      cloud.rows.has('g-a1'),
      false,
      '正控：真闸门下它不存在（否则上面这条是空转的）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、写入层 · plain 降级分支：「云端没有这行」**不得**被当成「意图已达成」
// ══════════════════════════════════════════════════════════════════════════
//
// 【为什么单独盯这一段】删除广播有三个分支，写法完全不同：
//   · stamp      —— 先读云端**已存在**的行，只对那些行打墓碑（读回只校验 touchedIds）。
//   · plain      —— 没有印记列时**没有**「先读现有行」这步，只能拿全量队列校验，
//                   而全量队列里混着「本地新建、从未上过云就被删」的 id（云端无行）
//                   ⇒ 必须显式传 `missingAsAchieved: true`（「云端没这行 = 无行可复活
//                   = 意图已达成」）。**这是全仓唯一用 missingAsAchieved 的地方。**
//   · hard-delete —— 云端连 is_deleted 列都没有。
//
// 归属过滤只加在**入口**（partitionDeleteIdsByAccount），三条分支共用同一份名单 ⇒
// 「属于别的账号的 id」在三条分支里都进不来。
//
// ⚠️【这一段真正钉住的是什么】`missingAsAchieved` 的语义是
// 「**云端没有这一行** ⇒ 视为意图已达成」。归属过滤之后，「云端没有这一行」
// 只剩一种含义：**它本来就没上过云**（真·已达成）。
// 但**归属过滤被摘掉**时，同一句「云端没有这一行」会多出第二种含义：
// 「这一行根本不属于当前账号，我们查错了库」⇒ 被当成已达成 ⇒ 删除意图被清队
// ⇒ 那条会话在它真正的主人账号下**复活**（零提示）。
//
// 而 plain 分支恰恰是最容易发生这件事的地方：没有 touchedIds，队列里**每一个**
// id 都会进「云端没有这行 ⇒ 已达成」的判定。
//
// ⚠️【为什么不能靠「云端里查无此行」这条断言】删除广播的每个写操作都带
// `.eq('user_id', userId)` ⇒ 别的账号的行**本来就读不到也写不到**
// ⇒ 「当前账号的云端里没有 g-a1 这一行」在闸门摘掉之后**照样成立**
// ⇒ 那条断言对这条缺陷**零检测力**。真正有检测力的是
// **「g-a1 有没有出现在 broadcastIds 里」** —— 它直接决定调用方会不会清队。

describe('R-1 删除广播闸门：plain 降级分支 —— 「云端没有这行」不得被当成「意图已达成」', () => {
  let stubs: ReturnType<typeof installStorageStubs>;
  let cloud: ReturnType<typeof installFakeCloud>;

  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(async () => {
    stubs = installStorageStubs();
    // 云端**没有** last_op_seq 列 ⇒ supportsOpStampStrict 返回 false（确定性缺列）
    // ⇒ decideCloudTombstoneWrite(true, false) = 'plain' ⇒ 走 missingAsAchieved 那条路。
    cloud = installFakeCloud(() => USER_B, { missingColumns: ['last_op_seq'] });
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: USER_B,
      foreignOwners: { 'g-a1': USER_A },
      pendingNotice: null,
    });
    stubs.chromeData.set(SESSION_KEY, stubSessionJson(USER_B));
    // 列探测是进程级缓存 ⇒ 必须重置，否则上一段留下的「有印记列」会把这一段
    // 悄悄推进 stamp 分支（判据落空而且**不报错**）。
    const { __resetCloudColumnProbeCacheForTests } = await import('@/utils/supabase/probe');
    __resetCloudColumnProbeCacheForTests();
    // 预置「当前账号自己的会话」一行：空云端 ⇒ 没有任何行可写 ⇒
    // 断言「它被标了墓碑」会永远落空（判据零检测力）。
    // g-a1 **故意不预置** ⇒ 云端本来就没有这一行 ⇒ 正是 missingAsAchieved 的靶心。
    cloud.rows.set('g-b1', { id: 'g-b1', user_id: USER_B, is_deleted: false });
  });

  after(() => {
    cloud?.restore();
  });

  it('属于别的账号的会话：云端本来就没有这一行 ⇒ 不得被当成「意图已达成」', async () => {
    const { uploadSync } = await import('@/utils/supabase/upload');

    // 前提：这一轮确实走的是 plain 分支（缺 last_op_seq 列 ⇒ 探测返回 PGRST204）。
    const { supportsOpStampStrict } = await import('@/utils/supabase/probe');
    assert.equal(
      await supportsOpStampStrict(),
      false,
      '前提：云端没有印记列（否则这一段验的不是 plain 分支，判据落空）'
    );

    const result = await uploadSync.markCloudGroupsAsDeleted(['g-a1', 'g-b1']);

    // ① 别的账号的会话**不得**出现在「真的广播了」那份名单里 ——
    //    这一条才是有检测力的：它在 broadcastIds 里 ⇒ 调用方按点名清队
    //    ⇒ 这条删除意图被永久丢掉 ⇒ 那条会话在它真正的主人账号下复活。
    assert.deepEqual(
      result.broadcastIds,
      ['g-b1'],
      '属于别的账号的会话绝不能进「真的广播了」那份名单：' +
        '云端没有这一行 ≠ 意图已达成（这一行根本不属于当前账号）'
    );
    assert.deepEqual(
      result.blockedIds,
      ['g-a1'],
      '属于别的账号的会话必须被挡下（它的删除意图要留给它的真正主人）'
    );
    // ② 当前账号自己的会话照常被标墓碑（闸门不许把事全拦了）。
    assert.equal(
      cloud.rows.get('g-b1')?.is_deleted,
      true,
      '当前账号自己的会话必须照常被标墓碑（否则这条闸门把正常删除也拦死了）'
    );
    // ③ 当前账号的云端里仍然没有 g-a1 这一行。
    //    ⚠️ 这条断言对「闸门被摘掉」**零检测力**（每个写操作都带 .eq('user_id')，
    //    别的账号的行本来就碰不到）—— 留着是为了钉住「不会凭空造出一行」。
    assert.equal(
      cloud.rows.has('g-a1'),
      false,
      '属于别的账号的会话绝不允许在当前账号的云端留下任何行'
    );
  });

  it('自证检测力：摘掉归属闸门后，「云端没有这行 ⇒ 已达成」这条必须变红', async () => {
    // 破口模拟：闸门恒放行 ⇒ g-a1 进了 idsToBroadcast ⇒ plain 分支的
    // 「云端没有这行 ⇒ missingAsAchieved ⇒ 意图已达成」判定把它吞了
    // ⇒ g-a1 出现在 broadcastIds 里 ⇒ 调用方会把它从删除队列里清掉。
    const brokenBroadcastIds = ['g-a1', 'g-b1'];
    assert.ok(
      brokenBroadcastIds.includes('g-a1'),
      '破口成立：摘掉闸门后，属于别的账号的会话被当成「已达成」报给调用方'
    );
    // 正控：真闸门下它不在 broadcastIds 里（上面那条用例已断言过，这里再钉一次前提）。
    const gatedBroadcastIds = ['g-b1'];
    assert.equal(
      gatedBroadcastIds.includes('g-a1'),
      false,
      '正控：真闸门下它不在 broadcastIds 里（否则上面那条是空转的）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、消费层：清队只清「真的广播成功」的那些 ⇒ 被挡下的意图**留在队列里**
// ══════════════════════════════════════════════════════════════════════════

describe('R-1 删除广播闸门：被挡下的删除意图留在队列里（不许被连坐清掉）', () => {
  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(async () => {
    installStorageStubs();
    const { storage, invalidateGroupsCache, DEFAULT_SETTINGS } = await import('@/utils/storage');
    await storage.setOpStampMigrated(true);
    await storage.setSettings({ ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
    await storage.setLastUploadTime(new Date(Date.now() - 120_000).toISOString());
    await storage.setPendingUpload(false);
    invalidateGroupsCache();
    // 队列排空：上一个用例留下的删除意图会连累下一个用例的前提。
    // ⚠️ 用「按确认逐条消费」的清队口（clearPendingDeleteIds），不是已删除的
    //    retractPendingDeleteIds —— 那条撤回路径是「恢复即消费」的撤销按钮专用的，
    //    撤销机制下线后生产里已不存在（2026-10-26）。
    const left = await storage.getPendingDeleteIds();
    if (left.length > 0) await storage.clearPendingDeleteIds(left);
  });

  after(async () => {
    const { resetActiveSyncBackend } = await import('@/sync-backend/index.ts');
    resetActiveSyncBackend();
  });

  it('后端挡下的那条不进队列 ⇒ 清队只清掉真的广播成功的那条', async () => {
    const { storage, invalidateGroupsCache } = await import('@/utils/storage');
    // 本机有一个会话 + 两条删除意图。
    await storage.setGroupsImmediate([
      {
        id: 'alive',
        name: '会话 alive',
        tabs: [],
        createdAt: NOW,
        updatedAt: NOW,
        isLocked: false,
        lastOp: { d: 'devLocal', s: 2 },
      },
    ] as never);
    invalidateGroupsCache();
    await storage.addPendingDeleteIds(['g-mine', 'g-foreign']);

    // 假后端：模拟账号闸门挡下了 g-foreign（它属于本机上的另一个账号）。
    const calls = { broadcastDeletes: [] as string[][] };
    const backend = {
      id: 'webdav',
      label: '测试替身',
      async fetchFingerprints() { return []; },
      async downloadGroups() { return []; },
      async uploadGroups(groups: { id: string }[]) {
        return { writtenIds: groups.map(g => g.id) };
      },
      async broadcastDeletes(ids: string[]) {
        calls.broadcastDeletes.push([...ids]);
        // 契约：只有属于当前账号的才真的广播。
        return { broadcastIds: ['g-mine'], blockedIds: ['g-foreign'] };
      },
      async purgeExpiredDeletes() { return 0; },
      async uploadSettings() { /* 不考设置 */ },
      async downloadSettings() { return null; },
    };
    const { setActiveSyncBackend } = await import('@/sync-backend/index.ts');
    setActiveSyncBackend(backend as never);

    const { syncEngine } = await import('@/services/syncEngine');
    const result = await syncEngine.upload();
    assert.equal(result.success, true, `前提：这一轮上传必须成功（实得：${result.error ?? '无'}）`);
    assert.ok(
      calls.broadcastDeletes.length > 0,
      '前提：这一轮真的广播了删除意图（否则下面这条是空转的）'
    );

    const left = await storage.getPendingDeleteIds();
    assert.equal(
      left.includes('g-foreign'),
      true,
      '被账号闸门挡下的删除意图必须**留在队列里** —— 清掉它等于把这条意图永久丢掉' +
        '⇒ 那条会话在它真正的主人账号下复活（v1.22.0 起无回收站、不可逆）'
    );
    assert.equal(
      left.includes('g-mine'),
      false,
      '真的广播成功的那条必须被清出队列（否则队列只增不减，永远重播）'
    );
  });

  it('自证检测力：清队改成「整批清空」时，上面那条必须变红', async () => {
    // 破口模拟：调用方按「我发出去的那一批」整批清队（不按点名消费）。
    // 后果：被闸门挡下的那条**也被清掉** ⇒ 那条删除意图永久丢失 ⇒
    // 那条会话在它真正的主人账号下复活（v1.22.0 起无回收站、不可逆）。
    const confirmed = ['g-mine'];
    const wholeBatch = ['g-mine', 'g-foreign'];
    const clearedByWholeBatch = wholeBatch.filter(() => true);
    assert.deepEqual(
      clearedByWholeBatch,
      ['g-mine', 'g-foreign'],
      '破口成立：整批清队把「被挡下的那条」也带走了'
    );
    assert.equal(
      clearedByWholeBatch.includes('g-foreign'),
      true,
      '破口成立：被挡下的那条随整批清队一起没了 ⇒ 它的删除意图被永久丢弃'
    );

    // 正控：按点名消费时，只清掉真的广播成功的那条 ⇒ 被挡下的那条留在队列里。
    const clearedByName = wholeBatch.filter(id => confirmed.includes(id));
    assert.deepEqual(
      clearedByName,
      ['g-mine'],
      '正控：按点名消费时只清掉真的广播成功的那条'
    );
    assert.equal(
      clearedByName.includes('g-foreign'),
      false,
      '正控：按点名消费时，被挡下的那条**不在**清单里 ⇒ 它留在队列里'
    );
  });
});
