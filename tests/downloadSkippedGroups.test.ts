// 「读不出来而被整组跳过」的**事实产出层**（2026-10-20 D-6 · 后端事实层）。
//
// ── 本文件在防什么回归 ───────────────────────────────────────────────────
//
// 云端下行时，有些会话**整组读不出来**会被跳过：
//   · tabs_data 解密失败 / 形状不可恢复   → unreadable_shape
//   · 部分标签过不了安全校验、还原率不达标 → restore_ratio
//   · tabs 表回填被网关 db-max-rows 截断   → tabs_table_truncated
//   · tabs 表回填的还原率不达标            → tabs_table_ratio
//   · 单组处理抛错                         → processing_error
//
// 修复前这些事实**只写进日志**。调用方拿到的是一个「看起来完整」的
// `TabGroup[]`，无法区分「云端只有 1 组」与「云端有 2 组、1 组读不出来」。
// 覆盖下载时引擎把 localGroups 置空 ⇒ 被跳过的那组既不在 mergedGroups 里、
// 也不在 removedGroupIds 里 ⇒ **本机那份被物理删除、不登记删除广播、界面报成功**。
//
// ── 本文件钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
// 每条断言问的是「用户的数据会怎样」：
//   1. 读不出来的那几组，**如实**被报出来（id + 正确的 reason）；
//   2. **正常**的组绝不能出现在清单里（清单不是「所有组的名单」）；
//   3. 没有跳过时清单是**空的**（默认语义 = 没有跳过，不是「不知道」）；
//   4. 被跳过的组，**云端那一行一个字节都没被动过**（它还在，只是这轮没读到）；
//   5. `downloadTabGroups()` 的**既有返回行为一字不变**（跳过的组仍不进结果）——
//      15+ 处既有调用点全靠这一点。
//
// ⚠️ 与 tests/downloadChain.test.ts 的分工（**故意不重复**）：
//   · downloadChain.test.ts 钉「**跨轮不串**」（清单的时序不变量）；
//   · 本文件钉「**如实产出事实**」（清单的内容不变量）。
//   重复的守卫是负担，不是保险。
//
// ── 装置说明 ─────────────────────────────────────────────────────────────
//
// 假云端 = 一个**最小**的 PostgREST 子集桩（GET/eq./order/range/count）。
// 刻意**不**复制 downloadChain.test.ts 那 200 行（它还要护 DELETE/PATCH/守卫
// 触发器/上传往返）；本文件只需要「读」这一半。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubSessionJson } from './_helpers/stubSession.ts';
// 纯类型导入：编译期擦除，运行时零依赖。
import type { DownloadSkipReason } from '@/types/tab';

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

const USER_ID = 'user-skip-test';
const SESSION_KEY = 'sb-stub-auth-token';
const NOW = '2026-10-20T08:00:00.000Z';
const LATER = '2026-10-20T09:00:00.000Z';

// ── 场景 → reason 的期望映射（**契约**）──────────────────────────────────
//
// 这几个值是「用户需要知道的事实」的一部分（UI 会按 reason 分类提示），
// 所以它们是**契约**、值得钉死。为了让改名成本可见，把它们集中在这里：
// 契约若变，改这一处即可，断言处不写散落的字面量。
const REASON = {
  /** tabs_data 形状不可恢复（解不开 / 形状坏） */
  shape: 'unreadable_shape',
  /** 还原率低于阈值 */
  ratio: 'restore_ratio',
  /** tabs 表回填被网关截断 */
  truncated: 'tabs_table_truncated',
  /** tabs 表回填的还原率不达标 */
  tabsRatio: 'tabs_table_ratio',
  /** 单组处理抛错 */
  processing: 'processing_error',
} as const satisfies Record<string, DownloadSkipReason>;

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

// ── 假云端（最小 PostgREST 子集） ─────────────────────────────────────────
interface CloudRow {
  id: string;
  user_id?: string;
  [k: string]: unknown;
}

