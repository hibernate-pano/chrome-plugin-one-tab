/**
 * WebDAV 分片目录布局：**1 位前缀**（2026-10-26）+ **老库（2 位）零改造可用**。
 *
 * ── 这条守卫防的具体事故 ────────────────────────────────────────────────
 *
 * **事故 1：撞坚果云的请求限额 ⇒ 同步停摆 6 小时。**
 * 坚果云官方限制：每 30 分钟不超过 600 次请求、单次 PROPFIND 最多 750 条。
 * 一次「列全目录」的请求数 = 1（列 `groups/`）+ N（逐个列前缀子目录），
 * 而 N = 用到的前缀目录数 = 会话 id 前缀的取值数。
 *   · 前缀 2 位 ⇒ N ≤ 256 ⇒ 单次扫描 ≤ 257 次；巡检每 5 分钟一次 ⇒
 *     30 分钟内 6 次 = 1542 次 ⇒ **撞线** ⇒ 503 BlockedTemporarily ⇒
 *     官方建议「关闭同步后六小时再重新启用」⇒ **同步停摆 6 小时**。
 *   · 前缀 1 位 ⇒ N ≤ 16 ⇒ 单次扫描 ≤ 17 次 ⇒ 限额问题消失。
 * ⇒ 所以「前缀几位」不是审美问题，是**同步还能不能用**的问题。
 *
 * **事故 2：改布局让老库的数据变成隐形数据。**
 * 2026-10-13 ~ 2026-10-26 之间建的库，分片都在 `groups/<id前2位>/` 里。
 * 只认新布局 ⇒ 那些会话对所有设备隐形（不可逆）。
 * ⇒ 老布局必须仍然**读得到**、**能下载**、**能上传**、**能删**。
 *
 * **事故 3：拿旧路径的 ETag 去条件写新路径 ⇒ 每次上传都 412 死循环。**
 * 条件写的凭据只对它所属的那个资源有效。老库的分片在旧路径上，
 * 而新代码只写新路径 ⇒ 拿旧 ETag 做 If-Match 新路径 ⇒ 目标不存在 ⇒ 必 412。
 *
 * ── 断言钉的是**不变量**，不是字面量 ───────────────────────────────────
 *   · 一次全量扫描列出的目录数 = 用到的**1 位**前缀数（不是 2 位前缀数）；
 *   · 按巡检间隔折算，30 分钟窗口内的请求数 ≤ 600；
 *   · 老库：能读、能下载、能上传、能删；
 *   · 两份副本按**操作印记**裁决（不看墙上时间）。
 *
 * ── 变异自证 ───────────────────────────────────────────────────────────
 * 见 tests/guards/webdavShardLayoutMigrationMutation.test.ts。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter, INDEX_VERIFY_INTERVAL_MS, type AdapterKv } from '@/sync-backend/webdav/adapter';
import {
  encodeGroup,
  legacyShardPath,
  makePlainEnvelope,
  serializeEnvelope,
  shardHeaderFromPayload,
  shardPath,
} from '@/sync-backend/webdav/layout';
import { LEGACY_KEYS } from '@/storage-kv/keys';
import type { TabGroup } from '@/types/tab';

const BASE = 'https://dav.example.com/dav/';
const NOW = '2026-10-26T10:00:00.000Z';
const M = 'TapStack/manifest.json';

/** 坚果云的官方限额：每 30 分钟 600 次请求（免费版）。 */
const JIANGUOYUN_REQUESTS_PER_30MIN = 600;
const WINDOW_MS = 30 * 60_000;

// ── 内存 WebDAV 服务器（与 tests/webdavAdapter.test.ts 同款）────────────

interface StoredFile {
  body: string;
  etag: string;
}

class FakeDav {
  files = new Map<string, StoredFile>();
  dirs = new Set<string>();
  calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  etagSeq = 0;

  private key(path: string): string {
    return path.replace(BASE, '').replace(/\/+$/, '');
  }

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const full = String(url);
    const path = this.key(full);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const method = String(init?.method ?? 'GET');
    this.calls.push({ method, path, headers });

