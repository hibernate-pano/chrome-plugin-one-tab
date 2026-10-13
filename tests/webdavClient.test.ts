// WebDAV 传输层测试（2026-10-13，阶段 1）。
//
// 这一层是「用户数据能不能正确落到他自己的云盘」的地基，所以断言要覆盖：
//   · 地址规范化（https 强制、内嵌凭据拒绝、尾斜杠、保留 /dav/ 前缀）
//   · Basic 认证头（含非 ASCII 账号名）
//   · 乐观锁：If-Match 命中与 412 的区分
//   · 「不存在」与「失败」必须分得开（404 → null，不是抛错也不是空字符串）
//   · MKCOL 的幂等（405 = 已存在，不得当成错误）
//   · PROPFIND 解析（命名空间前缀不固定、XML 实体）
//
// 变异验证口径（改坏实现必须变红）：
//   · 把 normalizeBaseUrl 的 https 校验删掉 ⇒ 「http 必须拒绝」红
//   · 把 PUT 的 412 分支删掉（并入 !res.ok 通用抛错）⇒ 「412 必须可识别」红
//   · 把 MKCOL 的 405 改成抛错 ⇒ 「重复建目录不报错」红
//   · 把 extractTag 的前缀匹配去掉（只认 D:）⇒ 「无前缀服务端」红
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WebDavClient,
  WebDavError,
  normalizeBaseUrl,
  encodePathSegments,
} from '@/sync-backend/webdav/client';

// ── 假 fetch ───────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (call: RecordedCall) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

function makeFetch(handler: Handler) {
  const calls: RecordedCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: RecordedCall = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers,
      body: init?.body,
    };
    calls.push(call);
    const out = handler(call);
    // 刻意不用 `new Response()` 构造：
    //   1) 它拒绝 204/304 带 body（规范如此），而我们要测的正是 204；
    //   2) 它拒绝 status 0（必须 200-599），而 opaque redirect 恰恰以 0 出现。
    // 用最小响应对象能如实模拟这两种真实响应。
    return makeResponse(out.status, out.headers, out.body ?? '');
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 最小 Response 替身。只实现被测代码真正用到的成员。 */
function makeResponse(status: number, headers: Record<string, string> = {}, body = '') {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

const BASE = 'https://dav.jianguoyun.com/dav/';
const cfg = { baseUrl: BASE, username: 'me@example.com', password: 'app-pass' };

// ── 地址规范化 ─────────────────────────────────────────────────────────

describe('WebDAV 地址规范化', () => {
  it('保留 /dav/ 前缀并补上缺失的尾斜杠', () => {
    assert.equal(normalizeBaseUrl('https://dav.jianguoyun.com/dav'), BASE);
    assert.equal(normalizeBaseUrl('https://dav.jianguoyun.com/dav/'), BASE);
    // 坚果云必须带 /dav/；不带时按服务器根处理（用户自己填错了要能看出来）
    assert.equal(normalizeBaseUrl('https://dav.jianguoyun.com'), 'https://dav.jianguoyun.com/');
  });

  it('保留用户自定义的多级子目录（自建 Nextcloud 常见）', () => {
    assert.equal(
      normalizeBaseUrl('https://cloud.example.com/remote.php/dav/files/me/TapStack/'),
      'https://cloud.example.com/remote.php/dav/files/me/TapStack/'
    );
  });

  it('明文 http 一律拒绝（除 loopback）', () => {
    assert.throws(() => normalizeBaseUrl('http://dav.example.com/dav/'), /必须使用 https/);
    // 自建服务器调试场景放行 loopback
    assert.equal(normalizeBaseUrl('http://localhost:8080/dav/'), 'http://localhost:8080/dav/');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/dav/'), 'http://127.0.0.1:8080/dav/');
  });

  it('拒绝把账号密码写在地址里（会被发往服务器并可能进日志）', () => {
    assert.throws(() => normalizeBaseUrl('https://user:pass@dav.example.com/dav/'), /不要.*写在地址里/);
  });

  it('空地址与非 URL 都给出可读错误', () => {
    assert.throws(() => normalizeBaseUrl('   '), /不能为空/);
    assert.throws(() => normalizeBaseUrl('not a url'), /格式不正确/);
  });
});

describe('路径编码', () => {
  it('逐段编码：中文目录名与空格都要能拼进 URL', () => {
    assert.equal(encodePathSegments('TapStack 备份/groups/ab.json'), 'TapStack%20%E5%A4%87%E4%BB%BD/groups/ab.json');
    // 斜杠不能被编码（它是路径分隔符）
    assert.ok(!encodePathSegments('a/b/c').includes('%2F'));
  });

  it('路径穿越被显式拒绝（encodeURIComponent 不会编码点号）', () => {
    // 关键事实：encodeURIComponent('..') === '..'，所以单靠编码拦不住。
    // 分片路径的一部分来自远端 manifest（云盘账号可改），必须显式拒绝。
    assert.throws(() => encodePathSegments('../escape.json'), /不合法/);
    assert.throws(() => encodePathSegments('groups/../../etc/passwd'), /不合法/);
    assert.throws(() => encodePathSegments('./x'), /不合法/);
    // 正常路径不受影响
    assert.equal(encodePathSegments('groups/ab/g-1.json'), 'groups/ab/g-1.json');
  });
});

// ── 认证 ───────────────────────────────────────────────────────────────

describe('Basic 认证头', () => {
  it('按 RFC 7617 生成 user:pass 的 base64（含非 ASCII 账号名）', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 207, body: '<x/>' }));
    const client = new WebDavClient({ ...cfg, username: '用户@example.com' }, impl);
    await client.stat('');

    const auth = calls[0].headers['authorization'];
    assert.ok(auth?.startsWith('Basic '));
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    assert.equal(decoded, '用户@example.com:app-pass');
  });
});

