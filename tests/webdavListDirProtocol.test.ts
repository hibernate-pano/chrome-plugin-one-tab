// WebDAV「列目录」协议的回归防线（2026-10-20）。
//
// ── 为什么有这份文件 ──────────────────────────────────────────────────────
// 整条「索引丢了不等于远端空了」的不变量，全都架在一个字上：
// `client.listDir()` 返回的 `listed` 标志。
//   · `listed: true`  → 服务端真的列了（**可能是空的**）
//   · `listed: false` → **列不出来**（我们不知道云端有什么）
// 上层（adapter.scanRemoteShards）拿到 false 就 fail-closed（中止并如实报错）；
// 拿到 true 就把 entries 当成「云端的全部内容」。
//
// 所以：**只要 `listed` 在「正文读不懂」时谎报 true，整条防线就形同虚设** ——
// 云端明明有会话，我们却判成空库，首次同步把本机子集写上去 ⇒
// 云端内容对所有设备隐形（不可恢复）。
//
// 而修复前 `listed` 确实是会撒谎的：只要 HTTP 状态是 207/2xx，
// 无论正文是不是一份我们认得的清单，一律 `listed: true, entries: []`。
// 现实里能拿到 207 + 一份读不懂的正文的情形并不罕见：
//   · 反向代理/网关在链路上塞了 HTML 错误页（状态码仍是上游的 207）；
//   · 正文被截断（连接被重置、超长响应被切掉）—— 少列 = 静默丢数据；
//   · 服务端返回了非 multistatus 的 2xx 正文。
//
// 修复前 `grep -rn "listDir" tests/` 是**空的** —— 这条链路上一个
// 直接单测都没有，FakeDav 又恰好只吐我们自己解析器认得的 XML 形状
// （自证式）。这份文件补上这块。
//
// 断言的是**不变量**（「读不出来 ≠ 空的」「不许拿云端当空库覆盖」），
// 不是字面量。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
const { LEGACY_KEYS } = await import('@/storage-kv/keys');

const BASE = 'https://dav.example.com/dav/';
const ROOT_PATH = 'TapStack';
const NOW = '2026-10-20T10:00:00.000Z';

// ════════════════════════════════════════════════════════════════════
// 最小 DAV 服务器
// ════════════════════════════════════════════════════════════════════

interface DavFile {
  body: string;
  etag: string;
}

/**
 * 只实现本文件需要的动作：PROPFIND（Depth:0/1）、GET、PUT、MKCOL、DELETE。
 *
 * `propfindDepth1Body` 允许**替换** Depth:1 的响应正文 —— 这是本文件
 * 全部回归场景的注入点（塞 HTML 错误页、塞截断的正文、塞空 multistatus）。
 */
class TinyDav {
  files = new Map<string, DavFile>();
  dirs = new Set<string>();
  calls: Array<{ method: string; path: string; depth?: string }> = [];
  /** 覆盖 Depth:1 的响应正文；undefined = 用默认（正常生成）。 */
  propfindDepth1Body: string | undefined;
  /**
   * **按目录**覆盖 Depth:1 的响应正文。
   *
   * 为什么需要它：`listDir` 对每个目录各发一次 PROPFIND，真实服务端每次回的是
   * **那个目录**的清单。所有目录共用一份正文 ⇒ `groups/` 的清单里会混进
   * `groups/aa/` 自己的条目 —— 那是探针的假象，不是产品缺陷。
   */
  propfindDepth1BodyFor: ((path: string) => string | undefined) | undefined;
  /** 覆盖 Depth:0 的响应正文；undefined = 用默认。 */
  propfindDepth0Body: string | undefined;
  etagSeq = 0;

  private rel(url: string): string {
    return url.replace(BASE, '').replace(/\/+$/, '');
  }

  fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = this.rel(String(url));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const method = String(init?.method ?? 'GET');
    const depth = headers['depth'];
    this.calls.push({ method, path, depth });

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
      if (depth === '1') {
        const perPath = this.propfindDepth1BodyFor?.(path);
        if (perPath !== undefined) return respond(207, perPath);
        if (this.propfindDepth1Body !== undefined) return respond(207, this.propfindDepth1Body);
      }
      if (depth !== '1' && this.propfindDepth0Body !== undefined) {
        return respond(207, this.propfindDepth0Body);
      }
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
          '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>'
        );
      }
      return respond(404);
    }
    if (method === 'GET') {
      const f = this.files.get(path);
      if (!f) return respond(404);
      return respond(200, f.body, { ETag: f.etag });
    }
    if (method === 'PUT') {
      const etag = `"e${++this.etagSeq}"`;
      this.files.set(path, { body: String(init?.body ?? ''), etag });
      const parent = path.split('/').slice(0, -1).join('/');
      if (parent) this.dirs.add(parent);
      return respond(201, '', { ETag: etag });
    }
    if (method === 'MKCOL') {
      this.dirs.add(path);
      return respond(201);
    }
    if (method === 'DELETE') {
      this.files.delete(path);
      return respond(204);
    }
    return respond(405);
  }) as unknown as typeof fetch;

  seedFile(path: string, body: string): string {
    const etag = `"seed${++this.etagSeq}"`;
    this.files.set(path, { body, etag });
    return etag;
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
    // ⚠️ 这里刻意用**真机实测的原样形状**（`<D:collection xmlns:D="DAV:"/>`），
    // 而不是简化的 `<D:collection/>`。
    //
    // 2026-10-20 真机实测（scripts/prod-webdav-depth1.mjs 对 rclone serve webdav）
    // 抓到的 P0：真实服务端回的 collection 元素上**带命名空间声明属性**，
    // 而当时的判据只认 `<collection/>` / `<collection />` ⇒ 目录被判成文件
    // ⇒ 前缀目录扫不到 ⇒ 重建索引中止。
    //
    // 为什么之前 2506 条测试全绿：本文件（以及仓库里其它 FakeDav）都吐
    // `<D:collection/>` —— **恰好是旧判据唯一认得的那一种形态**，于是
    // 「用自己解析器认得的形状去测自己」形成自证式盲区。
    // 假服务器应当模拟**真实服务端**，而不是模拟我们期望的形状。
    const resourcetype = isCollection
      ? '<D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype>'
      : '<D:resourcetype></D:resourcetype>';
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

/** 只回一个固定状态码/正文的极简服务器（测状态码语义）。 */
function statusServer(status: number, body = '') {
  return (async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
  })) as unknown as typeof fetch;
}

function makeClient(dav: TinyDav) {
  return new WebDavClient({ baseUrl: BASE, username: 'u', password: 'p' }, dav.fetch);
}

function makeAdapter(dav: TinyDav) {
  const data = new Map<string, unknown>([[LEGACY_KEYS.DEVICE_ID, 'dev-A']]);
  const kv = {
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
  return new WebDavBackendAdapter({
    client: makeClient(dav),
    config: { baseUrl: BASE, username: 'u', password: 'p', rootPath: ROOT_PATH, passphrase: '' },
    kv,
    now: () => NOW,
    peekDeviceSeq: async () => 0,
  });
}

const GROUPS = `${ROOT_PATH}/groups`;
const MANIFEST = `${ROOT_PATH}/manifest.json`;

/** 一份明文分片（明文库 ⇒ 不需要口令，改盘也方便）。 */
function shardBody(id: string, name: string, stamp = 5) {
  return JSON.stringify({
    v: 1,
    plain: {
      id,
      name,
      createdAt: NOW,
      updatedAt: NOW,
      isLocked: false,
      lastOp: { d: 'other-device', s: stamp },
      tabs: [],
    },
  });
}

function localGroup(id: string, name: string) {
  return {
    id,
    name,
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: 'dev-A', s: 100 },
    tabs: [],
  };
}

