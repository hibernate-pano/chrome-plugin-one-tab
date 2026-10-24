/**
 * WebDAV 适配器：云端索引（manifest）丢失后的恢复路径（2026-10-20 修 P0）。
 *
 * ── 这组测试钉住的不变量 ────────────────────────────────────────────────
 * 1. **「索引丢了」≠「远端空了」**：云端还有分片文件时，一次上传**不得**
 *    把索引换成本机的子集（那会让别的设备的会话对所有人隐形，且不可逆）。
 * 2. **远端确实为空** ⇒ 仍然是合法的首次同步起点（全量上行）。
 * 3. **索引坏了（解析不了）** ⇒ 仍然抛错（「坏了」与「空」必须分开）。
 * 4. **水位线不能把「被索引丢掉」的组当已同步**：那份差异要被揪出来、
 *    补传、并如实上报。
 * 5. **索引与实际文件不一致** ⇒ 中止本轮并把「索引不可信」暴露出去。
 *
 * 断言钉的是**不变量**（集合关系、文件是否还在、是否抛错），
 * 不是某个字面量 —— 换一种实现只要守住不变量，测试就该还绿。
 *
 * 变异验证口径见提交信息：把「404 ⇒ 空库」改回去，这些测试必须变红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebDavClient } from '../src/sync-backend/webdav/client.ts';
import { WebDavBackendAdapter, type AdapterKv } from '../src/sync-backend/webdav/adapter.ts';
import { shardPath } from '../src/sync-backend/webdav/layout.ts';
import { LEGACY_KEYS } from '../src/storage-kv/keys.ts';
import type { TabGroup } from '../src/types/tab.ts';

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


// ── 内存 WebDAV 服务器（与 tests/webdavAdapter.test.ts 同款，含列目录）────

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
        if (this.disableDepthOne) return respond(405); // 服务器拒绝 Depth:1
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
  /** 模拟「索引丢了」：直接把 manifest.json 删掉（分片文件留着）。 */
  removeIndex(): void {
    this.files.delete(M);
  }
  /**
   * 模拟「服务器不支持 PROPFIND Depth:1」（405）。
   * 这种服务器上**列不出目录** —— 而「列不出」绝不等于「目录是空的」。
   */
  disableDepthOne = false;
  /** 模拟「分片也丢了」：删掉某个会话的分片文件。 */
  removeShard(id: string): void {
    this.files.delete(`TapStack/${shardPath(id)}`);
  }
  /** 读出索引里的会话 id 集合。 */
  indexIds(): string[] {
    const raw = this.files.get(M);
    if (!raw) return [];
    const parsed = JSON.parse(raw.body) as { shards?: Array<{ id: string }> };
    return (parsed.shards ?? []).map(s => s.id).sort();
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

function makeAdapter(
  dav: FakeDav,
  opts: {
    passphrase?: string | null;
    kv?: ReturnType<typeof makeKv>;
    deviceSeq?: number;
    deviceId?: string;
  } = {}
) {
  const kv = opts.kv ?? makeKv({ [LEGACY_KEYS.DEVICE_ID]: opts.deviceId ?? 'dev-A' });
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

// ── 场景 1：索引丢了，但分片还在 ───────────────────────────────────────

describe('索引丢了 ≠ 远端空了（2026-10-20 修 P0）', () => {
  it('manifest 丢失 + 分片还在 ⇒ 重建索引（下载能看到全部会话）', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);
    const { adapter: b } = makeAdapter(dav, { deviceId: 'dev-B' });
    await b.uploadGroups([makeGroup('s4'), makeGroup('s5')]);

    assert.equal(dav.indexIds().length, 5, '前置条件：索引里有 5 个会话');

    // 索引丢了（第三方同步客户端冲突 / 分片写成功但索引写失败 / 用户整理目录）
    dav.removeIndex();

    // 下载必须能看到**全部**会话 —— 不能因为索引没了就只剩本机能看到的部分。
    const { adapter: reader } = makeAdapter(dav);
    const groups = await reader.downloadGroups();
    const ids = groups.map(g => g.id).sort();
    assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5'], '索引丢了也不能少给会话');

    // 探活指纹同样要能列全（否则上层会误判「云端没变」而跳过下载）。
    const prints = await reader.fetchFingerprints();
    assert.equal(prints.length, 5, '探活指纹必须覆盖云端全部会话');
    for (const p of prints) {
      assert.ok(typeof p.updatedAt === 'string' && p.updatedAt.length > 0, '指纹必须带时间戳');
    }
  });

  it('manifest 丢失 + 分片还在 ⇒ 上传时重建索引，不得把云端换成本机子集', async () => {
    const dav = new FakeDav();
    const kvA = makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' });
    const { adapter: a } = makeAdapter(dav, { kv: kvA });
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);
    const { adapter: b } = makeAdapter(dav, { deviceId: 'dev-B' });
    await b.uploadGroups([makeGroup('s4'), makeGroup('s5')]);

    const before = dav.indexIds();
    assert.equal(before.length, 5, '前置条件：索引里有 5 个会话');

    // 索引丢了
    dav.removeIndex();

    // 设备 A（只有 s1..s3）再上传一次。
    // 缺陷形态下这里会判定「远端是空库」⇒ 全量覆盖 ⇒ s4/s5 从索引里消失。
    const { adapter: a2 } = makeAdapter(dav, { kv: kvA });
    await a2.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);

    const after = dav.indexIds();
    assert.deepEqual(
      after,
      before,
      '索引丢失后重建出来的索引必须与丢失前一致（云端子集不得覆盖云端全集）'
    );
    for (const id of ['s4', 's5']) {
      assert.ok(dav.read(`TapStack/${shardPath(id)}`), `${id} 的分片文件不能被删掉`);
    }
  });

  it('加密库的索引丢了也能重建（salt 从分片外壳里找回）', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav, { passphrase: PASSPHRASE });
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2')]);
    // 分片是密文（外壳里带着库 salt）
    const raw = dav.read(`TapStack/${shardPath('s1')}`)!.body;
    assert.ok(raw.includes('"enc"'), '前置条件：分片是加密的');

    dav.removeIndex();

    const { adapter: reader } = makeAdapter(dav, { passphrase: PASSPHRASE });
    const groups = await reader.downloadGroups();
    assert.deepEqual(groups.map(g => g.id).sort(), ['s1', 's2'], '加密库也必须能重建索引');
  });

  it('加密库的索引丢了、又没有口令 ⇒ 中止（绝不按空库处理）', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav, { passphrase: PASSPHRASE });
    await a.uploadGroups([makeGroup('s1')]);
    dav.removeIndex();

    const { adapter: noPass } = makeAdapter(dav, { passphrase: null });
    await assert.rejects(() => noPass.downloadGroups(), /没有口令|索引/);
    // 关键：不能返回空数组（那 = 「云端被清空」）
    const groups = await noPass.downloadGroups().catch(() => null);
    assert.notDeepEqual(groups, [], '重建不出来时不能返回空库');
  });
});