// ── GET ────────────────────────────────────────────────────────────────

describe('GET', () => {
  it('404 返回 null（文件不存在是正常状态，不是错误）', async () => {
    const { impl } = makeFetch(() => ({ status: 404 }));
    const client = new WebDavClient(cfg, impl);
    assert.equal(await client.get('manifest.json'), null);
  });

  it('200 返回内容与 ETag', async () => {
    const { impl } = makeFetch(() => ({
      status: 200,
      body: '{"v":1}',
      headers: { ETag: '"abc123"' },
    }));
    const client = new WebDavClient(cfg, impl);
    const out = await client.get('manifest.json');
    assert.equal(out?.body, '{"v":1}');
    assert.equal(out?.etag, '"abc123"');
  });

  it('401/403 报「认证失败」而不是通用失败（用户要知道去改密码）', async () => {
    const { impl } = makeFetch(() => ({ status: 401 }));
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(() => client.get('x.json'), /认证失败/);
  });

  it('5xx 报通用失败并带上状态码', async () => {
    const { impl } = makeFetch(() => ({ status: 503 }));
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(() => client.get('x.json'), /HTTP 503/);
  });

  it('传 If-None-Match 时该头必须真的发出去（探活的省流手段）', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 304 }));
    const client = new WebDavClient(cfg, impl);
    await client.get('manifest.json', { ifNoneMatch: '"v1"' });
    assert.equal(calls[0].headers['if-none-match'], '"v1"');
  });
});

// ── PUT 与乐观锁 ───────────────────────────────────────────────────────

describe('PUT 与乐观锁', () => {
  it('If-Match 必须原样发出（并发安全的唯一来源）', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 201, headers: { ETag: '"new"' } }));
    const client = new WebDavClient(cfg, impl);
    const out = await client.put('groups/g1.json', '{}', { ifMatch: '"old"' });
    assert.equal(calls[0].headers['if-match'], '"old"');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(out.etag, '"new"');
  });

  it('If-None-Match: * 用于「仅当不存在时创建」', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 201 }));
    const client = new WebDavClient(cfg, impl);
    await client.put('manifest.json', '{}', { ifNoneMatch: '*' });
    assert.equal(calls[0].headers['if-none-match'], '*');
  });

  it('412 必须可被识别为乐观锁失败（不得降级成无条件覆盖）', async () => {
    const { impl } = makeFetch(() => ({ status: 412 }));
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(
      () => client.put('x', '{}', { ifMatch: '"stale"' }),
      (err: unknown) => {
        assert.ok(err instanceof WebDavError);
        assert.equal(err.isPreconditionFailed, true);
        assert.equal(err.status, 412);
        // ── 为什么还要断言文案（2026-10-13 变异验证补）────────────────────
        // 只断言 status/标志位是不够的：把 412 的专属分支删掉后，通用
        // `!res.ok` 分支照样会带着 status=412 抛错（isPreconditionFailed 的
        // 默认值就是 `status === 412`），于是**变异不会被抓到** ——
        // 这一条曾经就是这样一条假绿断言。
        //
        // 真正会丢的是一条**可据以行动**的信息：调用方看到 412 后必须
        // 「重新拉取 → 合并 → 重试」，而不是当成一次普通网络失败去盲目重试。
        // 通用分支的「PUT 失败（HTTP 412）」不含这个指引，因此必须钉住文案。
        assert.match(err.message, /其他设备修改/, '错误信息必须说明该重新合并后重试');
        return true;
      }
    );
  });

  it('204 也算成功（部分服务端不返回 201/200）', async () => {
    const { impl } = makeFetch(() => ({ status: 204 }));
    const client = new WebDavClient(cfg, impl);
    await client.put('x', '{}');
  });
});

// ── MKCOL ──────────────────────────────────────────────────────────────