// ════════════════════════════════════════════════════════════════════
// 一、listDir 的协议契约
// ════════════════════════════════════════════════════════════════════

describe('WebDAV 列目录：读不出来 ≠ 读出来是空的', () => {
  it('207 但正文是网关塞的 HTML 错误页 ⇒ 列不出来（不许当成空目录）', async () => {
    const dav = new TinyDav();
    dav.propfindDepth1Body = '<html><body><h1>502 Bad Gateway</h1></body></html>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, false, '正文读不出清单 ⇒ 必须报「列不出来」');
    assert.equal(res.entries.length, 0);
  });

  it('207 但正文被截断（multistatus 没闭合）⇒ 列不出来（少列 = 静默丢数据）', async () => {
    const dav = new TinyDav();
    // 截断的**真实形态**：前面几个 <response> 是完整的，后面被切断，
    // 根元素也没闭合。此时正文里能数出 <response> ⇒ 只看「数得出几个块」
    // 会误判成「列出来了，只是少列了几个」—— 那正是静默丢数据。
    dav.propfindDepth1Body =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>/dav/TapStack/groups/aa/</D:href></D:response>' +
      '<D:response><D:href>/dav/TapStack/groups/bb/</D:href>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, false, '正文被截断 ⇒ 我们不知道云端有什么 ⇒ 必须列不出来');
  });

  it('207 但 multistatus 里一个 <response> 都没有 ⇒ 列不出来', async () => {
    const dav = new TinyDav();
    dav.propfindDepth1Body = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, false, '数不出任何条目 ⇒ 不许当成「目录是空的」');
  });

  it('<response> 缺 <href> ⇒ 列不出来（我们不知道它指向谁，丢掉它就是静默丢数据）', async () => {
    const dav = new TinyDav();
    dav.propfindDepth1Body =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, false, '缺 href 的块必须让整次列目录判成「列不出来」');
  });

  it('目录真的为空（正文只有目录自身）⇒ 列出来了，且条目为空（不许误伤首次同步）', async () => {
    const dav = new TinyDav();
    dav.dirs.add(GROUPS);
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, true, '目录确实存在且清单读得懂 ⇒ 必须报「列出来了」');
    assert.equal(res.entries.length, 0, '目录自身不算子资源');
  });

  it('正常清单 ⇒ 列得出子资源（名字/路径/是不是目录都要对）', async () => {
    const dav = new TinyDav();
    dav.seedFile(`${GROUPS}/aa/aa1.json`, shardBody('aa1', 'A'));
    dav.dirs.add(`${GROUPS}/aa`);
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, true);
    assert.equal(res.entries.length, 1);
    const e = res.entries[0];
    assert.equal(e.name, 'aa');
    assert.equal(e.path, `${GROUPS}/aa`);
    assert.equal(e.isCollection, true, '前缀目录必须被认成目录（认错 ⇒ 分片扫不到）');
  });

  // ── 2026-10-20 真机实测抓到的 P0：<collection> 上带命名空间声明属性 ──────
  //
  // 真实服务端（rclone serve webdav，实测见 scripts/prod-webdav-depth1.mjs）
  // 回的是：
  //     <D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype>
  // —— 元素上**带命名空间声明属性**。旧判据要求 `collection` 后面只能是
  // 空白或 `/>`，遇到 ` xmlns:D="DAV:"` 直接不匹配 ⇒ 目录被判成文件。
  //
  // 后果是**静默丢数据**，不是显示问题：
  //   · `scanRemoteShards` 里 `prefixDirs = entries.filter(e => e.isCollection)`
  //     ⇒ 前缀子目录一个都不认 ⇒ 分片目录被当成「无法识别的散落文件」
  //     ⇒ 重建索引直接中止（"目录结构与本版本不符"）；
  //   · 反过来，文件若被误判成目录，就会被当成子目录去 listDir。
  //
  // 为什么之前 2506 条测试全绿：FakeDav 只吐 `<D:collection/>` ——
  // **恰好是旧正则唯一认得的那一种形态**（自证式盲区）。
  // 所以这条断言刻意用**真机实测的原样正文**，而不是 FakeDav 的简化形状。
  it('真机形态：<collection> 带命名空间声明属性也必须被认成目录', async () => {
    const dav = new TinyDav();
    dav.propfindDepth1Body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>/dav/' + GROUPS + '/</D:href>' +
      '<D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop>' +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '<D:response><D:href>/dav/' + GROUPS + '/aa/</D:href>' +
      '<D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop>' +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '</D:multistatus>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.listed, true, '真机形态的清单必须读得懂');
    assert.equal(res.entries.length, 1);
    assert.equal(
      res.entries[0].isCollection,
      true,
      '带 xmlns 属性的 <collection> 必须被认成目录（认错 ⇒ 前缀目录扫不到 ⇒ 重建索引中止）'
    );
  });

  it('collection 的各种合法写法都要认（带属性 / 无前缀 / 自闭合 / 成对标签）', async () => {
    const forms = [
      '<D:collection/>',
      '<D:collection xmlns:D="DAV:"/>',
      '<D:collection xmlns="DAV:"/>',
      '<collection/>',
      '<collection></collection>',
      '<D:collection />',
    ] as const;
    for (const form of forms) {
      const dav = new TinyDav();
      dav.propfindDepth1Body =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        `<D:response><D:href>/dav/${GROUPS}/aa/</D:href>` +
        `<D:propstat><D:prop><D:resourcetype>${form}</D:resourcetype></D:prop></D:propstat>` +
        '</D:response></D:multistatus>';
      const res = await makeClient(dav).listDir(GROUPS);
      assert.equal(res.entries.length, 1, `写法 ${form} 必须被解析出来`);
      assert.equal(res.entries[0].isCollection, true, `写法 ${form} 必须被认成目录`);
    }
  });

  it('名字相近但不是 collection 的元素不得被误判成目录', async () => {
    for (const form of ['<D:collectionfoo/>', '<D:collections/>'] as const) {
      const dav = new TinyDav();
      dav.propfindDepth1Body =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        `<D:response><D:href>/dav/${GROUPS}/aa.json</D:href>` +
        `<D:propstat><D:prop><D:resourcetype>${form}</D:resourcetype></D:prop></D:propstat>` +
        '</D:response></D:multistatus>';
      const res = await makeClient(dav).listDir(GROUPS);
      assert.equal(res.entries.length, 1, `写法 ${form} 必须被解析出来`);
      assert.equal(
        res.entries[0].isCollection,
        false,
        `写法 ${form} 不是 collection，不得被误判成目录（误判 ⇒ 文件被当子目录去 listDir）`
      );
    }
  });

  it('命名空间前缀的各种写法都要认（D: / d: / 无前缀 / 别的前缀）', async () => {
    for (const [open, close] of [
      ['<D:response>', '</D:response>'],
      ['<d:response>', '</d:response>'],
      ['<response>', '</response>'],
      ['<x:response>', '</x:response>'],
    ] as const) {
      const dav = new TinyDav();
      dav.propfindDepth1Body =
        `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
        `${open}<D:href>/dav/${GROUPS}/aa/</D:href>${close}` +
        `</D:multistatus>`;
      const res = await makeClient(dav).listDir(GROUPS);
      assert.equal(res.listed, true, `前缀写法 ${open} 必须被认出来`);
      assert.equal(res.entries.length, 1);
    }
  });

  it('href 的三种形态（绝对 URL / 绝对路径 / 相对）必须归一到同一个路径', async () => {
    const forms = [
      `https://dav.example.com/dav/${GROUPS}/aa/`,
      `/dav/${GROUPS}/aa/`,
      `${GROUPS}/aa/`,
    ];
    for (const href of forms) {
      const dav = new TinyDav();
      dav.propfindDepth1Body =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        `<D:response><D:href>${href}</D:href></D:response>` +
        '</D:multistatus>';
      const res = await makeClient(dav).listDir(GROUPS);
      assert.equal(res.entries[0]?.path, `${GROUPS}/aa`, `href 形态 ${href} 必须归一到同一个相对路径`);
    }
  });

  it('百分号编码的 href 要解码（中文目录名）', async () => {
    const dav = new TinyDav();
    dav.propfindDepth1Body =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>/dav/TapStack/groups/%E4%B8%AD%E6%96%87/</D:href></D:response>' +
      '</D:multistatus>';
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.entries[0]?.path, `${GROUPS}/中文`);
  });

  it('目录自身不算子资源', async () => {
    const dav = new TinyDav();
    dav.dirs.add(GROUPS);
    dav.dirs.add(`${GROUPS}/aa`);
    const res = await makeClient(dav).listDir(GROUPS);
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].path, `${GROUPS}/aa`, '只有子目录，不含自身');
  });

  it('Depth:1 请求头必须真的发出去（服务端按它决定返回深度）', async () => {
    const dav = new TinyDav();
    await makeClient(dav).listDir(GROUPS);
    const propfind = dav.calls.find(c => c.method === 'PROPFIND');
    assert.ok(propfind, '必须发出 PROPFIND');
    assert.equal(propfind.depth, '1', 'Depth 必须是 1（Depth:infinity 会被服务端截断 ⇒ 少列）');
  });

  it('404 / 409 / 405 / 501 ⇒ 列不出来（不是「空的」）', async () => {
    for (const status of [404, 409, 405, 501]) {
      const client = new WebDavClient(
        { baseUrl: BASE, username: 'u', password: 'p' },
        statusServer(status)
      );
      const res = await client.listDir(GROUPS);
      assert.equal(res.listed, false, `HTTP ${status} ⇒ 必须列不出来`);
    }
  });

  it('401 / 403 ⇒ 抛错（认证/权限问题绝不静默当空目录）', async () => {
    for (const status of [401, 403]) {
      const client = new WebDavClient(
        { baseUrl: BASE, username: 'u', password: 'p' },
        statusServer(status)
      );
      await assert.rejects(() => client.listDir(GROUPS), /认证失败或无读取权限/);
    }
  });

  it('500 ⇒ 抛错', async () => {
    const client = new WebDavClient(
      { baseUrl: BASE, username: 'u', password: 'p' },
      statusServer(500)
    );
    await assert.rejects(() => client.listDir(GROUPS), /PROPFIND 失败/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 二、适配器层：读不出清单 ⇒ 必须中止，绝不判成空库
// ════════════════════════════════════════════════════════════════════

describe('适配器：索引丢了 + 目录读不懂 ⇒ 中止，绝不拿云端当空库', () => {
  it('downloadGroups 必须抛错，而不是返回空数组', async () => {
    const dav = new TinyDav();
    dav.seedFile(`${GROUPS}/aa/aa1.json`, shardBody('aa1', '云端会话'));
    dav.dirs.add(GROUPS);
    dav.dirs.add(`${GROUPS}/aa`);
    dav.propfindDepth1Body = '<html><body>502 Bad Gateway</body></html>';
    const adapter = makeAdapter(dav);

    await assert.rejects(
      () => adapter.downloadGroups(),
      /索引|空库|重建|中止/,
      '云端明明有会话、我们却读不懂清单 ⇒ 必须中止并如实报错'
    );
  });

  it('本机的子集绝不能把云端覆盖成空的（上传同样必须中止）', async () => {
    const dav = new TinyDav();
    const seeded = dav.seedFile(`${GROUPS}/aa/aa1.json`, shardBody('aa1', '云端会话'));
    dav.dirs.add(GROUPS);
    dav.dirs.add(`${GROUPS}/aa`);
    dav.propfindDepth1Body = '<html><body>502 Bad Gateway</body></html>';
    const adapter = makeAdapter(dav);

    await assert.rejects(
      () => adapter.uploadGroups([localGroup('bb2', '本机会话')]),
      /索引|空库|重建|中止/,
      '读不懂云端清单时，上传必须中止 —— 否则本机子集会把云端内容盖没'
    );

    const after = dav.files.get(`${GROUPS}/aa/aa1.json`);
    assert.ok(after, '云端原有的分片不许被删掉');
    assert.equal(after.body, shardBody('aa1', '云端会话'), '云端原有的分片内容不许被改写');
    assert.equal(after.etag, seeded, '云端原有的分片不许被覆盖写');
  });

  it('索引丢了 + 目录确实是空的 ⇒ 首次同步照常（不许把正常路径一起判死）', async () => {
    const dav = new TinyDav();
    dav.dirs.add(GROUPS);
    // 目录存在，但里面一个分片都没有 ⇒ 确知远端为空 ⇒ 合法起点。
    const adapter = makeAdapter(dav);

    assert.deepEqual(await adapter.downloadGroups(), [], '空目录应当读出空列表');

    await adapter.uploadGroups([localGroup('aa1', '本机会话')]);
    const manifest = dav.files.get(MANIFEST);
    assert.ok(manifest, '首次同步必须把索引写上去');
  });

  it('正常路径不回归：索引在 ⇒ 直接读回', async () => {
    const dav = new TinyDav();
    const adapter = makeAdapter(dav);
    await adapter.uploadGroups([localGroup('aa1', '会话一')]);
    const groups = await adapter.downloadGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, '会话一');
  });

  // ── 真机形态的端到端后果（2026-10-20 P0）────────────────────────────
  // 上面那条「真机形态」的测试验的是**解析层**。这条验的是**后果**：
  // 前缀目录被误判成文件 ⇒ 重建索引时一个分片都扫不到 ⇒ 中止同步。
  // 在 rclone / 坚果云 / Nextcloud 这类服务端上，用户会看到
  // 「目录结构与本版本不符」—— 而实际上目录结构完全正确。
  it('真机形态下必须能把云端分片重建出来（不许报「目录结构与本版本不符」）', async () => {
    const dav = new TinyDav();
    dav.seedFile(`${GROUPS}/aa/aa1.json`, shardBody('aa1', '云端会话'));
    dav.dirs.add(GROUPS);
    dav.dirs.add(`${GROUPS}/aa`);
    // 真机形态：<collection> 带命名空间声明属性。
    // ⚠️ 用**按路径分开的正文**：`listDir` 对每个目录各发一次 PROPFIND，
    //    真实服务端每次回的是**那个目录**的清单。若所有目录共用一份正文，
    //    `groups/` 的清单里就会混进 `groups/aa/` 自己的条目 —— 那是探针的
    //    假象，不是产品缺陷。
    const realShape = (href: string, children: string[]) =>
      '<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>' + href + '</D:href>' +
      '<D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop>' +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      children
        .map(
          c =>
            '<D:response><D:href>' + c + '</D:href>' +
            '<D:propstat><D:prop><D:resourcetype>' +
            (c.endsWith('/')
              ? '<D:collection xmlns:D="DAV:"/>'
              : '') +
            '</D:resourcetype></D:prop>' +
            '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
        )
        .join('') +
      '</D:multistatus>';

    const bodies = new Map<string, string>([
      [GROUPS, realShape(`/dav/${GROUPS}/`, [`/dav/${GROUPS}/aa/`])],
      [`${GROUPS}/aa`, realShape(`/dav/${GROUPS}/aa/`, [`/dav/${GROUPS}/aa/aa1.json`])],
    ]);
    dav.propfindDepth1BodyFor = path => bodies.get(path);

    const adapter = makeAdapter(dav);

    const groups = await adapter.downloadGroups();
    assert.equal(
      groups.length,
      1,
      '真机形态下索引丢了必须能从目录重建出云端会话（认错目录 ⇒ 扫不到分片 ⇒ 中止）'
    );
    assert.equal(groups[0].name, '云端会话');
  });
});