    const respond = (status: number, body = '', extra: Record<string, string> = {}) => {
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(extra)) lower[k.toLowerCase()] = v;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
        text: async () => body,
      } as unknown as Response;
    };

    if (method === 'PROPFIND') {
      const depth = headers['depth'] ?? '0';
      if (depth === '1') {
        const children = this.childrenOf(path);
        if (!this.dirs.has(path) && children.length === 0) return respond(404);
        const responses = [
          this.responseXml(`${BASE}${path}/`, true),
          ...children.map(c => this.responseXml(`${BASE}${c.path}`, c.isCollection, c.etag)),
        ];
        return respond(
          207,
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`
        );
      }
      const f = this.files.get(path);
      if (f) {
        return respond(
          207,
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:getetag>${f.etag}</D:getetag></D:prop></D:propstat></D:response></D:multistatus>`
        );
      }
      if (this.dirs.has(path)) {
        return respond(
          207,
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>`
        );
      }
      return respond(404);
    }
    if (method === 'MKCOL') {
      if (this.dirs.has(path)) return respond(405);
      this.dirs.add(path);
      return respond(201);
    }
    if (method === 'DELETE') {
      if (!this.files.delete(path)) return respond(404);
      return respond(204);
    }
    if (method === 'GET') {
      const f = this.files.get(path);
      if (!f) return respond(404);
      if (headers['if-none-match'] && headers['if-none-match'] === f.etag) return respond(304);
      return respond(200, f.body, { ETag: f.etag });
    }
    if (method === 'PUT') {
      const existing = this.files.get(path);
      const ifMatch = headers['if-match'];
      const ifNoneMatch = headers['if-none-match'];
      // 条件写真实生效（RFC 4918）：
      //   · If-Match 指向的资源不存在或 ETag 不符 ⇒ 412；
      //   · If-None-Match:'*' 而资源已存在 ⇒ 412。
      // 缺陷形态正是「拿旧路径的 ETag 去 If-Match 新路径」⇒ 每次都 412。
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return respond(412);
      if (ifNoneMatch === '*' && existing) return respond(412);
      const etag = `"e${++this.etagSeq}"`;
      this.files.set(path, { body: String(init?.body ?? ''), etag });
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent) this.dirs.add(parent);
      return respond(201, '', { ETag: etag });
    }
    return respond(405);
  }) as unknown as typeof fetch;

  read(path: string): StoredFile | undefined {
    return this.files.get(path);
  }

  write(path: string, body: string): void {
    this.files.set(path, { body, etag: `"seed${++this.etagSeq}"` });
  }

  /** 删掉索引（分片文件留着）—— 触发「列目录重建」那条路径。 */
  removeIndex(): void {
    this.files.delete(M);
  }

  /** 读出索引里某个会话的条目。 */
  indexEntry(id: string): { id: string; loc?: string } | null {
    const raw = this.files.get(M);
    if (!raw) return null;
    const parsed = JSON.parse(raw.body) as { shards?: Array<{ id: string; loc?: string }> };
    return (parsed.shards ?? []).find(s => s.id === id) ?? null;
  }

  /** 这次会话里被列目录（Depth:1）过的路径。 */
  listedDirs(): string[] {
    return this.calls
      .filter(c => c.method === 'PROPFIND' && c.headers['depth'] === '1')
      .map(c => c.path);
  }

  resetCalls(): void {
    this.calls = [];
  }

  private childrenOf(dir: string): Array<{ path: string; isCollection: boolean; etag?: string }> {
    const out: Array<{ path: string; isCollection: boolean; etag?: string }> = [];
    for (const [p, f] of this.files) {
      if (this.parentOf(p) === dir) out.push({ path: p, isCollection: false, etag: f.etag });
    }
    for (const d of this.dirs) {
      if (d === dir) continue;
      if (this.parentOf(d) === dir) out.push({ path: d, isCollection: true });
    }
    return out;
  }

  private parentOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  private responseXml(href: string, isCollection: boolean, etag?: string): string {
    const resourcetype = isCollection
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : '<D:resourcetype/>';
    const etagXml = etag ? `<D:getetag>${etag}</D:getetag>` : '';
    return (
      '<D:response>' +
      `<D:href>${href}</D:href>` +
      `<D:propstat><D:prop>${resourcetype}${etagXml}</D:prop>` +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '</D:response>'
    );
  }
}

// ── 内存 KV ────────────────────────────────────────────────────────────

function makeKv(seed: Record<string, unknown> = {}): AdapterKv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    async get<T>(k: string) {
      return data.has(k) ? (data.get(k) as T) : null;
    },
    async set<T>(k: string, v: T) {
      data.set(k, v);
    },
    async remove(k: string) {
      data.delete(k);
    },
  };
}

function makeAdapter(dav: FakeDav, opts: { deviceId?: string } = {}) {
  const kv = makeKv({ [LEGACY_KEYS.DEVICE_ID]: opts.deviceId ?? 'dev-A' });
  const client = new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
  return {
    kv,
    adapter: new WebDavBackendAdapter({
      client,
      config: {
        baseUrl: BASE,
        username: 'u',
        password: 'p',
        rootPath: 'TapStack',
        passphrase: null, // 明文库：让断言只盯布局，不掺加密
      },
      kv,
      now: () => NOW,
      peekDeviceSeq: async () => 0,
    }),
  };
}

function makeGroup(id: string, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `会话 ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: 'dev-A', s: 10 },
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://example.com/${id}`,
        title: '标题',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    ...over,
  };
}

