// WebDAV 适配器测试（2026-10-13，阶段 1 收口）。
//
// 这是本次改造里最靠近用户数据的一层，测试用**内存版 WebDAV 服务器**跑真实
// 的 WebDavClient（而不是给适配器打桩）——否则「If-Match 到底有没有发出去」
// 「404 到底走没走对分支」这些真正会丢数据的细节就测不到。
//
// 断言重点：
//   · 「不可用」绝不等于「空」（坏 manifest 必须抛错，不能返回空库）
//   · 首次 = 全量上传（以本地为准）；之后 = 水位增量，不碰别的会话
//   · 412 冲突按组级 LWW 裁决：本地新 → 重试赢；远端新 → 认输不覆盖
//   · 墓碑进 downloadGroups（mergeOpStamped 靠它识别删除广播）
//   · 水位时钟回退 → 作废 → 全量（否则新会话永不上云）
//
// 变异验证口径（改坏实现必须变红，实测见提交信息）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebDavClient, WebDavError } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter, type AdapterKv } from '@/sync-backend/webdav/adapter';
import {
  encodeGroup,
  makeEncryptedEnvelope,
  serializeEnvelope,
  serializeManifest,
  shardHeaderFromPayload,
  shardPath,
} from '@/sync-backend/webdav/layout';
import { createVault } from '@/sync-backend/crypto';
import { LEGACY_KEYS } from '@/storage-kv/keys';
import type { TabGroup } from '@/types/tab';
import type { UserSettings } from '@/types/tab';

const BASE = 'https://dav.example.com/dav/';
const NOW = '2026-10-13T10:00:00.000Z';

// ── 内存 WebDAV 服务器 ─────────────────────────────────────────────────

interface StoredFile {
  body: string;
  etag: string;
}

class FakeDav {
  files = new Map<string, StoredFile>();
  dirs = new Set<string>();
  /** 记录所有请求，用于断言「某个头到底发了没有」。 */
  calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  /** 置 true 后，下一次写返回 412（模拟另一台设备抢先改了）。 */
  forcedConflicts = 0;
  /**
   * 置 true 后**忽略** If-Match / If-None-Match（模拟真实世界里存在的服务端）。
   *
   * 这不是假想：2026-10-13 真机实测 dufs 0.46 就是这样 —— PUT 不返回 ETag、
   * PROPFIND 不返回 getetag、三种条件头（If-Match / If-None-Match /
   * If-Unmodified-Since）全部被忽略，一律 201 并照写。
   * 协议定义了这些语义，但**没有任何东西强制服务端实现它**。
   */
  ignoreConditionalWrites = false;
  /** 非 null 时，所有 PUT 都返回该状态码（模拟 5xx 等服务端故障）。 */
  putStatusOverride: number | null = null;
  /**
   * 严格模式：按 RFC 4918 建模「父目录必须存在」。
   *
   *   · MKCOL 时父目录不存在 ⇒ 409（§9.3.1）；
   *   · PUT 时父目录不存在 ⇒ 409。
   *
   * 为什么默认**不开**：老用例里有不少是「直接把文件写进一个从没建过的目录」
   * （宽松模式会顺手把父目录补上），一次性收紧会把一堆**与本用例无关**的
   * 既有用例变红 —— 那是另一个工程，不该混在性能修复里。
   *
   * 为什么**必须**有它：真实服务端在父目录不存在时一律 409。少了「建目录链」
   * 这一步，宽松的假服务器**完全看不见**（MKCOL/PUT 都成功）⇒ 缺陷能一路
   * 溜到真机才炸。凡是要检验「目录链有没有被正确建出来」的用例，必须开它。
   */
  strictParents = false;
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
        // 列目录（Depth:1）：2026-10-20 修 P0「索引丢了被当成空库」后，
        // 适配器要靠**列目录**把云端索引重建出来 —— 这个假服务器必须
        // 像真服务器一样支持它，否则测的就不是真实路径。
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
      // 目录也是一个存在的资源（Depth:0 PROPFIND 应当回 207）。
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
      if (this.strictParents) {
        const parent = this.parentOf(path);
        if (parent && !this.dirs.has(parent)) return respond(409);
      }
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
      if (this.strictParents) {
        const parent = this.parentOf(path);
        if (parent && !this.dirs.has(parent)) return respond(409);
      }
      if (this.putStatusOverride !== null) return respond(this.putStatusOverride);
      // 强制冲突：模拟「读到之后、写之前，别人改了」这个并发窗口。
      if (this.forcedConflicts > 0) {
        this.forcedConflicts--;
        return respond(412);
      }
      const existing = this.files.get(path);
      const ifMatch = headers['if-match'];
      const ifNoneMatch = headers['if-none-match'];
      if (!this.ignoreConditionalWrites) {
        if (ifMatch && (!existing || existing.etag !== ifMatch)) return respond(412);
        if (ifNoneMatch === '*' && existing) return respond(412);
      }
      const etag = `"e${++this.etagSeq}"`;
      this.files.set(path, { body: String(init?.body ?? ''), etag });
      // 目录按路径推断（真实服务端会隐式建）
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

  /** 某个目录的**直接**子资源（文件 + 子目录）。 */
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

