/**
 * 假 PostgREST 云端（`tab_groups` 表的一个子集）。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────────
 * 把 `globalThis.fetch` 换成一个只认这几种请求的假端点：
 *   · GET    /rest/v1/tab_groups?select=…&<col>=eq.<v>&id=in.(…)
 *   · PATCH  /rest/v1/tab_groups?…      （软删墓碑写的就是它）
 *   · POST   /rest/v1/tab_groups         （upsert）
 *   · DELETE /rest/v1/tab_groups?…
 *   · GET    /auth/v1/user                （当前登录账号）
 *
 * 够跑「删除广播真的落到云端那一行」这条链路，不需要真数据库。
 *
 * ── 行按 id 索引，但每行带 user_id ────────────────────────────────────────
 * 真实的 `tab_groups` 上有 RLS（按 user_id 过滤），而本仓的写入**全都**带
 * `.eq('user_id', userId)` ⇒ 「别的账号的行」在本机既读不到也写不到。
 * 假云端必须保留这个性质：判据里「A 的那一行还在不在」才有意义。
 *
 * ── 为什么单独放一个 helper ───────────────────────────────────────────────
 * `tests/guards/deleteBroadcastAccountGate.test.ts` 里有一份同形的内联副本。
 * 那份文件归另一个 agent 且正在被改，本轮不碰它 ⇒ 两份会漂。
 * 但**先不动别人的文件**比消除重复更重要；等两边都收口后再合并
 * （合并时要保证两份判据都还在，不能只留一份）。
 */

/** 假云端可选项。 */
export interface FakePostgrestCloudOptions {
  /**
   * 模拟「云端还没有这一列」：投影里命中这些列名时返回 PGRST204（400）。
   *
   * 真实 PostgREST 对「投影里含不存在的列」返回 PGRST204 ⇒ 客户端据此
   * 降级（plain / hard-delete 分支）。
   */
  missingColumns?: string[];
}

/** 假云端句柄。 */
export interface FakePostgrestCloud {
  /** 云端行（按 id 索引；每行带 user_id，模拟 RLS 维度）。 */
  rows: Map<string, Record<string, unknown>>;
  /** 写操作日志（UPSERT/PATCH/DELETE），排查用。 */
  ops: string[];
  /** 切换「当前登录账号」（`/auth/v1/user` 返回它）。 */
  setSessionUser(userId: string): void;
  /** 还原 `globalThis.fetch`。 */
  restore(): void;
}

export function installFakePostgrestCloud(
  opts?: FakePostgrestCloudOptions,
): FakePostgrestCloud {
  const rows = new Map<string, Record<string, unknown>>();
  const ops: string[] = [];
  const missingColumns = new Set(opts?.missingColumns ?? []);
  let sessionUserId = 'user-unknown';

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
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : String((input as { url: string }).url));
    const method = (init.method ?? 'GET').toUpperCase();
    const params = url.searchParams;

    if (url.pathname.endsWith('/auth/v1/user')) {
      return jsonRes({ id: sessionUserId, aud: 'authenticated', role: 'authenticated' });
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

    return jsonRes({ message: `假云端不认识的请求: ${method} ${url.pathname}` }, 405);
  }) as typeof fetch;

  return {
    rows,
    ops,
    setSessionUser(userId: string) {
      sessionUserId = userId;
    },
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}