const cloud = {
  /** tab_groups 表 */
  rows: new Map<string, CloudRow>(),
  /** tabs 表（老版本兼容分支的回填源） */
  tabs: [] as CloudRow[],
  /**
   * tabs 表**云端自报的总行数**（按 group_id 覆盖）。
   *
   * 缺省 = 实际行数。设成比实际行数大的值 ⇒ 模拟网关 db-max-rows 静默截断
   * （PostgREST 的 count=exact 走 Content-Range 回传总行数）。
   *
   * 按 group_id 分别设置是**必要的**：截断判据是「取回的行数 != 云端自报总数」，
   * 一个全局的总数会同时污染别的组（让它们也变成「被截断」）。
   */
  tabsTotal: new Map<string, number>(),
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 极简过滤：只认 eq. 与 in.()；select/order/offset/limit 不是过滤器。 */
function matches(row: CloudRow, params: URLSearchParams): boolean {
  for (const [key, raw] of params.entries()) {
    if (['select', 'limit', 'offset', 'order', 'on_conflict'].includes(key)) continue;
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
    return jsonRes({
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'ext@test.dev',
    });
  }

  // ── tabs 表（老版本兼容分支的回填源）────────────────────────────────
  if (url.pathname.endsWith('/rest/v1/tabs')) {
    if (method !== 'GET') return jsonRes([], 405);
    const hit = cloud.tabs.filter(r => matches(r, params));
    // 被问的 group_id（eq.group_id=eq.X）—— 用来取该组自己的「云端自报总数」。
    const groupFilter = params.get('group_id') ?? '';
    const groupId = groupFilter.startsWith('eq.') ? groupFilter.slice(3) : '';
    const total = cloud.tabsTotal.get(groupId) ?? hit.length;
    // count=exact 走 Content-Range 回传总数（postgrest-js 读它算 count）。
    const headers: Record<string, string> =
      hit.length > 0 ? { 'content-range': `0-${hit.length - 1}/${total}` } : {};
    return jsonRes(hit, 200, headers);
  }

  if (!url.pathname.endsWith('/rest/v1/tab_groups')) {
    return jsonRes({ message: 'not found' }, 404);
  }
  if (method !== 'GET') return jsonRes([], 405);

  // 列探测（supportsOpStamp）：一律报「列不存在」⇒ 走 select=* 降级。
  // 本文件不考列选择，固定走最简单的那条路径。
  if (params.get('select') === 'last_op_seq') {
    return jsonRes(
      {
        code: 'PGRST204',
        message: "Could not find the 'last_op_seq' column of 'tab_groups' in the schema cache",
        details: null,
        hint: null,
      },
      400
    );
  }

  const hit = [...cloud.rows.values()].filter(r => matches(r, params));
  // 排序：created_at DESC + id DESC（与 download.ts 的 order 一致）。
  hit.sort((a, b) => {
    const byCreated = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    return byCreated !== 0 ? byCreated : String(b.id).localeCompare(String(a.id));
  });
  const offset = Number(params.get('offset') ?? 0);
  const limit = Number(params.get('limit') ?? Number.POSITIVE_INFINITY);
  return jsonRes(hit.slice(offset, offset + limit));
}) as typeof fetch;

// ── 测试数据 ──────────────────────────────────────────────────────────────
/** 一行 TabData（云端 tabs_data 数组元素 / tabs 表行的形状） */
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

/** 一条云端 tab_groups 行的完整形状。 */
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

/**
 * n 个 https 标签 + (total - n) 个**过不了安全校验**的标签，凑成指定还原率。
 *
 * 用 `chrome://` 内部页当「过不了安全校验」的样本：它不在可存储协议白名单里
 * ⇒ `deserializeTab` 判 null ⇒ 计入「还原不出来」。
 */
const UNSAFE_URLS = [
  'chrome://newtab/',
  'chrome://settings/',
  'chrome://extensions/',
  'edge://favorites/',
  'chrome://downloads/',
  'edge://settings/',
  'chrome://history/',
  'edge://newtab/',
  'chrome://newtab/',
  'edge://extensions/',
];

function tabsWithRestoreRate(id: string, restorable: number, total: number) {
  return Array.from({ length: total }, (_, i) =>
    i < restorable
      ? tabData(`${id}-ok-${i}`, `https://${id}.example.com/${i}`)
      : tabData(`${id}-bad-${i}`, UNSAFE_URLS[i % UNSAFE_URLS.length])
  );
}

function seedGroup(row: CloudRow) {
  cloud.rows.set(row.id, row);
}

before(async () => {
  lsData.set('storage_version', JSON.stringify(5));
  lsData.set(SESSION_KEY, stubSessionJson(USER_ID));
  chromeData.set(SESSION_KEY, stubSessionJson(USER_ID));
});