  /** 一条 PROPFIND 响应（对齐 RFC 4918 的 multistatus 形状）。 */
  private responseXml(href: string, isCollection: boolean, etag?: string): string {
    const resourcetype = isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
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
      return (data.has(k) ? (data.get(k) as T) : null);
    },
    async set<T>(k: string, v: T) {
      data.set(k, v);
    },
    async remove(k: string) {
      data.delete(k);
    },
  };
}

function makeAdapter(dav: FakeDav, opts: {
  passphrase?: string | null;
  kv?: ReturnType<typeof makeKv>;
  deviceSeq?: number;
  rootPath?: string;
} = {}) {
  const kv = opts.kv ?? makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' });
  const client = new WebDavClient(
    { baseUrl: BASE, username: 'u', password: 'p' },
    dav.fetch
  );
  return {
    kv,
    adapter: new WebDavBackendAdapter({
      client,
      config: {
        baseUrl: BASE,
        username: 'u',
        password: 'p',
        rootPath: opts.rootPath ?? 'TapStack',
        passphrase: opts.passphrase === undefined ? PASSPHRASE : opts.passphrase,
      },
      kv,
      now: () => NOW,
      peekDeviceSeq: async () => opts.deviceSeq ?? 0,
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
      { id: `${id}-t1`, url: `https://example.com/${id}`, title: '标题', createdAt: NOW, lastAccessed: NOW, pinned: false },
    ],
    ...over,
  };
}

const M = 'TapStack/manifest.json';
/**
 * 测试用的加密口令（2026-10-24 审计 SEC-1）。
 *
 * 新建加密库时**必须**够强（`webdav/passphrasePolicy.ts`），否则适配器会
 * 在建库那一刻抛错。所以这里的口令换成了真正能用的长口令 ——
 * 它不是被测对象，只是「一把正常的钥匙」。
 */
const PASSPHRASE = 'correct horse battery staple';


// ── 「不可用」≠「空」 ──────────────────────────────────────────────────

describe('「不可用」绝不等于「空」', () => {
  it('远端没有 manifest → 空（这是合法的首次同步起点）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    assert.deepEqual(await adapter.fetchFingerprints(), []);
    assert.deepEqual(await adapter.downloadGroups(), []);
  });

  it('manifest 存在但坏了 → **抛错**，不返回空库', async () => {
    // 返回空库会让上层判「云端被清空」→ 合并清空本地 → 无回收站不可逆。
    const dav = new FakeDav();
    dav.write(M, '{ 这不是合法 JSON');
    const { adapter } = makeAdapter(dav);
    await assert.rejects(() => adapter.fetchFingerprints(), /无法解析/);
    await assert.rejects(() => adapter.downloadGroups(), /无法解析/);
  });

  it('加密库缺 salt → 抛错（形状对但语义自相矛盾）', async () => {
    const dav = new FakeDav();
    dav.write(M, JSON.stringify({ v: 1, generatedAt: NOW, encrypted: true, shards: [] }));
    const { adapter } = makeAdapter(dav);
    await assert.rejects(() => adapter.fetchFingerprints(), /缺少密钥参数/);
  });

  it('加密库但本机没口令 → 抛可读错误（不静默当明文读）', async () => {
    const dav = new FakeDav();
    const { adapter: writer } = makeAdapter(dav);
    await writer.uploadGroups([makeGroup('g1')]);

    const { adapter: noPass } = makeAdapter(dav, { passphrase: null });
    await assert.rejects(() => noPass.downloadGroups(), /没有口令/);
  });
});

// ── SEC-1：新建加密库时的口令强度门槛（2026-10-24）────────────────────
//
// 为什么这一节钉在**适配器**而不是表单：口令不落盘，老用户每次重开页面
// 都要重新输入当年那个口令。在表单上拦 ⇒ 他会被**自己的**口令挡在门外
// （新设备配同一个库、清过配置再配回来都会中招）。
// 适配器知道「这个库是不是已经加密了」—— 只有「还没有」时才拦。

describe('SEC-1：口令强度门槛只拦「新建加密库」', () => {
  it('远端还没有库 + 弱口令 → 拒绝建库（一个字节都不许上云）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { passphrase: '123456' });
    await assert.rejects(() => adapter.uploadGroups([makeGroup('g1')]), /口令太弱/);
    // 前提：失败发生在建库那一刻 ⇒ 云端不该留下任何文件
    assert.equal(dav.read(M), undefined, '弱口令不得建出 manifest');
    assert.equal(dav.read(`TapStack/${shardPath('g1')}`), undefined, '弱口令不得写出会话分片');
  });

  it('远端还没有库 + 强口令 → 正常建库（门槛不是把功能堵死）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { passphrase: PASSPHRASE });
    const out = await adapter.uploadGroups([makeGroup('g1')]);
    assert.equal(out.writtenIds.length, 1);
    assert.ok(dav.read(M), '前提：库建成了');
  });

  it('已加密的老库 + 弱口令 → **照常能用**（老用户不被自己的口令锁死）', async () => {
    // 这一条是整个修法的**核心不变量**。
    // 造一个「修复前建成的库」：弱口令 123456，且它**真的能用那个口令解开**
    // （不是拿强口令的库去撞弱口令，那样只会得到「口令错误」，测不到门槛）。
    const dav = new FakeDav();
    const legacyPass = '123456';
    const vault = await createVault(legacyPass);
    const payload = encodeGroup(makeGroup('g1'));
    dav.write(
      `TapStack/${shardPath('g1')}`,
      serializeEnvelope(makeEncryptedEnvelope(await vault.encrypt(payload), shardHeaderFromPayload(payload)))
    );
    dav.write(
      M,
      serializeManifest({
        v: 1,
        generatedAt: NOW,
        encrypted: true,
        salt: vault.salt,
        shards: [{ id: 'g1', updatedAt: NOW, etag: 'e1', lastOp: { d: 'dev-A', s: 10 } }],
      })
    );

    const { adapter } = makeAdapter(dav, { passphrase: legacyPass });
    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1, '老库必须照常读出来（门槛不能落到「回忆口令」上）');
    assert.equal(groups[0].id, 'g1');
  });
});