// ── 场景 1b：目录列不出来（≠ 目录是空的） ──────────────────────────────

describe('「列不出来」≠「目录是空的」', () => {
  it('服务器不支持 Depth:1 ⇒ 索引丢了就中止，绝不按空库处理', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2')]);
    dav.removeIndex();
    // 这台服务器不支持列目录 ⇒ 我们**不知道**云端还有什么。
    dav.disableDepthOne = true;

    const { adapter: reader } = makeAdapter(dav);
    // 绝不能返回空数组（那 = 「云端被清空」⇒ 上层会把本地清空）。
    const groups = await reader.downloadGroups().catch((e: Error) => {
      assert.match(e.message, /索引|目录/, '必须明确说出「索引丢了 / 目录列不出来」');
      return null as never;
    });
    assert.notDeepEqual(groups, [], '列不出来时不能返回空库');
  });

  it('服务器不支持 Depth:1 ⇒ 首次同步仍然能走（不该被列目录能力卡死）', async () => {
    const dav = new FakeDav();
    dav.disableDepthOne = true;
    const { adapter } = makeAdapter(dav);
    const out = await adapter.uploadGroups([makeGroup('s1'), makeGroup('s2')]);
    assert.equal(out.writtenIds.length, 2, '空库首次同步不该依赖列目录');
    for (const id of ['s1', 's2']) {
      assert.ok(dav.read(`TapStack/${shardPath(id)}`), `${id} 未落盘`);
    }
  });
});