/** 造一个分片文件（明文外壳 + 明文头部），落进指定布局的路径。 */
function seedShard(dav: FakeDav, group: TabGroup, layout: 'current' | 'legacy'): string {
  const payload = encodeGroup(group);
  const body = serializeEnvelope(makePlainEnvelope(payload, shardHeaderFromPayload(payload)));
  const rel = layout === 'current' ? shardPath(group.id) : legacyShardPath(group.id);
  const full = `TapStack/${rel}`;
  dav.write(full, body);
  // 目录链必须真的存在（否则列目录时看不见这个文件）。
  // ⚠️ 逐级**累加**（不是逐段独立加前缀）—— 那才是目录链的真实形状。
  let acc = 'TapStack';
  for (const seg of rel.split('/').slice(0, -1)) {
    acc = `${acc}/${seg}`;
    dav.dirs.add(acc);
  }
  return full;
}

// ── 场景 1：扫描成本（1 位前缀） ────────────────────────────────────────

describe('分片目录：1 位前缀（限额倒推出来的，不是审美选择）', () => {
  it('一次全量扫描只列「1 位前缀」目录 —— 不是 2 位', async () => {
    // 16 个会话：2 位前缀各不相同（a0/a1/…/b5），1 位前缀只有 2 种（a、b）。
    // ⇒ 目录布局是 1 位 ⇒ 扫描只列 2 个子目录；若是 2 位 ⇒ 会列 16 个。
    const dav = new FakeDav();
    const ids = [
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
      'a8', 'a9', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5',
    ];
    for (const id of ids) seedShard(dav, makeGroup(id), 'current');

    // 索引丢了 ⇒ 走「列目录重建」⇒ 那正是最贵的那次扫描。
    dav.resetCalls();
    const { adapter: reader } = makeAdapter(dav);
    const groups = await reader.downloadGroups();
    assert.equal(groups.length, ids.length, '前置条件：重建出来的会话必须齐全');

    const listed = [...new Set(dav.listedDirs())].sort();
    assert.deepEqual(
      listed,
      ['TapStack/groups', 'TapStack/groups/a', 'TapStack/groups/b'],
      '扫描必须只列 1 位前缀目录（列 2 位目录 = 限额事故的形状）'
    );
  });

  it('新库：一次全量扫描 ≤ 65 次请求，30 分钟窗口内 ≤ 坚果云的 600 次上限', async () => {
    const dav = new FakeDav();
    // 最坏情况：整个 1 位前缀空间都用上（nanoid 的 64 字符表 ⇒ 64 种取值）。
    const ids = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
      .split('')
      .map(c => `${c}0`);
    for (const id of ids) seedShard(dav, makeGroup(id), 'current');

    dav.resetCalls();
    const { adapter: reader } = makeAdapter(dav);
    await reader.downloadGroups();

    const perScan = new Set(dav.listedDirs()).size;
    assert.equal(
      perScan,
      65,
      '一次全量扫描 = 1（列 groups/）+ 64（1 位前缀目录）—— 前缀目录数不可能超过 64'
    );

    const scansPerWindow = Math.ceil(WINDOW_MS / INDEX_VERIFY_INTERVAL_MS);
    const perWindow = perScan * scansPerWindow;
    assert.ok(
      perWindow <= JIANGUOYUN_REQUESTS_PER_30MIN,
      `30 分钟内会发 ${perWindow} 次请求，超过坚果云的 ${JIANGUOYUN_REQUESTS_PER_30MIN} 次上限`
    );
  });

  it('老库：2 位前缀目录不会被删掉 ⇒ 巡检间隔必须 ≥ 30 分钟，否则撞线', async () => {
    // ── 为什么这条专门量老库 ──────────────────────────────────────────────
    // 老库的 2 位前缀目录**不会被自动删掉**（删目录 = 动用户云盘上的东西，
    // 而且删错了就是内容丢失）⇒ 它们的扫描成本永远是
    // 「1 + 用到的 2 位前缀数」。
    // 这里用一个 256 个前缀目录的老库来量（十六进制 id 的老库就是这个量级；
    // 生产 id 是 nanoid ⇒ 2 位前缀最多 4096 种 ⇒ 只会更贵）。
    const dav = new FakeDav();
    const ids: string[] = [];
    for (const c1 of '0123456789abcdef') {
      for (const c2 of '0123456789abcdef') ids.push(`${c1}${c2}0`);
    }
    for (const id of ids) seedShard(dav, makeGroup(id), 'legacy');

    dav.resetCalls();
    const { adapter: reader } = makeAdapter(dav);
    await reader.downloadGroups();

    const perScan = new Set(dav.listedDirs()).size;
    assert.equal(
      perScan,
      257,
      '老库的一次全量扫描 = 1（列 groups/）+ 256（2 位前缀目录）—— 目录不会被自动删掉'
    );

    const scansPerWindow = Math.ceil(WINDOW_MS / INDEX_VERIFY_INTERVAL_MS);
    const perWindow = perScan * scansPerWindow;
    assert.ok(
      perWindow <= JIANGUOYUN_REQUESTS_PER_30MIN,
      `老库在 30 分钟内会发 ${perWindow} 次请求，超过坚果云的 ${JIANGUOYUN_REQUESTS_PER_30MIN} 次上限`
    );
  });

  it('老库 + 新会话（升级后最真实的样子）⇒ 一次扫描 ≤ 321 次，仍在限额内', async () => {
    // ── 为什么单独量这一种形状 ────────────────────────────────────────────
    // 老库的会话**写回老路径**（不搬家）⇒ 老库不会长出新的 2 位目录；
    // 但升级后**新建**的会话走 1 位新路径 ⇒ 老库里会多出最多 64 个 1 位目录。
    // ⇒ 最坏情况 = 1（列 groups/）+ 256（老的 2 位目录）+ 64（新的 1 位目录）。
    const dav = new FakeDav();
    for (const c1 of '0123456789abcdef') {
      for (const c2 of '0123456789abcdef') seedShard(dav, makeGroup(`${c1}${c2}0`), 'legacy');
    }
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') {
      seedShard(dav, makeGroup(`${c}0`), 'current');
    }

    dav.resetCalls();
    const { adapter: reader } = makeAdapter(dav);
    await reader.downloadGroups();

    const perScan = new Set(dav.listedDirs()).size;
    assert.equal(
      perScan,
      321,
      '升级后最坏的一次全量扫描 = 1 + 256（老的 2 位目录）+ 64（新的 1 位目录）'
    );

    const scansPerWindow = Math.ceil(WINDOW_MS / INDEX_VERIFY_INTERVAL_MS);
    const perWindow = perScan * scansPerWindow;
    assert.ok(
      perWindow <= JIANGUOYUN_REQUESTS_PER_30MIN,
      `老库+新会话在 30 分钟内会发 ${perWindow} 次请求，超过坚果云的 ${JIANGUOYUN_REQUESTS_PER_30MIN} 次上限`
    );
  });
});