// ── 首次全量 / 之后增量 ────────────────────────────────────────────────

describe('以本地为准：首次全量，之后增量', () => {
  it('首次同步上传全部组（不管 stamp 与水位的比较）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    const groups = [makeGroup('aa1'), makeGroup('bb2'), makeGroup('cc3')];

    const out = await adapter.uploadGroups(groups);
    assert.equal(out.writtenIds.length, 3);
    for (const g of groups) assert.ok(dav.read(`TapStack/${shardPath(g.id)}`), `${g.id} 未落盘`);
  });

  it('首次同步不覆盖远端已有的其他会话（远端有 manifest 时按增量走）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    // 先建一个「另一台设备」写好的库
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 100 } })]);

    // 新设备（水位为 0）用较低 stamp 的组上行：不应重传已有会话，也不应丢它
    const { adapter: fresh } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }) });
    const out = await fresh.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-B', s: 1 } })]);
    assert.equal(out.writtenIds.length, 0, '低 stamp 的组不应被写（云端更新）');

    const manifest = JSON.parse(dav.read(M)!.body);
    assert.equal(manifest.shards.length, 1, 'manifest 不应丢掉别的会话条目');
  });

  it('水位推进后，未改动的组不再重复上传（增量的核心）', async () => {
    const dav = new FakeDav();
    const { adapter, kv } = makeAdapter(dav, { deviceSeq: 50 });
    const groups = [makeGroup('aa1', { lastOp: { d: 'dev-A', s: 10 } })];
    await adapter.uploadGroups(groups);

    const writesAfterFirst = dav.calls.filter(c => c.method === 'PUT' && c.path.includes('/groups/')).length;
    assert.equal(writesAfterFirst, 1);
    assert.ok(kv.data.size > 0, '水位应已落盘');

    // 同一批数据再传一次：水位 = 10，组 stamp = 10，不满足 `10 > 10` ⇒ 不传
    const second = await adapter.uploadGroups(groups);
    assert.equal(second.writtenIds.length, 0);
  });

  it('水位时钟回退（用户清了本地数据）→ 作废水位、走全量', async () => {
    const dav = new FakeDav();
    const kv = makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' });
    // 模拟旧水位：seq=5000 且基线 deviceSeq=5000，而当前计数器已回退到 5
    const { adapter: first } = makeAdapter(dav, { kv, deviceSeq: 5000 });
    await first.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 4999 } })]);

    const { adapter: afterReset } = makeAdapter(dav, { kv, deviceSeq: 5 });
    const out = await afterReset.uploadGroups([makeGroup('bb2', { lastOp: { d: 'dev-A', s: 1 } })]);
    // 若不检测回退：1 > 5000 为假 ⇒ 新会话永不上云（Supabase 侧踩过的 P0）
    assert.equal(out.writtenIds.length, 1, '时钟回退后必须作废水位、按全量上行');
  });
});

// ── 冲突裁决 ───────────────────────────────────────────────────────────

describe('412 冲突按组级 LWW 裁决', () => {
  // ⚠️ 本组两条「认输」用例覆盖的是**两层不同的防线**，不是重复，别删任何一条：
  //   · 下面「远端 stamp 更新」走 `dav.forcedConflicts` ⇒ 命中的是 **412 之后**的
  //     读回裁决（putShardResolvingConflict）；
  //   · 上面「首次同步不覆盖远端已有的其他会话」不制造 412 ⇒ 命中的是
  //     **写之前**的认输预检（uploadGroups 里那次 compareStamps）。
  // 2026-10-13 变异验证佐证：删掉写前预检时，只有后者变红（前者仍绿）。
  // 少了写前预检，一台久未同步的设备会静默覆盖云端更新版本 —— 根因见 adapter.ts。
  it('本地 stamp 更新 → 重试并写入（不因一次冲突就放弃）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5 } })]);

    const changed = makeGroup('aa1', { name: '我改过了', lastOp: { d: 'dev-A', s: 9 } });
    dav.forcedConflicts = 1; // 第一次写撞 412
    const out = await adapter.uploadGroups([changed]);

    assert.equal(out.writtenIds.length, 1, '本地更新应最终写入');
    assert.ok(dav.read(`TapStack/${shardPath('aa1')}`), '重试后文件应存在');
  });

  it('远端 stamp 更新 → 认输跳过，**不覆盖**对端的新版本', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    // 云端已是 dev-A seq=100 的新版本
    await adapter.uploadGroups([makeGroup('aa1', { name: '云端新版', lastOp: { d: 'dev-A', s: 100 } })]);
    const before = dav.read(`TapStack/${shardPath('aa1')}`)!.body;

    // 另一台设备的旧改动（seq=3）撞 412 后应认输
    const { adapter: other } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }), deviceSeq: 3 });
    dav.forcedConflicts = 1;
    const out = await other.uploadGroups([makeGroup('aa1', { name: '我的旧版', lastOp: { d: 'dev-B', s: 3 } })]);

    assert.equal(out.writtenIds.length, 0, '旧版本不应覆盖云端新版本');
    assert.equal(dav.read(`TapStack/${shardPath('aa1')}`)!.body, before, '云端内容必须原样保留');
  });

  it('新增会话用 If-None-Match:* 创建（防止覆盖同 id 的并发创建）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);
    const put = dav.calls.find(c => c.method === 'PUT' && c.path.includes('/groups/'));
    assert.equal(put?.headers['if-none-match'], '*');
  });
});

