// D-4 / D-5 的**运行时**回归（2026-10-20）：真适配器 + 内存 WebDAV 服务器。
//
// 与 tests/backendParityDefects.test.ts 的分工：那边钉「判据存在且被用上」
// （源码结构 + 纯函数行为），这边钉「**行为真的变了**」——
//   D-4：索引与分片脱节时，裁决必须听分片的；
//   D-4：服务端忽略条件写时，必须走「读-比-写」而不是裸 PUT；
//   D-5：墓碑写完读回不一致时必须抛错（⇒ 上层不清删除队列）。
//
// 断言的是**不变量**（「云端更新的版本不被旧内容覆盖」「删除意图不被消费」），
// 不是字面量。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const { WebDavClient } = await import('@/sync-backend/webdav/client');
const { WebDavBackendAdapter } = await import('@/sync-backend/webdav/adapter');
const { shardPath, parseEnvelope } = await import('@/sync-backend/webdav/layout');
const { LEGACY_KEYS } = await import('@/storage-kv/keys');

const BASE = 'https://dav.example.com/dav/';
const NOW = '2026-10-20T10:00:00.000Z';
const M = 'TapStack/manifest.json';
/**
 * 测试用的加密口令（2026-10-24 审计 SEC-1）。
 *
 * 新建加密库时**必须**够强（`webdav/passphrasePolicy.ts`），否则适配器会
 * 在建库那一刻抛错。所以这里的口令换成了真正能用的长口令 ——
 * 它不是被测对象，只是「一把正常的钥匙」。
 */
const PASSPHRASE = 'correct horse battery staple';


interface StoredFile {
  body: string;
  etag: string;
}

/**
 * 内存 WebDAV 服务器。
 *
 * 与 tests/webdavAdapter.test.ts 的 FakeDav 相比，这里多了两个**故障注入**：
 *   · `ignoreConditionalWrites` —— 服务端忽略 If-Match（dufs 0.46 的真实形态）；
 *   · `putReturns2xxButDrops` —— 服务端**返回 2xx 却不落盘**（删除广播的读回校验
 *     就是为了接住这一种）。
 */
class FakeDav {
  files = new Map<string, StoredFile>();
  dirs = new Set<string>();
  calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  ignoreConditionalWrites = false;
  /** 置 true 后，PUT 返回 201 但**不写盘**（模拟「返回 2xx 而内容没落盘」）。 */
  putReturns2xxButDrops = false;
  etagSeq = 0;