// ── 场景 2：老库（2 位布局）零改造可用 ──────────────────────────────────

describe('老库（2 位前缀）不能变成隐形数据', () => {
  it('老库的分片仍能下载', async () => {
    const dav = new FakeDav();
    seedShard(dav, makeGroup('oldsess1'), 'legacy');

    const { adapter } = makeAdapter(dav);
    // 读不到时适配器会抛错（「云端有 N 个会话文件无法读取」）⇒ 那也是失败，
    // 但断言必须落在**行为**上（老库的会话必须能下载），而不是落在抛出的那句上。
    const groups = await adapter.downloadGroups().catch(() => [] as TabGroup[]);
    assert.deepEqual(
      groups.map(g => g.id),
      ['oldsess1'],
      '老布局里的会话必须能被下载（下载不到 = 对所有设备隐形 = 不可逆丢失）'
    );
  });

  it('重建出来的索引记下落点 loc=legacy（读哪一份必须由索引说了算）', async () => {
    const dav = new FakeDav();
    seedShard(dav, makeGroup('oldsess1'), 'legacy');

    // 上传另一个会话 ⇒ 顺手把重建出来的索引写回云端。
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('newsess1', { lastOp: { d: 'dev-A', s: 20 } })]);

    const entry = dav.indexEntry('oldsess1');
    assert.ok(entry, '老会话必须留在索引里');
    assert.equal(entry?.loc, 'legacy', '索引必须记下这个分片落在旧布局（否则裁决与读取不同源）');
  });

  it('上传到老库不会撞 412 死循环，且**写回它原来所在的位置**', async () => {
    // 缺陷形态 A：读到旧路径的 ETag ⇒ 拿它 If-Match **新路径** ⇒ 目标不存在
    //   ⇒ 必 412 ⇒ 靠「重试时改写路径」才勉强救回来，但那一趟 412 白费，
    //   而且「以本机为准」的显式覆盖会在重试里被判输（见下一个用例）。
    // 缺陷形态 B：另写一份到新路径 ⇒ 同一个会话**两份并存** ⇒ 之后每次列目录
    //   都要按印记裁决 ⇒ 「以本机为准」这种显式覆盖会被**静默撤回**。
    const dav = new FakeDav();
    seedShard(dav, makeGroup('oldsess1', { lastOp: { d: 'dev-A', s: 5 } }), 'legacy');
    dav.resetCalls();

    const { adapter } = makeAdapter(dav);
    // 失败形态是「抛错」（412 重试用尽）⇒ 把那句包进断言消息里，
    // 让断言落在**行为**上（老库必须能上传），而不是落在抛出的那句话上。
    const out = await adapter
      .uploadGroups([makeGroup('oldsess1', { lastOp: { d: 'dev-A', s: 20 }, name: '改过的名字' })])
      .catch((e: Error) => {
        throw new Error(`老库上的会话必须能上传成功（实际失败：${e.message}）`);
      });

    assert.deepEqual(out.writtenIds, ['oldsess1'], '老库上的会话必须能上传成功');
    // 写**覆盖原来那一份**（老路径）⇒ 每个会话永远只有一份文件。
    assert.ok(
      dav.read(`TapStack/${legacyShardPath('oldsess1')}`),
      '必须写回它原来所在的位置（老路径）'
    );
    assert.equal(
      dav.read(`TapStack/${shardPath('oldsess1')}`),
      undefined,
      '不能在新路径再造一份（两份并存 ⇒ 显式覆盖会被按印记撤回）'
    );
    // 而且**一次都不该**往新路径写：写回原位 ⇒ 条件写的凭据（ETag）天然
    // 属于要写的那个资源 ⇒ 一次 PUT 就成。
    // （只断言「最终状态」抓不到这一类缺陷：撞了 412 之后重试到老路径，
    //   最终文件照样在老路径、也不会多出一份 —— 但那一趟 412 意味着
    //   「冲突重试」被触发，而重试里会按印记「认输」⇒ 显式覆盖被丢弃。）
    assert.ok(
      !dav.calls.some(c => c.method === 'PUT' && c.path === `TapStack/${shardPath('oldsess1')}`),
      '不能往新路径 PUT（写回原位 ⇒ 一次就成；往别的路径写 ⇒ 必然 412 ⇒ 退化成「认输」）'
    );
  });

  it('「以本机为准」的覆盖不会被老那份按印记判赢而**静默撤回**', async () => {
    // 云端那份的号更大（云端更新），本机那份的号更小（本机副本本来就旧）。
    // 用户明确点了「以本机为准」⇒ 覆盖必须生效、且**留住**。
    const dav = new FakeDav();
    seedShard(dav, makeGroup('oldsess1', { name: '云端那份', lastOp: { d: 'dev-B', s: 99 } }), 'legacy');

    const { adapter } = makeAdapter(dav);
    const out = await adapter.uploadGroups(
      [makeGroup('oldsess1', { name: '本机为准', lastOp: { d: 'dev-A', s: 5 } })],
      { overwriteRemote: true }
    );
    assert.deepEqual(out.writtenIds, ['oldsess1'], '覆盖必须真的写上去');

    // 覆盖后的内容必须是「本机为准」，而且那个会话**只有一份文件**。
    const { adapter: reader } = makeAdapter(dav);
    const groups = await reader.downloadGroups();
    assert.equal(groups.length, 1, '同一个会话不能读出两份');
    assert.equal(groups[0].name, '本机为准', '用户点的那次覆盖必须留住');
    assert.equal(
      dav.read(`TapStack/${shardPath('oldsess1')}`),
      undefined,
      '不能在新路径再造一份（否则两份并存 ⇒ 裁决会把老那份判成赢 ⇒ 覆盖被撤回）'
    );
  });

  it('删除广播在老库上也能落地（墓碑覆盖原来那一份、读回校验通过）', async () => {
    const dav = new FakeDav();
    seedShard(dav, makeGroup('oldsess1', { lastOp: { d: 'dev-A', s: 5 } }), 'legacy');

    const { adapter } = makeAdapter(dav);
    // 失败形态是「抛错」（墓碑写到别的路径 ⇒ 条件写必然 412）⇒ 把那句包进
    // 断言消息里，让断言落在**行为**上（墓碑必须落在原来那一份），而不是
    // 落在服务端那句错误文案上。
    const res = await adapter.broadcastDeletes(['oldsess1']).catch((e: Error) => {
      throw new Error(`墓碑必须覆盖它原来所在的那一份（实际失败：${e.message}）`);
    });
    assert.deepEqual(res.broadcastIds, ['oldsess1'], '墓碑必须广播成功（否则删除意图被丢掉）');
    assert.ok(
      dav.read(`TapStack/${legacyShardPath('oldsess1')}`),
      '墓碑必须覆盖它原来所在的那一份'
    );
    assert.equal(
      dav.read(`TapStack/${shardPath('oldsess1')}`),
      undefined,
      '墓碑不能另写一份（两份并存 ⇒ 裁决可能把墓碑判输 ⇒ 删除被撤销 ⇒ 会话复活）'
    );
  });
});