// ── 删除 ───────────────────────────────────────────────────────────────

describe('删除广播与 TTL', () => {
  it('删除写墓碑（覆盖同分片，不删文件）且触发删除后 manifest 标记 isDeleted', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);

    await adapter.broadcastDeletes(['aa1']);
    const manifest = JSON.parse(dav.read(M)!.body);
    assert.equal(manifest.shards.find((s: { id: string }) => s.id === 'aa1')?.isDeleted, true);
    // 分片文件仍在（承载删除意图），而不是被删掉
    assert.ok(dav.read(`TapStack/${shardPath('aa1')}`), '墓碑必须保留为文件');
  });

  it('墓碑能被 downloadGroups 读出并带上 isDeleted（mergeOpStamped 靠它识别删除）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);
    await adapter.broadcastDeletes(['aa1']);

    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].isDeleted, true, '墓碑必须进下载结果，否则删除意图传达不到');
    assert.ok(typeof groups[0].lastOp?.s === 'number', '墓碑要带 stamp 才能参与裁决');
  });

  it('TTL：过期墓碑被清理，未过期墓碑保留', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1'), makeGroup('bb2')]);
    await adapter.broadcastDeletes(['aa1', 'bb2']);

    // 把 aa1 的墓碑时间改成 40 天前（now 注入是固定的，所以直接改盘上的 manifest）
    const manifest = JSON.parse(dav.read(M)!.body);
    const old = new Date(Date.parse(NOW) - 40 * 864e5).toISOString();
    manifest.shards = manifest.shards.map((s: { id: string }) =>
      s.id === 'aa1' ? { ...s, updatedAt: old } : s
    );
    dav.write(M, JSON.stringify(manifest));

    const purged = await adapter.purgeExpiredDeletes(30);
    assert.equal(purged, 1);
    assert.equal(dav.read(`TapStack/${shardPath('aa1')}`), undefined, '过期墓碑文件应已删除');
    assert.ok(dav.read(`TapStack/${shardPath('bb2')}`), '未过期墓碑必须保留');
  });
});

// ── 设置 ───────────────────────────────────────────────────────────────

describe('设置同步', () => {
  it('加密模式下往返（且盘上是密文，不出现明文设置）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadSettings({ themeMode: '机密模式' } as never);

    const raw = dav.read('TapStack/settings.json')!.body;
    assert.ok(!raw.includes('机密模式'), '盘上不得出现明文设置');
    assert.ok(raw.includes('"enc"'));

    const back = await adapter.downloadSettings();
    assert.equal(back?.themeMode, '机密模式');
  });

  it('远端没有设置文件 → null（不是空对象）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    assert.equal(await adapter.downloadSettings(), null);
  });
});

// ── 目录与安全 ─────────────────────────────────────────────────────────

describe('目录与路径安全', () => {
  it('自定义根目录生效', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { rootPath: 'Apps/TapStack' });
    await adapter.uploadGroups([makeGroup('aa1')]);
    assert.ok(dav.read('Apps/TapStack/manifest.json'), '应在自定义目录下写 manifest');
  });

  it('根目录含 .. → 拒绝（防越出用户配置的目录）', () => {
    const dav = new FakeDav();
    assert.throws(() => makeAdapter(dav, { rootPath: '../escape' }), /不合法/);
  });
});

