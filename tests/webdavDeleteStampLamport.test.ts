// WebDAV 删除广播的印记必须由**本机 Lamport 时钟**发出（2026-10-20 D-7）。
//
// ── 本文件在防什么回归 ───────────────────────────────────────────────────
//
// 缺陷形态：删除广播的 seq 取 `cloudSeq + 1`（云端那一行已有的 seq + 1）。
// 那个数有一个致命性质：它**恰好等于对端设备下一个自然要发的号**
// （对端写下一条时也会取 cloudSeq + 1）。于是两边的 seq **完全相等** ——
// 而全序的比较（core/opStamp 的 compareStamps）在 seq 相等时**退化成比设备 id
// 的字典序**。也就是说：
//
//   「谁赢」不再由**真实因果顺序**决定，而由**设备 id 的字典序**决定。
//
// 字典序与因果无关，而且方向是任意的：设备 id 靠后的那台，它的删除**永远赢**；
// 设备 id 靠前的那台，它的删除**永远输**。后者那一组就在对端**复活**了 ——
// 云端行明明已经是墓碑，对端却判本地赢，把墓碑覆盖回活跃行。
//
// 第二个缺陷：WebDAV 侧**没有**把观察到的云端 seq 吸收进本机 Lamport 时钟
// ⇒ 本机随后发出的号可能回退到云端号以下 ⇒ 墓碑在下一轮被对端盖掉。
//
// ── 断言钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
// 钉的四条性质（都可判定、与实现写法无关）：
//
//   ① 墓碑的 seq **严格大于**被删那一行在云端的 seq
//      （压过它，否则对端合并时墓碑输给活跃副本 ⇒ 删除被撤销）；
//
//   ② 墓碑的 seq 是**本机时钟发出来的号**（断言方式：让测试的时钟记录
//      每一个发出去的号，然后要求墓碑的 seq 出现在那份记录里）。
//      这一条正是缺陷形态与修好形态的分界：
//        · 缺陷形态：墓碑的号 = 「云端 seq + 1」——**本机时钟从没发过这个号**；
//        · 修好形态：墓碑的号 = 本机时钟吸收了云端号之后自己取的那个号。
//      注意**不能**断言「墓碑的 seq ≠ 云端 seq + 1」：本机号位落后于云端时，
//      墓碑的号**合法地**就是云端 seq + 1（那是压过云端那一行的最小值）。
//      那样写就是「把守卫钉在字面量上」——它会把正确的实现也判成红的。
//
//   ③ 广播之后，本机时钟的下一个号 **严格大于**墓碑的 seq
//      （本机时钟吸收了墓碑自己的号 ⇒ 下一笔写入与墓碑**不同号**
//        ⇒ 不会退化成「同 seq ⇒ 比设备 id 字典序」）；
//
//   ④ 广播之后，本机时钟的下一个号 **严格大于**云端那一行的 seq
//      （本机时钟吸收了「它观察到的」号 ⇒ 本机随后的写入不会被守卫当成
//        「更旧」而静默吞掉 —— 那正是「WebDAV 侧没把这个 seq 吸收进本机
//        Lamport 时钟」的真实危害）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter, type AdapterKv } from '@/sync-backend/webdav/adapter';
import { shardPath } from '@/sync-backend/webdav/layout';
import { LEGACY_KEYS } from '@/storage-kv/keys';
import type { TabGroup } from '@/types/tab';

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


// ── 内存 WebDAV 服务器（够用即可：PUT/GET/PROPFIND/DELETE）──────────────

interface StoredFile {
  body: string;
  etag: string;
}

class FakeDav {
  files = new Map<string, StoredFile>();
  dirs = new Set<string>();
  etagSeq = 0;