// ── 场景 2：远端确实为空 ───────────────────────────────────────────────

describe('远端确实为空 ⇒ 仍然是合法的首次全量', () => {
  it('空库 ⇒ 首次全量上传（所有本地会话都上得去）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    const groups = [makeGroup('s1'), makeGroup('s2'), makeGroup('s3')];

    const out = await adapter.uploadGroups(groups);
    assert.equal(out.writtenIds.length, 3, '空库 ⇒ 全部本地会话都该上行');
    for (const g of groups) {
      assert.ok(dav.read(`TapStack/${shardPath(g.id)}`), `${g.id} 未落盘`);
    }
    assert.deepEqual(dav.indexIds(), ['s1', 's2', 's3'], '索引里应当是全部会话');
  });

  it('空库 ⇒ 探活与下载都返回空（不是错误）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav);
    assert.deepEqual(await adapter.fetchFingerprints(), []);
    assert.deepEqual(await adapter.downloadGroups(), []);
  });
});

// ── 场景 3：索引坏了（解析不了） ───────────────────────────────────────

describe('索引坏了 ⇒ 仍然抛错（「坏了」≠「空」）', () => {
  it('manifest 存在但解析不了 ⇒ 抛错，不返回空库', async () => {
    const dav = new FakeDav();
    dav.write(M, '{ 这不是合法 JSON');
    const { adapter } = makeAdapter(dav);
    await assert.rejects(() => adapter.fetchFingerprints(), /无法解析/);
    await assert.rejects(() => adapter.downloadGroups(), /无法解析/);
    await assert.rejects(() => adapter.uploadGroups([makeGroup('s1')]), /无法解析/);
  });

  it('加密库缺 salt ⇒ 抛错（形状对但语义自相矛盾）', async () => {
    const dav = new FakeDav();
    dav.write(M, JSON.stringify({ v: 1, generatedAt: NOW, encrypted: true, shards: [] }));
    const { adapter } = makeAdapter(dav);
    await assert.rejects(() => adapter.fetchFingerprints(), /缺少密钥参数/);
  });
});

// ── 场景 4（F4）：水位线不能把「被索引丢掉」的组当已同步 ────────────────

describe('水位线骗人时，差异必须被揪出来并补传', () => {
  it('本地水位线以为已上传、云端其实没有 ⇒ 强制补传并上报', async () => {
    const dav = new FakeDav();
    // 设备 B 先把 s1..s3 传上去（水位线记下「都传过了」）
    const kvB = makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-B' });
    const { adapter: b } = makeAdapter(dav, { kv: kvB, deviceId: 'dev-B' });
    await b.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);
    assert.equal(dav.indexIds().length, 3, '前置条件：云端有 3 个会话');

    // 索引丢了，且 s2/s3 的分片也没了（第三方同步客户端冲突的残留）
    dav.removeIndex();
    dav.removeShard('s2');
    dav.removeShard('s3');

    // 设备 B 再上传一次：水位线说「都传过了」⇒ 常规增量会**跳过** s2/s3。
    const { adapter: b2 } = makeAdapter(dav, { kv: kvB, deviceId: 'dev-B' });
    const out = await b2.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);

    // 差异必须被上报（不静默跳过）
    assert.ok(out.recoveredIds, '必须上报被找回的会话 id');
    assert.deepEqual([...(out.recoveredIds ?? [])].sort(), ['s2', 's3'], '差异必须如实上报');

    // 而且必须真的补传上去了
    assert.deepEqual(dav.indexIds(), ['s1', 's2', 's3'], '缺掉的会话必须回到云端索引里');
    for (const id of ['s2', 's3']) {
      assert.ok(dav.read(`TapStack/${shardPath(id)}`), `${id} 必须被补传上云`);
    }
  });
});