describe('能力探测：条件写到底有没有真的生效', () => {
  // 2026-10-13 真机实测逼出来的一层。dufs 0.46 完全忽略条件写头，
  // 于是「乐观锁」在那类服务端上**根本不存在**。最坏的形态不是「没有锁」，
  // 是**以为有锁**——代码不提醒，用户以为有并发保护。所以能力必须被探测。
  it('服务端实现条件写 → 探测返回 true', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    assert.equal(await adapter.probeConditionalWrites(), true);
  });

  it('服务端忽略条件写 → 探测返回 false（不谎报有保护）', async () => {
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    assert.equal(await adapter.probeConditionalWrites(), false);
  });

  it('探测后不留下探针文件（否则每轮同步都堆垃圾）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.probeConditionalWrites();
    assert.equal(dav.read('TapStack/.tapstack-probe'), undefined);
  });

  it('探测本身失败（5xx）→ 返回 false，按「无保护」处理', async () => {
    // fail-safe 的方向必须钉住：把「未知」当成「有保护」，用户会在
    // 完全没有并发保护的情况下被静默；当成「无保护」最坏只多一条提示。
    // 这条用例是变异验证补出来的——彼时「探测失败返回 true」没有被任何测试抓到。
    const dav = new FakeDav();
    dav.putStatusOverride = 503;
    const { adapter } = makeAdapter(dav);
    assert.equal(await adapter.probeConditionalWrites(), false);
    dav.putStatusOverride = null;
  });

  it('没授权时必须抛出权限错，**不得**误判成「服务端不支持条件写」（2026-10-14 P1）', async () => {
    // 这条是补 P1 时发现的真实误判：权限预检抛的是 status 0，
    // 而上面那条「探测失败 → false」的兜底会把它吞成 false，
    // 于是「浏览器没给这个域名的权限」被上报成「你的服务器配置不对」——
    // 一个把用户引向错误方向（去查服务器）的结论。
    // 真实原因只需要点一次「测试连接」授权就能解决。
    // 守卫直接拒绝权限，请求根本不会打到 FakeDav，所以不需要 dav 实例。
    const guardedClient = new WebDavClient(
      { baseUrl: BASE, username: 'u', password: 'p' },
      fetch,
      async () => false
    );
    const adapter = new WebDavBackendAdapter({
      client: guardedClient,
      config: { baseUrl: BASE, username: 'u', password: 'p' },
      kv: makeKv(),
      peekDeviceSeq: async () => 0,
    });
    await assert.rejects(
      () => adapter.probeConditionalWrites(),
      (err: unknown) => {
        assert.ok(err instanceof WebDavError);
        assert.equal(err.isPermissionDenied, true, '必须带权限标记');
        assert.match(err.message, /权限|测试连接/);
        return true;
      }
    );
  });

  it('checkConnection 把能力与库信息一起报出来', async () => {
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);

    const info = await adapter.checkConnection();
    assert.equal(info.conditionalWrites, false);
    assert.equal(info.encrypted, true);
    assert.equal(info.groups, 1);
  });

  it('服务端忽略条件写时，整套往返仍然可用（降级但不崩）', async () => {
    // 这是关键：能力缺失不是致命错误。并发保护退化为「认输预检」
    //（stamp 比较，与服务端无关），功能照常。
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('aa1', { name: 'v1', lastOp: { d: 'dev-A', s: 5 } })]);

    const { adapter: b } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }) });
    const got = await b.downloadGroups();
    assert.equal(got[0]?.name, 'v1');

    // 认输预检不依赖服务端能力：旧副本仍然压不过新版本
    const stale = await b.uploadGroups([makeGroup('aa1', { name: '旧', lastOp: { d: 'dev-B', s: 1 } })]);
    assert.equal(stale.writtenIds.length, 0);
    assert.equal((await a.downloadGroups())[0]?.name, 'v1');
  });
});


// ── 2026-10-14 修 P0/P1/P2 的回归 ─────────────────────────────────────────
// 每条都是「修之前红、修之后绿」的行为断言（变异口径：把对应的实现改回去，
// 测试必须变红 —— 已逐条用 cp 备份/恢复验证过）。

describe('2026-10-14 修 P1：并发写不丢对端条目', () => {
  it('对端在中途写入的会话，manifest 重试时必须保留', async () => {
    // 场景：A 读完 manifest（只有 aa1）→ 写分片前对端 B 写入 bb2 并更新了
    // manifest → A 写 manifest 时 etag 已过期（412）→ 重试。
    // 旧实现用关闭时的旧快照整体覆盖，重试后 bb2 从清单里消失
    // （文件还在，但 manifest 是真相源 ⇒ 对端会话隐形丢失）。
    const dav = new FakeDav();
    const { adapter: first } = makeAdapter(dav);
    await first.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5 } })]);

    const { adapter: b } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }) });
    const rawFetch = dav.fetch;
    let injected = false;
    dav.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      // A 写 cc3 分片的那一刻，对端 B 先完成一整轮上传（读新 manifest 写回）。
      if (!injected && String(init?.method ?? 'GET') === 'PUT' && u.includes('/cc3.json')) {
        injected = true;
        await b.uploadGroups([makeGroup('bb2', { name: '对端', lastOp: { d: 'dev-B', s: 6 } })]);
      }
      return rawFetch(url, init);
    }) as unknown as typeof fetch;

    // a2 在包装备注之后构造：它的 client 拿到的是包装备注后的 fetch。
    const clientA = new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
    const a2 = new WebDavBackendAdapter({
      client: clientA,
      config: { baseUrl: BASE, username: 'u', password: 'p', rootPath: 'TapStack', passphrase: PASSPHRASE },
      kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' }),
      now: () => NOW,
      peekDeviceSeq: async () => 0,
    });
    await a2.uploadGroups([makeGroup('cc3', { name: '本端', lastOp: { d: 'dev-A', s: 7 } })]);

    assert.equal(injected, true, '并发注入必须发生，否则这条测的就不是并发');
    const manifest = JSON.parse(dav.read(M)!.body) as { shards: Array<{ id: string }> };
    const ids = manifest.shards.map(s => s.id).sort();
    assert.deepEqual(ids, ['aa1', 'bb2', 'cc3'], '三方的条目必须都在，重试不得覆盖对端');
    const groups = await a2.downloadGroups();
    assert.equal(groups.length, 3, '内容与清单一致，不只是条目名');
  });
});