describe('MKCOL 与逐级建目录', () => {
  it('405 表示目录已存在，视为成功（幂等）', async () => {
    const { impl } = makeFetch(() => ({ status: 405 }));
    const client = new WebDavClient(cfg, impl);
    const out = await client.mkcol('TapStack');
    assert.equal(out.created, false);
  });

  it('mkdirp 按层级顺序创建，且已存在的层不中断', async () => {
    const { impl, calls } = makeFetch(call => {
      // 模拟「第一层已存在」
      return { status: call.url.endsWith('/TapStack') ? 405 : 201 };
    });
    const client = new WebDavClient(cfg, impl);
    await client.mkdirp('TapStack/groups/ab');

    assert.deepEqual(
      calls.map(c => c.url.replace(BASE, '')),
      ['TapStack', 'TapStack/groups', 'TapStack/groups/ab']
    );
    assert.ok(calls.every(c => c.method === 'MKCOL'));
  });
});

// ── DELETE ─────────────────────────────────────────────────────────────

describe('DELETE', () => {
  it('404 视为成功（目标已达成：文件确实不在了）', async () => {
    const { impl } = makeFetch(() => ({ status: 404 }));
    const client = new WebDavClient(cfg, impl);
    await client.delete('groups/gone.json');
  });

  it('403 报权限错误', async () => {
    const { impl } = makeFetch(() => ({ status: 403 }));
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(() => client.delete('x'), /无删除权限/);
  });
});

// ── PROPFIND 解析 ──────────────────────────────────────────────────────

describe('PROPFIND 元信息解析', () => {
  const propfind = (inner: string) =>
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response>${inner}</D:response></D:multistatus>`;

  it('取到 ETag / Last-Modified / 字节数', async () => {
    const { impl } = makeFetch(() => ({
      status: 207,
      body: propfind(
        '<D:propstat><D:prop><D:getetag>"e1"</D:getetag><D:getlastmodified>Mon, 13 Oct 2026 10:00:00 GMT</D:getlastmodified><D:getcontentlength>123</D:getcontentlength></D:prop></D:propstat>'
      ),
    }));
    const client = new WebDavClient(cfg, impl);
    const meta = await client.stat('manifest.json');
    assert.equal(meta.exists, true);
    assert.equal(meta.etag, '"e1"');
    assert.equal(meta.lastModified, 'Mon, 13 Oct 2026 10:00:00 GMT');
    assert.equal(meta.contentLength, 123);
  });

  it('命名空间前缀不固定：小写 d: 与无前缀都要能解析', async () => {
    for (const tag of ['d:getetag', 'getetag']) {
      const { impl } = makeFetch(() => ({
        status: 207,
        body: propfind(`<propstat><prop><${tag}>"zz"</${tag}></prop></propstat>`),
      }));
      const client = new WebDavClient(cfg, impl);
      const meta = await client.stat('x');
      assert.equal(meta.etag, '"zz"', `前缀变体 ${tag} 未被解析`);
    }
  });

  it('服务端不返回某字段时给 null，而不是编造值', async () => {
    const { impl } = makeFetch(() => ({ status: 207, body: propfind('<propstat><prop></prop></propstat>') }));
    const client = new WebDavClient(cfg, impl);
    const meta = await client.stat('x');
    assert.equal(meta.exists, true);
    assert.equal(meta.etag, null);
    assert.equal(meta.lastModified, null);
    assert.equal(meta.contentLength, null);
  });

  it('404 → exists:false（不是错误）', async () => {
    const { impl } = makeFetch(() => ({ status: 404 }));
    const client = new WebDavClient(cfg, impl);
    const meta = await client.stat('missing.json');
    assert.equal(meta.exists, false);
  });

  it('Depth:0 与 XML body 必须发出去（漏了会被当成目录列举）', async () => {
    const { impl, calls } = makeFetch(() => ({ status: 207, body: propfind('') }));
    const client = new WebDavClient(cfg, impl);
    await client.stat('x');
    assert.equal(calls[0].headers['depth'], '0');
    assert.ok(String(calls[0].body).includes('propfind'));
  });

  it('XML 实体要解码（&amp; 出现在 URL 类属性里）', async () => {
    const { impl } = makeFetch(() => ({
      status: 207,
      body: propfind('<propstat><prop><getetag>a&amp;b</getetag></prop></propstat>'),
    }));
    const client = new WebDavClient(cfg, impl);
    assert.equal((await client.stat('x')).etag, 'a&b');
  });
});

// ── 网络层 ─────────────────────────────────────────────────────────────

describe('网络层错误', () => {
  it('fetch 抛错 → WebDavError(status 0)，便于区分「没连上」与「服务器拒绝」', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(
      () => client.get('x'),
      (err: unknown) => {
        assert.ok(err instanceof WebDavError);
        // status 0 是「请求根本没发出去」的稳定标记（断网 / 缺 host 权限 / 被拦）
        assert.equal(err.status, 0);
        return true;
      }
    );
  });

  it('opaque redirect（status 0）报可诊断的错，而不是当成成功', async () => {
    const { impl } = makeFetch(() => ({ status: 0 }));
    const client = new WebDavClient(cfg, impl);
    await assert.rejects(() => client.stat(''), /重定向/);
  });
});