beforeEach(() => {
  cloud.rows.clear();
  cloud.tabs.length = 0;
  cloud.tabsTotal.clear();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 跳过被如实计数
// ─────────────────────────────────────────────────────────────────────────
describe('下载：读不出来的那几组必须被如实报出来', () => {
  it('每一组都有 id + 正确的 reason；正常的组绝不出现在清单里', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');

    // 正常组：一个 https 标签，还原率 100%。
    seedGroup(cloudRow('g-ok'));
    // 形状不可恢复：tabs_data 解不开也解析不了。
    seedGroup(cloudRow('g-shape', { tabs_data: '{not json at all' }));
    // 还原率不达标：10 个标签只有 1 个能还原。
    seedGroup(
      cloudRow('g-ratio', { tabs_data: JSON.stringify(tabsWithRestoreRate('g-ratio', 1, 10)) })
    );
    // 单组处理抛错：tabs_data 数组里有 null 元素（deserializeTab 读 .url 抛）。
    seedGroup(cloudRow('g-crash', { tabs_data: JSON.stringify([null]) }));

    const groups = await downloadSync.downloadTabGroups();
    const skipped = await downloadSync.downloadSkippedGroups();

    // 正常组既不在结果里被跳过，也**绝不能**出现在清单里。
    assert.equal(
      skipped.some(s => s.id === 'g-ok'),
      false,
      '正常的组绝不能出现在「读不出来」的清单里（清单不是「所有组的名单」）'
    );
    assert.ok(
      groups.some(g => g.id === 'g-ok'),
      '正常的组必须照常出现在下载结果里'
    );

    // 每一组都被如实报出来，且 reason 正确。
    const byId = new Map(skipped.map(s => [s.id, s.reason]));
    assert.equal(byId.get('g-shape'), REASON.shape, '形状不可恢复 ⇒ 形状类原因');
    assert.equal(byId.get('g-ratio'), REASON.ratio, '还原率不达标 ⇒ 还原率类原因');
    assert.equal(byId.get('g-crash'), REASON.processing, '单组处理抛错 ⇒ 处理异常类原因');

    // 清单条数 = 实际被跳过的组数（不多不少）。
    assert.equal(
      skipped.length,
      3,
      `清单必须恰好列出 3 组（实得 ${skipped.length}：${skipped.map(s => s.id).join('、')}）`
    );
    // 清单里的每一项都必须有非空 id 与合法 reason。
    for (const s of skipped) {
      assert.equal(typeof s.id, 'string');
      assert.ok(s.id.length > 0, '清单项必须有 id');
      assert.ok(
        Object.values(REASON).includes(s.reason),
        `清单项 ${s.id} 的 reason 必须是已知取值（实得 ${s.reason}）`
      );
    }
  });

  it('tabs 表回填的两类跳过（被截断 / 还原率不达标）也被如实报出来', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');

    // 回填源：tabs 表。groups.tabs_data = null ⇒ 走老版本兼容分支。
    // ① 被网关截断：云端自报 5 行，我们只拿到 2 行。
    seedGroup(cloudRow('g-trunc', { tabs_data: null }));
    cloud.tabs.push(
      { id: 't1', group_id: 'g-trunc', user_id: USER_ID, url: 'https://a.example.com/', title: 'a', created_at: NOW, last_accessed: NOW },
      { id: 't2', group_id: 'g-trunc', user_id: USER_ID, url: 'https://b.example.com/', title: 'b', created_at: NOW, last_accessed: NOW }
    );
    cloud.tabsTotal.set('g-trunc', 5);

    // ② 回填还原率不达标：4 行里 3 行过不了安全校验。
    seedGroup(cloudRow('g-tabsratio', { tabs_data: null }));
    cloud.tabs.push(
      { id: 't3', group_id: 'g-tabsratio', user_id: USER_ID, url: 'https://ok.example.com/', title: 'ok', created_at: NOW, last_accessed: NOW },
      ...[1, 2, 3].map(i => ({
        id: `t-bad-${i}`,
        group_id: 'g-tabsratio',
        user_id: USER_ID,
        url: UNSAFE_URLS[i],
        title: 'bad',
        created_at: NOW,
        last_accessed: NOW,
      }))
    );

    await downloadSync.downloadTabGroups();
    const skipped = await downloadSync.downloadSkippedGroups();
    const byId = new Map(skipped.map(s => [s.id, s.reason]));

    assert.equal(byId.get('g-trunc'), REASON.truncated, '回填被截断 ⇒ 截断类原因');
    assert.equal(byId.get('g-tabsratio'), REASON.tabsRatio, '回填还原率不达标 ⇒ 回填还原率类原因');
  });

  it('没有跳过时清单是空的（默认语义 = 没有跳过，不是「不知道」）', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');
    seedGroup(cloudRow('g-ok'));
    seedGroup(cloudRow('g-ok2'));

    await downloadSync.downloadTabGroups();
    const skipped = await downloadSync.downloadSkippedGroups();

    assert.deepEqual(
      skipped,
      [],
      '一组的都没跳过 ⇒ 清单必须是空的（不是「不知道」，也不是「所有组」）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 云端行原封保留 + 既有返回行为不变
// ─────────────────────────────────────────────────────────────────────────
describe('下载：被跳过的组，云端那一行一个字节都没被动过', () => {
  it('云端行原封保留（它还在，只是这轮没读到）；且既有返回行为一字不变', async () => {
    const { downloadSync } = await import('@/utils/supabase/download');

    const heavyTabs = tabsWithRestoreRate('g-heavy', 1, 10);
    const heavyTabsData = JSON.stringify(heavyTabs);
    seedGroup(cloudRow('g-heavy', { tabs_data: heavyTabsData }));
    seedGroup(cloudRow('g-ok'));

    const before = JSON.stringify(cloud.rows.get('g-heavy'));

    const groups = await downloadSync.downloadTabGroups();

    // ① 云端行原封保留：一个字节都没少。
    assert.equal(
      JSON.stringify(cloud.rows.get('g-heavy')),
      before,
      '被跳过的组，云端那一行必须一个字节都没被动过（它还在，只是这轮没读到）'
    );
    assert.equal(
      JSON.parse(cloud.rows.get('g-heavy')!.tabs_data as string).length,
      heavyTabs.length,
      '云端那一份的标签一个都不能少'
    );

    // ② 既有返回行为一字不变：被跳过的组**仍然不进**下载结果。
    assert.equal(
      groups.some(g => g.id === 'g-heavy'),
      false,
      '被跳过的组仍然不进返回结果（既有行为不变：15+ 处调用点依赖这一点）'
    );
    assert.deepEqual(
      groups.map(g => g.id),
      ['g-ok'],
      '返回结果与修复前逐字一致'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 端口/适配器/服务层：清单必须从**同一轮**下载里取
// ─────────────────────────────────────────────────────────────────────────
describe('端口 / 适配器 / 服务层：清单与结果来自同一轮', () => {
  it('适配器把下载侧的事实原样转发（不夸大、不缩小）', async () => {
    const { SupabaseBackendAdapter } = await import('@/sync-backend/supabaseAdapter');

    seedGroup(cloudRow('g-shape', { tabs_data: '{not json at all' }));
    seedGroup(cloudRow('g-ok'));

    const adapter = new SupabaseBackendAdapter();
    const groups = await adapter.downloadGroups();
    const skipped = await adapter.downloadSkippedGroups();

    assert.deepEqual(
      groups.map(g => g.id),
      ['g-ok'],
      '适配器转发的结果与下载侧一致'
    );
    assert.deepEqual(
      skipped.map(s => s.id),
      ['g-shape'],
      '适配器转发的清单与下载侧一致'
    );
    assert.equal(
      skipped[0].reason,
      REASON.shape,
      'reason 必须原样透传（适配器不解释、不改写）'
    );
  });

  it('服务层的原子包装一次给出「结果 + 清单」', async () => {
    const { downloadTabGroupsWithSkips } = await import('@/services/tabGroupSyncService');

    seedGroup(cloudRow('g-ratio', { tabs_data: JSON.stringify(tabsWithRestoreRate('g-ratio', 1, 10)) }));
    seedGroup(cloudRow('g-ok'));

    const { groups, skipped } = await downloadTabGroupsWithSkips();

    assert.deepEqual(groups.map(g => g.id), ['g-ok'], '结果与下载侧一致');
    assert.deepEqual(skipped.map(s => s.id), ['g-ratio'], '清单与下载侧一致');
    assert.equal(skipped[0].reason, REASON.ratio, 'reason 原样透传');
  });
});