describe('2026-10-14 修 P1：删除墓碑 stamp 压过云端', () => {
  it('云端 stamp 更大时，墓碑 seq 取云端 +1（否则删除会复活）', async () => {
    const dav = new FakeDav();
    const { adapter: seeder } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }) });
    await seeder.uploadGroups([makeGroup('xx1', { lastOp: { d: 'dev-B', s: 100 } })]);

    // 本设备 seq 时钟很小（久未同步的设备）：旧实现只用 deviceSeq + 1 = 1，
    // 墓碑 stamp 反而小于云端副本 ⇒ 对端合并时删除输给旧副本 ⇒ 删掉的组复活。
    const { adapter: a } = makeAdapter(dav, { kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' }), deviceSeq: 0 });
    await a.broadcastDeletes(['xx1']);

    const groups = await a.downloadGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.isDeleted, true);
    assert.ok(
      (groups[0]?.lastOp?.s ?? 0) > 100,
      `墓碑 stamp 必须大于云端 100，实际 ${String(groups[0]?.lastOp?.s)}`
    );
  });
});

/**
 * 2026-10-17 修 P0：删除广播的设备 id 此前读的是手抄键 'device_id'，
 * 而全仓唯一的写入方 deviceUtils.getDeviceId() 写的是
 * LEGACY_KEYS.DEVICE_ID（'tabvaultpro_device_id'），kvGet 不做键名别名
 * ⇒ device 恒为 null ⇒ **每一次删除广播都盖上 d:'unknown'**。
 *
 * 后果（为什么这条必须钉死）：两台设备都删除时，compareStamps 先比 s、
 * s 相同再比 d 字典序，于是 "unknown" === "unknown" → 返回 0 → 平局判
 * **本地赢**（opStampMerge.pickByStamp）→ 云端墓碑输给本地活跃副本并被重新
 * 上传，**删除在对端被静默撤销、会话复活**。1.22.0 起无回收站，不可逆。
 *
 * 【为什么这条测试以前抓不到】原 fixture 用 `makeKv({ device_id: 'dev-A' })`
 * 播种的**正是那个错误字面量**，于是 fixture 与 bug 互相镜像、测试恒绿。
 * 现在 fixture 引用权威常量 LEGACY_KEYS.DEVICE_ID，本用例再断言读回来的
 * lastOp.d —— 把「键名」这个曾经无人覆盖的属性变成 CI 可见的护栏。
 *
 * 变异验证：把 adapter.ts 的 `LEGACY_KEYS.DEVICE_ID` 改回 `'device_id'`
 * ⇒ 本用例的 lastOp.d 断言红。
 */
describe('2026-10-17 修 P0：删除广播盖上真实设备 id', () => {
  it('墓碑 lastOp.d 必须是本设备真实 id，而不是兜底的 unknown', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, {
      kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' }),
      deviceSeq: 7,
    });
    await adapter.uploadGroups([makeGroup('dd1')]);
    await adapter.broadcastDeletes(['dd1']);

    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1);
    assert.equal(
      groups[0]?.lastOp?.d,
      'dev-A',
      '墓碑必须盖本设备真实 id；盖成 unknown 会让两台设备的删除在 LWW 里打成平局，' +
        '平局判本地赢 ⇒ 删除在对端被静默撤销、会话复活'
    );
    assert.notEqual(
      groups[0]?.lastOp?.d,
      'unknown',
      '生产环境读不到设备 id 说明键名又与写入方分叉了（权威键是 LEGACY_KEYS.DEVICE_ID）'
    );
  });

  it('两台设备的删除必须能分出胜负（d 不同 ⇒ 不会打成平局）', async () => {
    const dav = new FakeDav();
    // A 先删，墓碑落盘
    const { adapter: a } = makeAdapter(dav, {
      kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' }),
      deviceSeq: 1,
    });
    await a.uploadGroups([makeGroup('ee1')]);
    await a.broadcastDeletes(['ee1']);

    // B 在**同一个 seq** 上删除另一个组：若 d 都是 'unknown'，
    // 两条墓碑会在 compareStamps 里返回 0，跨设备的删除顺序就变成任意的。
    const { adapter: b } = makeAdapter(dav, {
      kv: makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' }),
      deviceSeq: 1,
    });
    await b.uploadGroups([makeGroup('ff1')]);
    await b.broadcastDeletes(['ff1']);

    const groups = await b.downloadGroups();
    const ee = groups.find((g) => g.id === 'ee1');
    const ff = groups.find((g) => g.id === 'ff1');
    assert.equal(ee?.lastOp?.d, 'dev-A');
    assert.equal(ff?.lastOp?.d, 'dev-B');
    assert.notEqual(
      ee?.lastOp?.d,
      ff?.lastOp?.d,
      '跨设备的两条墓碑必须靠 d 区分开；同为 unknown 时 LWW 退化为任意裁决'
    );
  });
});