// ── 场景 4b：恢复态下的**其它**写索引路径也不能把云端清空 ──────────────

describe('恢复态下，写索引的每条路径都必须保住云端全集', () => {
  it('删除广播在恢复态下不得把索引写成「只剩墓碑」', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);
    dav.removeIndex();

    const { adapter: b } = makeAdapter(dav);
    await b.broadcastDeletes(['s1']);

    // 索引里必须还有 s2/s3（它们没被删，只是不该被索引丢掉）
    const ids = dav.indexIds();
    for (const id of ['s2', 's3']) {
      assert.ok(ids.includes(id), `${id} 不能因为一次删除广播就从索引里消失`);
    }
  });

  it('TTL 清理在恢复态下不得把索引写成空的', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    // 一条墓碑（updatedAt 很老 ⇒ 会被 TTL 清理）+ 两条活的
    await a.broadcastDeletes(['gone']);
    await a.uploadGroups([
      makeGroup('s1'),
      makeGroup('s2'),
    ]);
    dav.removeIndex();

    // 把墓碑的时间改老，让 TTL 真的动手（用 manifest 里的 updatedAt 不行，
    // 恢复态是从分片内容重建的，所以直接改分片文件的内容）。
    const tombPath = `TapStack/${shardPath('gone')}`;
    const raw = dav.read(tombPath)!.body;
    dav.write(tombPath, raw.replace(/2026-10-20T10:00:00.000Z/g, '2020-01-01T00:00:00.000Z'));

    const { adapter: b } = makeAdapter(dav);
    const n = await b.purgeExpiredDeletes(30);
    assert.ok(n >= 0, 'TTL 清理必须能跑完（不能抛错）');
    const ids = dav.indexIds();
    for (const id of ['s1', 's2']) {
      assert.ok(ids.includes(id), `${id} 不能因为一次 TTL 清理就从索引里消失`);
    }
  });

  it('上传设置在恢复态下不得把索引写成空的', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2')]);
    dav.removeIndex();

    const { adapter: b } = makeAdapter(dav, { passphrase: PASSPHRASE });
    await b.uploadSettings({ theme: 'dark' } as never);

    const ids = dav.indexIds();
    for (const id of ['s1', 's2']) {
      assert.ok(ids.includes(id), `${id} 不能因为一次设置上传就从索引里消失`);
    }
  });
});

// ── 场景 5（F3）：索引与实际文件不一致 ⇒ 中止本轮 ──────────────────────

describe('索引与实际分片不一致 ⇒ 中止本轮并暴露「索引不可信」', () => {
  it('云端有索引里没有的分片 ⇒ 上传后自检必须中止并把差异报出来', async () => {
    const dav = new FakeDav();
    const { adapter: a } = makeAdapter(dav);
    await a.uploadGroups([makeGroup('s1'), makeGroup('s2'), makeGroup('s3')]);
    await a.uploadGroups([makeGroup('s4', { lastOp: { d: 'dev-A', s: 20 } })]);
    assert.equal(dav.indexIds().length, 4, '前置条件：索引里有 4 个会话');

    // 第三方同步客户端把索引换成了旧版本（少一条），分片文件还在。
    const current = JSON.parse(dav.read(M)!.body) as {
      v: number;
      generatedAt: string;
      encrypted: boolean;
      salt?: string;
      shards: unknown[];
    };
    dav.write(
      M,
      JSON.stringify({ ...current, shards: current.shards.slice(0, 3) }, null, 2)
    );

    // 设备再上传一次 ⇒ 写完索引后自检必须发现「云端有 4 个分片、索引里只有 3 个」
    const { adapter: a2 } = makeAdapter(dav);
    await assert.rejects(
      () => a2.uploadGroups([makeGroup('s1', { lastOp: { d: 'dev-A', s: 20 } })]),
      /不一致|索引/
    );

    // 中止之前必须尽力把索引修回「磁盘真相」，否则下一轮还是坏的。
    assert.ok(
      dav.indexIds().includes('s4'),
      '中止之前应当把索引修好（s4 的分片文件一直都在，不能丢）'
    );
  });
});