  private key(path: string): string {
    return path.replace(BASE, '').replace(/\/+$/, '');
  }

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = this.key(String(url));
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
      return respond(200, f.body, { ETag: f.etag });
    }
    if (method === 'PUT') {
      const existing = this.files.get(path);
      const ifMatch = headers['if-match'];
      const ifNoneMatch = headers['if-none-match'];
      if (!this.ignoreConditionalWrites) {
        if (ifMatch && (!existing || existing.etag !== ifMatch)) return respond(412);
        if (ifNoneMatch === '*' && existing) return respond(412);
      }
      const etag = `"e${++this.etagSeq}"`;
      if (!this.putReturns2xxButDrops) {
        this.files.set(path, { body: String(init?.body ?? ''), etag });
        const parent = path.split('/').slice(0, -1).join('/');
        if (parent) this.dirs.add(parent);
      }
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

function makeKv(seed: Record<string, unknown> = {}) {
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

function makeAdapter(dav: FakeDav, opts: { deviceId?: string; deviceSeq?: number } = {}) {
  const kv = makeKv({ [LEGACY_KEYS.DEVICE_ID]: opts.deviceId ?? 'dev-A' });
  const client = new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
  const adapter = new WebDavBackendAdapter({
    client,
    config: { baseUrl: BASE, username: 'u', password: 'p', rootPath: 'TapStack', passphrase: PASSPHRASE },
    kv,
    now: () => NOW,
    peekDeviceSeq: async () => opts.deviceSeq ?? 0,
  });
  return { kv, adapter };
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

/** 读远端分片外壳的明文头部（不需要解密）。 */
function readHeader(dav: FakeDav, id: string) {
  const raw = dav.read(`TapStack/${shardPath(id)}`);
  assert.ok(raw, `分片 ${id} 不存在`);
  const env = parseEnvelope(raw.body);
  assert.ok(env, `分片 ${id} 的外壳无法解析`);
  return env.hdr;
}

// ════════════════════════════════════════════════════════════════════
// D-4：裁决读分片，不读索引
// ════════════════════════════════════════════════════════════════════

describe('D-4：索引落后于分片时，裁决必须听分片的', () => {
  it('索引记着旧印记、分片是新版本 → 旧内容不许覆盖新版本', async () => {
    const dav = new FakeDav();
    const { adapter: seeder } = makeAdapter(dav, { deviceId: 'dev-A' });
    // 设备 A 上传 s=100 的新版本（分片 + 索引都写成功）。
    await seeder.uploadGroups([makeGroup('aa1', { name: '新版本', lastOp: { d: 'dev-A', s: 100 } })]);

    // 模拟「分片写成功、索引写失败」：把索引里的印记改回旧的 s=50。
    const manifest = JSON.parse(dav.read(M)!.body);
    manifest.shards = manifest.shards.map((s: { id: string }) =>
      s.id === 'aa1' ? { ...s, lastOp: { d: 'dev-A', s: 50 } } : s
    );
    dav.write(M, JSON.stringify(manifest));

    // 设备 B 手里是 s=200（比分片的新）⇒ 应当上行并覆盖（本地更新）。
    const { adapter: b } = makeAdapter(dav, { deviceId: 'dev-B' });
    const out = await b.uploadGroups([makeGroup('aa1', { name: 'B 的新版本', lastOp: { d: 'dev-B', s: 200 } })]);

    assert.equal(out.writtenIds.length, 1, '本地印记更新 ⇒ 应当写入');
    const after = await b.downloadGroups();
    assert.equal(after[0]?.name, 'B 的新版本', '本地更新的内容必须真的写上去');
  });

  it('索引记着新印记、分片其实是旧版本 → 旧内容不许覆盖（裁决听分片）', async () => {
    const dav = new FakeDav();
    const { adapter: seeder } = makeAdapter(dav, { deviceId: 'dev-A' });
    await seeder.uploadGroups([makeGroup('aa1', { name: '新版本', lastOp: { d: 'dev-A', s: 100 } })]);

    // 模拟反向脱节：分片被换成旧版本（s=50），而索引还记着 s=100。
    // 设备 B 手里是 s=60（比**分片**新、但比**索引**旧）。
    //   · 读索引 ⇒ 判「远端 s=100 更新」⇒ B 认输（错的：远端其实只有 s=50）
    //   · 读分片 ⇒ 判「本地 s=60 更新」⇒ B 应当写入
    const env = parseEnvelope(dav.read(`TapStack/${shardPath('aa1')}`)!.body);
    assert.ok(env && env.kind === 'plain' || env?.kind === 'encrypted');
    // 直接改盘：把分片换成 s=50 的版本（明文库，直接改载荷）。
    const { adapter: plain } = makeAdapter(dav, { deviceId: 'dev-A' });
    await plain.uploadGroups([makeGroup('bb2')]); // 建库

    // 重新来一遍：明文模式便于直接改分片内容。
    const dav2 = new FakeDav();
    const { adapter: seeder2 } = makeAdapter(dav2, { deviceId: 'dev-A' });
    await seeder2.uploadGroups([makeGroup('cc3', { name: '新版本', lastOp: { d: 'dev-A', s: 100 } })]);

    // 把分片替换成 s=50 的旧版本（模拟「分片被回退、索引没跟上」）。
    const old = makeGroup('cc3', { name: '旧版本', lastOp: { d: 'dev-A', s: 50 } });
    const vaultEnv = parseEnvelope(dav2.read(`TapStack/${shardPath('cc3')}`)!.body);
    assert.ok(vaultEnv);
    // 加密库不能直接改载荷 ⇒ 用同一适配器把旧版本写回去（当远端被回退）。
    const { adapter: rollback } = makeAdapter(dav2, { deviceId: 'dev-A' });
    await rollback.uploadGroups([old], { overwriteRemote: true });
    // 覆盖写会把索引也一起改回 s=50 ⇒ 再把索引手工改回 s=100（脱节现场）。
    const m2 = JSON.parse(dav2.read(M)!.body);
    m2.shards = m2.shards.map((s: { id: string }) =>
      s.id === 'cc3' ? { ...s, lastOp: { d: 'dev-A', s: 100 } } : s
    );
    dav2.write(M, JSON.stringify(m2));

    // 设备 B 手里 s=60：比分片(s=50)新、比索引(s=100)旧 ⇒ 必须听分片 ⇒ 写入。
    const { adapter: b2 } = makeAdapter(dav2, { deviceId: 'dev-B' });
    const out2 = await b2.uploadGroups([makeGroup('cc3', { name: 'B 的版本', lastOp: { d: 'dev-B', s: 60 } })]);
    assert.equal(out2.writtenIds.length, 1, '裁决必须听分片：本地 s=60 比分片 s=50 新 ⇒ 应当写入');
  });

  it('分片必须带明文头部（不加密也能读出印记）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 77 } })]);
    const hdr = readHeader(dav, 'aa1');
    assert.ok(hdr, '分片外壳必须带头部');
    assert.equal(hdr?.id, 'aa1');
    assert.equal(hdr?.lastOp?.s, 77, '头部必须带分片自己的印记');
  });
});

// ════════════════════════════════════════════════════════════════════
// D-4：条件写能力必须参与策略
// ════════════════════════════════════════════════════════════════════

describe('D-4：服务端忽略条件写时，必须走读-比-写', () => {
  it('探针 false ⇒ 写分片时**不发** If-Match（发了只是「看起来有锁」）', async () => {
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    // 先建库（第一次写没有 If-Match，只有 If-None-Match）。
    await adapter.uploadGroups([makeGroup('aa1')]);
    // 再改同一个会话 —— 这一轮**有**已知的远端 ETag，If-Match 才有意义。
    await adapter.uploadGroups([makeGroup('aa1', { name: 'v2', lastOp: { d: 'dev-A', s: 20 } })]);

    const groupPuts = dav.calls.filter(c => c.method === 'PUT' && c.path.includes('/groups/'));
    assert.ok(groupPuts.length >= 2, '本轮必须有分片写入');
    for (const put of groupPuts) {
      assert.equal(
        put.headers['if-match'],
        undefined,
        `服务端忽略条件写时不得发 If-Match（实际发了：${put.headers['if-match'] ?? ''}）`
      );
    }
  });

  it('探针 false 时仍能正确覆盖（不能因为不发条件头就写不进去）', async () => {
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1', { name: 'v1', lastOp: { d: 'dev-A', s: 10 } })]);
    const out = await adapter.uploadGroups([
      makeGroup('aa1', { name: 'v2', lastOp: { d: 'dev-A', s: 20 } }),
    ]);
    assert.equal(out.writtenIds.length, 1, '本地更新必须写上去');
    const after = await adapter.downloadGroups();
    assert.equal(after[0]?.name, 'v2');
  });

  it('探针 true ⇒ 仍然发 If-Match（真乐观锁不能被关掉）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);
    await adapter.uploadGroups([makeGroup('aa1', { name: 'v2', lastOp: { d: 'dev-A', s: 20 } })]);

    const groupPuts = dav.calls.filter(c => c.method === 'PUT' && c.path.includes('/groups/'));
    assert.ok(
      groupPuts.some(p => p.headers['if-match']),
      '支持条件写的服务端上，改已存在的分片必须带 If-Match（真乐观锁不能被关掉）'
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// D-5：墓碑写完必须读回确认
// ════════════════════════════════════════════════════════════════════

describe('D-5：墓碑写完必须读回确认', () => {
  it('正常路径：读回确认通过，广播成功', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);
    await adapter.broadcastDeletes(['aa1']); // 不抛错 = 读回确认通过
    const groups = await adapter.downloadGroups();
    assert.equal(groups[0]?.isDeleted, true, '墓碑必须真的落盘');
  });

  it('服务端「返回 2xx 却没落盘」⇒ 必须抛错（⇒ 上层不清删除队列）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);

    // 现在服务端开始「假装写成功」：PUT 回 201 但不落盘。
    dav.putReturns2xxButDrops = true;
    await assert.rejects(
      () => adapter.broadcastDeletes(['aa1']),
      /删除广播/,
      '写没落盘必须抛错 —— 上层据此不消费删除队列'
    );
  });

  it('服务端忽略条件写时，墓碑仍必须读回确认', async () => {
    const dav = new FakeDav();
    dav.ignoreConditionalWrites = true;
    const { adapter } = makeAdapter(dav);
    await adapter.uploadGroups([makeGroup('aa1')]);
    await adapter.broadcastDeletes(['aa1']);
    const groups = await adapter.downloadGroups();
    assert.equal(groups[0]?.isDeleted, true);
  });
});

// ════════════════════════════════════════════════════════════════════
// DS-3（2026-10-24 审计 P0）：云端墓碑不得被另一台设备的离线编辑覆盖
// ════════════════════════════════════════════════════════════════════
//
// 这条是**端到端**的：真适配器 + 内存 WebDAV，走完整的
// 「上传 → 删除广播 → 另一台设备上传」链路。
// 只测纯函数（tests/guards/tombstoneBeatsEdit.test.ts）不够 —— 那三条判据
// 里的任何一条**没被真正接线**到适配器上，纯函数测试照样全绿。
describe('DS-3：另一台设备的离线编辑不得撤销云端墓碑', () => {
  it('设备 B 的本地活跃副本不得盖掉设备 A 已经广播的墓碑', async () => {
    const dav = new FakeDav();

    // 设备 A：上传一份会话，然后删掉它（墓碑落盘，印记 = max(设备 seq+1, 云端 seq+1)）
    const { adapter: a } = makeAdapter(dav, { deviceId: 'dev-A', deviceSeq: 10 });
    await a.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 10 } })]);
    await a.broadcastDeletes(['aa1']);

    // 设备 B：离线期间改过同一会话，印记**比墓碑更新**（旧语义下 B 会赢 ⇒ 删除被撤销）
    const { adapter: b } = makeAdapter(dav, { deviceId: 'dev-B', deviceSeq: 999 });
    const out = await b.uploadGroups([
      makeGroup('aa1', { name: 'B 的离线编辑', lastOp: { d: 'dev-B', s: 999 } }),
    ]);

    assert.equal(out.writtenIds.length, 0, 'B 必须认输（不上行）—— 删除优先于编辑');
    const groups = await b.downloadGroups();
    assert.equal(groups[0]?.isDeleted, true, '云端仍是墓碑：删除没有被另一台设备的离线编辑撤销');
    assert.notEqual(groups[0]?.name, 'B 的离线编辑', '墓碑内容不得被 B 的版本顶掉');
  });

  it('墓碑比本地印记旧时同样不得被覆盖（方向无关）', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav, { deviceId: 'dev-A', deviceSeq: 5000 });
    await a.uploadGroups([makeGroup('aa1', { lastOp: { d: 'dev-A', s: 5000 } })]);
    await a.broadcastDeletes(['aa1']);

    // 设备 B 的印记比墓碑**旧**（墓碑号 = 5001）
    const { adapter: b } = makeAdapter(dav, { deviceId: 'dev-B', deviceSeq: 3 });
    const out = await b.uploadGroups([
      makeGroup('aa1', { name: 'B 的旧副本', lastOp: { d: 'dev-B', s: 3 } }),
    ]);

    assert.equal(out.writtenIds.length, 0, '墓碑一律赢，与印记大小无关');
    const groups = await b.downloadGroups();
    assert.equal(groups[0]?.isDeleted, true, '云端仍是墓碑');
  });
});