describe('2026-10-14 修 P2：建库前先传设置', () => {
  it('salt 必须落进 manifest，否则设置写完就读不回', async () => {
    // 旧实现：unlock(null) 新建随机 salt 的 Vault，加密完不写 manifest。
    // 下次下载按 manifest 的 salt 派生出另一个密钥 ⇒ salt 不一致 ⇒ 设置永久不可读。
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    assert.equal(dav.read(M), undefined, '前提：还没有建库');

    await adapter.uploadSettings({ theme: 'dark' } as unknown as UserSettings);

    const manifest = JSON.parse(dav.read(M)!.body) as { encrypted: boolean; salt?: string };
    assert.equal(manifest.encrypted, true, '写加密设置时必须把库标记为加密态');
    assert.ok(typeof manifest.salt === 'string' && manifest.salt.length > 0, 'salt 必须持久化');

    const back = await adapter.downloadSettings();
    assert.deepEqual(back, { theme: 'dark' }, '设置必须能往返读回');
  });
});

// ── 2026-10-14 坚果云真机实测发现 ─────────────────────────────────────────
//
// 实测（https://dav.jianguoyun.com/dav/，2026-10-14）：
//   · PUT **响应不带 ETag**（putEtag = null）
//   · PROPFIND 不返回 getetag（只返回 getlastmodified）
//   · GET **带** ETag，且该 ETag 可直接用于 If-Match
//     （正确 ETag 写 → 204；过期 ETag 写 → 412 ⇒ 真乐观锁成立）
//   · If-None-Match / WebDAV If 头 / If-Unmodified-Since 一律忽略
//
// 「PUT 不返回 ETag」这一条曾让适配器把 null 存进 manifest，
// 而那个 etag 就是**下一次写该分片的 If-Match 条件** ⇒ 退化成无条件覆盖 ⇒
// 坚果云明明支持乐观锁，我们却在裸写。这是「以为有锁」而非「没有锁」。

describe('2026-10-14 坚果云形态：PUT 不返 ETag 时读回一个', () => {
  /**
   * 模拟坚果云：PUT 响应无 ETag，但 GET / PROPFIND 都给 ETag，且 If-Match 真生效。
   *
   * ⚠️ 为什么是「包装实例」而不是继承：FakeDav 的 `fetch` 是**字段**，
   * 子类里 `super.fetch` 在字段初始化阶段拿到 undefined（第一版就这么写，
   * 3 条用例全红报 "fetch is not a function" —— 看着像实现坏了，
   * 其实是测试的继承写法错了，方向搞反会引入真 bug）。
   * 直接在实例上包一层：语义相同，且没有字段初始化顺序坑。
   */
  function jiuGuoLike(): FakeDav {
    const dav = new FakeDav();
    const base = dav.fetch;
    dav.fetch = (async (url: string | URL, init?: RequestInit) => {
      const res = await base(url, init);
      if (String(init?.method ?? 'GET') === 'PUT') {
        // 抹掉 PUT 响应的 ETag，但保留状态码（坚果云真实行为）
        return {
          status: res.status,
          ok: res.ok,
          headers: { get: () => null },
          text: async () => '',
        } as unknown as Response;
      }
      return res;
    }) as unknown as typeof fetch;
    return dav;
  }

  it('写分片后 manifest 里的 etag 非空（否则下次写退化成无条件覆盖）', async () => {
    const dav = jiuGuoLike();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5 } })]);

    const manifest = JSON.parse(dav.read(M)!.body) as { shards: Array<{ id: string; etag?: string }> };
    const entry = manifest.shards.find(s => s.id === 'aa1');
    assert.ok(entry, '条目必须在');
    assert.ok(
      typeof entry!.etag === 'string' && entry!.etag.length > 0,
      `manifest 必须存到 ETag（PUT 不返回时要读回），实际 ${JSON.stringify(entry!.etag)}`
    );
  });

  it('读回的 ETag 能被下一次写真正用上（If-Match 真生效，不是摆设）', async () => {
    const dav = jiuGuoLike();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5 } })]);

    // 第二次改同一会话：必须带 If-Match（老版本无 etag 时不会带）
    const out = await adapter.uploadGroups([makeGroup('aa1', { name: 'v2', lastOp: { d: 'dev-A', s: 9 } })]);
    assert.equal(out.writtenIds.length, 1, '应写入成功');
    const usedIfMatch = dav.calls.some(
      c => c.method === 'PUT' && c.path.includes('/aa1.json') && c.headers['if-match']
    );
    assert.ok(usedIfMatch, '第二次写必须带 If-Match —— 缺它等于没有并发保护');
  });

  it('服务端忽略 If-Match 时（dufs 形态）往返仍可用（降级不崩）', async () => {
    const dav = jiuGuoLike();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5 } })]);
    const out = await adapter.uploadGroups([makeGroup('aa1', { name: 'v2', lastOp: { d: 'dev-A', s: 9 } })]);
    assert.equal(out.writtenIds.length, 1);
    assert.equal((await adapter.downloadGroups())[0]?.name, 'v2');
  });
});