// ── 场景 3：两份副本按操作印记裁决 ──────────────────────────────────────

describe('同一个会话在新旧两条路径上各有一份 ⇒ 按操作印记裁决', () => {
  it('旧布局那份的印记更大 ⇒ 旧布局赢（老版本设备写的更新不能被吞掉）', async () => {
    const dav = new FakeDav();
    // 同一个会话：旧路径上是**更新**的那份（老版本设备写的）。
    seedShard(dav, makeGroup('both1', { name: '旧布局的更新', lastOp: { d: 'dev-B', s: 9 } }), 'legacy');
    seedShard(dav, makeGroup('both1', { name: '新布局的旧版', lastOp: { d: 'dev-A', s: 4 } }), 'current');

    const { adapter } = makeAdapter(dav);
    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1, '同一个会话只能读出一份（不能变成两条）');
    assert.equal(groups[0].name, '旧布局的更新', '印记更大的那份说了算');
  });

  it('新布局那份的印记更大 ⇒ 新布局赢', async () => {
    const dav = new FakeDav();
    seedShard(dav, makeGroup('both1', { name: '旧布局的旧版', lastOp: { d: 'dev-B', s: 4 } }), 'legacy');
    seedShard(dav, makeGroup('both1', { name: '新布局的更新', lastOp: { d: 'dev-A', s: 9 } }), 'current');

    const { adapter } = makeAdapter(dav);
    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, '新布局的更新');
  });

  it('裁决结果要写进索引（否则下一轮读到的与裁决的不是同一份）', async () => {
    const dav = new FakeDav();
    seedShard(dav, makeGroup('both1', { name: '旧布局的更新', lastOp: { d: 'dev-B', s: 9 } }), 'legacy');
    seedShard(dav, makeGroup('both1', { name: '新布局的旧版', lastOp: { d: 'dev-A', s: 4 } }), 'current');

    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('newsess1', { lastOp: { d: 'dev-A', s: 20 } })]);

    const entry = dav.indexEntry('both1');
    assert.ok(entry, '这个会话必须留在索引里');
    assert.equal(entry?.loc, 'legacy', '索引必须记下「读旧路径那一份」');
  });
});
