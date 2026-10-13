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

import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter, type AdapterKv } from '@/sync-backend/webdav/adapter';
import { shardPath } from '@/sync-backend/webdav/layout';
import type { TabGroup } from '@/types/tab';

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
      const f = this.files.get(path);
      if (!f) return respond(404);
      return respond(
        207,
        `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:getetag>${f.etag}</D:getetag></D:prop></D:propstat></D:response></D:multistatus>`
      );
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
      // 强制冲突：模拟「读到之后、写之前，别人改了」这个并发窗口。
      if (this.forcedConflicts > 0) {
        this.forcedConflicts--;
        return respond(412);
      }
      const existing = this.files.get(path);
      const ifMatch = headers['if-match'];
      const ifNoneMatch = headers['if-none-match'];
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return respond(412);
      if (ifNoneMatch === '*' && existing) return respond(412);
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
  const kv = opts.kv ?? makeKv({ device_id: 'dev-A' });
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
        passphrase: opts.passphrase === undefined ? 'pw' : opts.passphrase,
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
    const { adapter: fresh } = makeAdapter(dav, { kv: makeKv({ device_id: 'dev-B' }) });
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
    const kv = makeKv({ device_id: 'dev-A' });
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
    const { adapter: other } = makeAdapter(dav, { kv: makeKv({ device_id: 'dev-B' }), deviceSeq: 3 });
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
    await adapter.uploadSettings({ groupNameTemplate: '机密名字 %d' } as never);

    const raw = dav.read('TapStack/settings.json')!.body;
    assert.ok(!raw.includes('机密名字'), '盘上不得出现明文设置');
    assert.ok(raw.includes('"enc"'));

    const back = await adapter.downloadSettings();
    assert.equal(back?.groupNameTemplate, '机密名字 %d');
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