// ── PERF-01：写路径的往返放大（2026-10-24 审计）────────────────────────
//
// ── 这条防的具体事故 ────────────────────────────────────────────────────
//
// 写一个分片要逐级建目录（库根 → groups → 前 2 位前缀目录）。修复前每轮上传
// 都对**每个会话**把整条链重发一遍（`client.mkdirp`）：
//
//   · 生产会话 id 是 nanoid（21 位、64 字符表）⇒ 前 2 位有 4096 种取值
//     ⇒ 1000 个会话约 884～899 个不同前缀目录；
//   · 其中绝大部分 MKCOL 打的是**早已存在**的目录（必然 405 的空请求），
//     而且**全程串行**。
//
// 实测（真实 WebDavClient 打真实服务器，2026-10-24）：写一个会话要
// **6.89～7.91 次串行往返**（下载同库只要 1.00 次）⇒ 1000 个会话一轮上传
// ≈ 6900～7900 次往返 ⇒ 用户看到的是「推送失败：操作超时（30 秒）」，
// 而后台其实还在继续传。
//
// 修复：目录链**每级每个适配器实例最多建一次**（knownDirs 缓存）。
//
// ── 为什么必须开 strictParents ─────────────────────────────────────────
//
// 「目录链有没有被正确建出来」这件事，宽松的假服务器**看不见**：
// MKCOL / PUT 一律成功 ⇒ 少了库根、少了中间层，测试照样全绿 ⇒ 缺陷一路溜到
// 真机才炸（真服务端：父目录不存在 ⇒ 409）。
// ⇒ 这条守卫用 strictParents 的服务器：目录链少建一级，第一次写就 409。

describe('PERF-01：写路径的 MKCOL 放大', () => {
  /** N 个会话，前 2 位各不相同（N 个前缀桶，模拟 nanoid 的真实分布）。 */
  function makePrefixedGroups(n: number): ReturnType<typeof makeGroup>[] {
    return Array.from({ length: n }, (_, i) =>
      makeGroup(`${String(i).padStart(2, '0')}${i}-${'x'.repeat(16)}`)
    );
  }

  it('上传 N 个会话时，MKCOL 次数 ≤ 前缀桶数 + 2（不再每个会话重发整条链）', async () => {
    const dav = new FakeDav();
    dav.strictParents = true; // 父目录必须存在（RFC 4918）
    const { adapter } = makeAdapter(dav);

    const N = 20;
    const groups = makePrefixedGroups(N);

    const out = await adapter.uploadGroups(groups);
    assert.equal(out.writtenIds.length, N, '前提：N 个会话都写上去了');

    const mkcols = dav.calls.filter(c => c.method === 'MKCOL');
    const buckets = new Set(groups.map(g => g.id.slice(0, 2)));
    assert.equal(
      buckets.size,
      N,
      '前提：这 N 个会话的前缀各不相同（否则这条守卫没有检测力）'
    );
    assert.ok(
      mkcols.length <= buckets.size + 2,
      `MKCOL 次数 ${mkcols.length} 超过上限 ${buckets.size + 2}` +
        '（库根 + groups + 每个前缀目录各一次）—— 目录缓存失效了，' +
        '写路径把整条链重发了一遍 ⇒ 往返次数按会话数线性放大'
    );
  });

  it('同一个目录不会被 MKCOL 两次（缓存的精确契约）', async () => {
    const dav = new FakeDav();
    dav.strictParents = true;
    const { adapter } = makeAdapter(dav);

    await adapter.uploadGroups(makePrefixedGroups(12));

    const paths = dav.calls.filter(c => c.method === 'MKCOL').map(c => c.path);
    const dup = paths.filter((p, i) => paths.indexOf(p) !== i);
    assert.deepEqual(
      [...new Set(dup)],
      [],
      '同一个目录被 MKCOL 了多次 —— 目录缓存没有生效'
    );
  });

  it('目录链真的被建出来了（严格服务器：父目录不存在就 409）', async () => {
    const dav = new FakeDav();
    dav.strictParents = true;
    const { adapter } = makeAdapter(dav);

    // 这条在 strictParents 下能过，靠的就是「库根 → groups → 前缀目录」
    // 每一级都被建出来。若某一级没建 ⇒ PUT 409 ⇒ 上传直接失败。
    await adapter.uploadGroups([makeGroup('zz-1')]);

    assert.ok(dav.dirs.has('TapStack'), '库根必须被建出来');
    assert.ok(dav.dirs.has('TapStack/groups'), 'groups 目录必须被建出来');
    assert.ok(dav.dirs.has('TapStack/groups/zz'), '前缀目录必须被建出来');
  });

  it('目录被人从服务器上删掉后，下一次写能自愈（缓存过期不会把本机锁死）', async () => {
    const dav = new FakeDav();
    dav.strictParents = true;
    const { adapter } = makeAdapter(dav);

    await adapter.uploadGroups([makeGroup('ab-1')]);
    assert.ok(dav.dirs.has('TapStack/groups/ab'));

    // 模拟「云盘上的目录被人删了」（缓存还在 ⇒ 适配器以为它还在）。
    dav.dirs.delete('TapStack/groups/ab');

    const out = await adapter.uploadGroups([
      // 同一个前缀 ⇒ 命中已缓存的目录 ⇒ 第一次 PUT 会 409。
      // stamp 必须比上一轮的水位新，否则会被增量逻辑跳过（压根不写）。
      makeGroup('ab-2', { lastOp: { d: 'dev-A', s: 20 } }),
    ]);
    assert.equal(out.writtenIds.length, 1, '目录被删后必须自愈，而不是从此传不上去');
    assert.ok(dav.dirs.has('TapStack/groups/ab'), '前缀目录必须被重建');
  });
});