  private key(path: string): string {
    return path.replace(BASE, '').replace(/\/+$/, '');
  }
  private parentOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }
  private childrenOf(dir: string): Array<{ path: string; isCollection: boolean; etag?: string }> {
    const out: Array<{ path: string; isCollection: boolean; etag?: string }> = [];
    for (const [p, f] of this.files) {
      if (this.parentOf(p) === dir) out.push({ path: p, isCollection: false, etag: f.etag });
    }
    for (const d of this.dirs) {
      if (d !== dir && this.parentOf(d) === dir) out.push({ path: d, isCollection: true });
    }
    return out;
  }
  private responseXml(href: string, isCollection: boolean, etag?: string): string {
    const rt = isCollection
      ? '<D:resourcetype><D:collection/></D:resourcetype>'
      : '<D:resourcetype/>';
    const etagXml = etag ? `<D:getetag>${etag}</D:getetag>` : '';
    return (
      '<D:response>' +
      `<D:href>${href}</D:href>` +
      `<D:propstat><D:prop>${rt}${etagXml}</D:prop>` +
      '<D:status>HTTP/1.1 200 OK</D:status>' +
      '</D:propstat>' +
      '</D:response>'
    );
  }

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = this.key(String(url));
    const method = String(init?.method ?? 'GET');
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
      const children = this.childrenOf(path);
      if (!this.dirs.has(path) && children.length === 0) return respond(404);
      const body =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        this.responseXml(`${BASE}${path}/`, true) +
        children.map(c => this.responseXml(`${BASE}${c.path}`, c.isCollection, c.etag)).join('') +
        '</D:multistatus>';
      return respond(207, body, { 'content-type': 'application/xml' });
    }
    if (method === 'GET') {
      const f = this.files.get(path);
      if (!f) return respond(404);
      return respond(200, f.body, { ETag: f.etag });
    }
    if (method === 'PUT') {
      const existing = this.files.get(path);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const ifMatch = headers['If-Match'] ?? headers['if-match'];
      const ifNoneMatch = headers['If-None-Match'] ?? headers['if-none-match'];
      if (ifMatch && existing && existing.etag !== ifMatch) return respond(412);
      if (ifNoneMatch === '*' && existing) return respond(412);
      const etag = `"e${++this.etagSeq}"`;
      this.files.set(path, { body: String(init?.body ?? ''), etag });
      const parent = this.parentOf(path);
      if (parent) this.dirs.add(parent);
      return respond(201, '', { ETag: etag });
    }
    if (method === 'DELETE') {
      this.files.delete(path);
      return respond(204);
    }
    return respond(405);
  }) as unknown as typeof fetch;

  read(path: string): StoredFile | undefined {
    return this.files.get(path);
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

/**
 * 模拟本机 Lamport 时钟（utils/seqRegistry 的语义）。
 *
 * 关键点：`next()` 取「当前号位 + 1」并落盘；`bump(candidate)` 只在
 * candidate 更大时抬升号位。两者的组合正是 D-7 要考的那条不变式。
 */
function makeSeqClock(initial: number) {
  let seq = initial;
  /** 本机时钟**发出去过**的每一个号（断言「墓碑的号是不是本机发的」用）。 */
  const issued: number[] = [];
  return {
    issued,
    peek: () => seq,
    async next() {
      seq += 1;
      issued.push(seq);
      return seq;
    },
    async bump(candidate: number) {
      if (candidate > seq) seq = candidate;
      return seq;
    },
  };
}

function makeGroup(id: string, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `会话 ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: 'dev-B', s: 100 },
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

/**
 * 造一个适配器，带可观测的 Lamport 时钟。
 *
 * @param localSeqStart 本机时钟的初始号位
 * @param cloudSeq     云端那一行已有的 seq（= 对端发过的号）
 */
function makeAdapter(dav: FakeDav, opts: { localSeqStart?: number; cloudSeq?: number } = {}) {
  const kv = makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' });
  const clock = makeSeqClock(opts.localSeqStart ?? 5);
  const client = new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
  const adapter = new WebDavBackendAdapter({
    client,
    config: {
      baseUrl: BASE,
      username: 'u',
      password: 'p',
      rootPath: 'TapStack',
      passphrase: PASSPHRASE,
    },
    kv,
    now: () => NOW,
    peekDeviceSeq: async () => clock.peek(),
    nextDeviceSeq: async () => clock.next(),
    bumpDeviceSeqIfLower: async (candidate: number) => clock.bump(candidate),
  });
  return { adapter, clock, kv };
}

/** 读回 manifest 里某个分片的 lastOp（墓碑的印记）。 */
function readManifestStamp(dav: FakeDav, id: string): { d: string; s: number } | undefined {
  const raw = dav.read(M);
  assert.ok(raw, 'manifest 必须存在（否则本用例的前提不成立）');
  const manifest = JSON.parse(raw.body);
  const shard = manifest.shards.find((s: { id: string }) => s.id === id);
  return shard?.lastOp;
}

// ══════════════════════════════════════════════════════════════════════════

describe('D-7：删除广播的印记必须由本机 Lamport 时钟发出', () => {
  it('墓碑的 seq 严格大于云端那一行的 seq（压过它，删除才可能赢）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    assert.ok(
      stamp.s > 100,
      `墓碑的 seq 必须严格大于云端那一行的 seq（100）—— 实得 ${stamp.s}。` +
        '压不过它 ⇒ 对端合并时墓碑输给活跃副本 ⇒ 删除被撤销（复活）'
    );
  });

  it('墓碑的 seq 是**本机时钟发出来的号**（不是「云端 seq + 1」凑出来的）', async () => {
    const dav = new FakeDav();
    const { adapter, clock } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    assert.ok(
      clock.issued.includes(stamp.s),
      `墓碑的 seq（${stamp.s}）必须出现在本机时钟发出去的号里（${clock.issued.join('、')}）—— ` +
        '「云端 seq + 1」那个数本机时钟**从没发过**（它是对手设备的下一个自然号）⇒ ' +
        '两边 seq 相等 ⇒ compareStamps 退化成比设备 id 字典序 ⇒ 删除的胜负由' +
        '设备 id 决定而不是由因果顺序决定（= 本缺陷）'
    );
  });

  it('墓碑的 seq 严格大于本机时钟广播前的号位（号由本机时钟发出）', async () => {
    const dav = new FakeDav();
    const { adapter, clock } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);
    const before = clock.peek();

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    assert.ok(
      stamp.s > before,
      `墓碑的 seq 必须严格大于本机广播前的号位（${before}）—— 实得 ${stamp.s}。` +
        '不大于 ⇒ 这个号不是本机时钟发的 ⇒ 胜负不由因果顺序决定'
    );
  });

  it('广播之后本机时钟的下一个号严格大于墓碑的 seq（下一笔写入不得与墓碑同号）', async () => {
    const dav = new FakeDav();
    const { adapter, clock } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    const nextLocal = await clock.next();
    assert.ok(
      nextLocal > stamp.s,
      `本机下一个号（${nextLocal}）必须严格大于墓碑的 seq（${stamp.s}）—— ` +
        '相等 ⇒ 本机这笔后续写入与墓碑同 seq ⇒ 胜负退化成设备 id 字典序/平局 ⇒ ' +
        '墓碑被本机自己后来的写入盖掉（删除被静默撤销）。' +
        '这要求广播时**先吸收云端号再取号**（见 adapter 的 nextDeleteStamp 注释）'
    );
  });

  it('广播之后本机时钟的号位吸收了云端那一行的 seq（不能回退到它以下）', async () => {
    // 这条钉的是审计里的第二句：「WebDAV 侧没把这个 seq 吸收进本机 Lamport 时钟」。
    // 危害不是口号：吸收之后本机随后的写入号必然大于云端号 ⇒ 不会被服务端守卫
    // 当成「更旧」而静默吞掉；不吸收的话，本机号位可能远低于云端号
    // （换机 / 清数据 / IndexedDB 被回收），后续写入全部被判「更旧」。
    const dav = new FakeDav();
    const { adapter, clock } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    const nextLocal = await clock.next();
    assert.ok(
      nextLocal > 100,
      `本机下一个号（${nextLocal}）必须严格大于云端那一行的 seq（100）—— ` +
        '否则本机随后发出的号可能回退到云端号以下 ⇒ 墓碑在下一轮被对端盖掉（删除复活）'
    );
  });

  it('云端没有已有印记时（新会话），墓碑仍由本机时钟发号且严格大于本机号位', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { localSeqStart: 5 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-A', s: 6 } })]);

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    assert.ok(
      stamp.s > 5,
      `墓碑的 seq 必须严格大于本机初始号位（5）—— 实得 ${stamp.s}`
    );
  });

  it('墓碑带的是**本机**的设备 id（不是冒用云端那一行的设备 id）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    const stamp = readManifestStamp(dav, 'g1');
    assert.ok(stamp, '墓碑必须带印记');
    assert.equal(
      stamp.d,
      'dev-A',
      '墓碑的归属必须写**发出广播的设备**（dev-A）—— ' +
        '冒用原设备的 id 等于伪造他设备的印记：他设备真实 seq 落后时，' +
        '它自己的上传会被守卫当「更旧」拒收'
    );
  });

  it('没有注入发号器时（兜底路径），两次广播拿到的号必须**不同**', async () => {
    // 生产路径（src/sync-backend/index.ts）注入了真实的 seqRegistry，但适配器
    // 允许「不注入」——那时的兜底实现是**最后一道防线**：它坏了就等于退回
    // 缺陷形态（而且是「每次都拿到同一个号」那种更隐蔽的退化）。
    //
    // 断言方式：**可观察的行为**（两次广播的号不同），不钉内部实现
    // （「兜底持有一个号位」是实现细节，换个写法照样成立）。
    const dav = new FakeDav();
    const kv = makeKv({ [LEGACY_KEYS.DEVICE_ID]: 'dev-A' });
    const client = new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
    // 只注入 peekDeviceSeq（不注入 nextDeviceSeq / bumpDeviceSeqIfLower）
    const adapter = new WebDavBackendAdapter({
      client,
      config: {
        baseUrl: BASE,
        username: 'u',
        password: 'p',
        rootPath: 'TapStack',
        passphrase: PASSPHRASE,
      },
      kv,
      now: () => NOW,
      peekDeviceSeq: async () => 5,
    });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);
    const first = readManifestStamp(dav, 'g1');
    assert.ok(first, '墓碑必须带印记');

    await adapter.broadcastDeletes(['g2']);
    const second = readManifestStamp(dav, 'g2');
    assert.ok(second, '墓碑必须带印记');

    assert.notEqual(
      second.s,
      first.s,
      `两次广播拿到的号必须不同（实得都是 ${first.s}）—— ` +
        '兜底发号器若每次都发同一个号，两笔删除就会同 seq ⇒ 胜负退化成' +
        '设备 id 字典序/平局 ⇒ 后一笔可能盖掉前一笔的删除意图'
    );
  });

  it('墓碑分片留在盘上（它承载删除意图，不是把文件删掉）', async () => {
    const dav = new FakeDav();
    const { adapter } = makeAdapter(dav, { localSeqStart: 5, cloudSeq: 100 });
    await adapter.uploadGroups([makeGroup('g1', { lastOp: { d: 'dev-B', s: 100 } })]);

    await adapter.broadcastDeletes(['g1']);

    assert.ok(
      dav.read(`TapStack/${shardPath('g1')}`),
      '墓碑必须保留为分片文件 —— 删掉文件等于删掉删除意图（对端无从得知）'
    );
  });
});
