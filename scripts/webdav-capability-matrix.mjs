/**
 * WebDAV 服务端「条件写能力」对照矩阵（2026-10-13）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────────
 * 方案 §4.3 原本假设「WebDAV 天然支持 ETag + If-Match」，据此把并发安全
 * 整条押在条件写上。本机真机实测 dufs 0.46 直接推翻了这个前提：
 * **它完全忽略条件请求头**。这个发现改变了两件事：
 *   1. 「协议规定了」不等于「实现支持了」——必须逐个实测；
 *   2. 需要一张对照表回答「换别的 WebDAV 服务会不会好一点」。
 *
 * ── 为什么用裸 fetch 而不是我们自己的 WebDavClient ──────────────────────
 * 本脚本的**测量对象是服务端**。用自家客户端去测，一旦客户端对协议的理解
 * 有偏，测出来的就是「客户端+服务端」的合成行为，分不清到底是谁的问题。
 * 裸 fetch 让服务端行为保持独立。
 *
 * ── 测两种不同的条件机制（这是容易漏的一点）────────────────────────────
 * 「条件写」在 WebDAV 世界里有两套**互不相同**的机制，服务端可能只实现其一：
 *   · HTTP `If-Match: "<etag>"`      —— RFC 9110 的通用条件请求
 *   · WebDAV `If: (<"etag">)`        —— RFC 4918 §10.4 的 WebDAV 原生机制
 * 后者是 WebDAV 为锁与并发专门定义的，实现度可能更高。两套都要测，
 * 因为「该用哪一套」直接决定客户端的实现选择。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 测本地起的四个独立实现，打印对照矩阵
 *   node scripts/webdav-capability-matrix.mjs
 *
 *   # 测任意真实服务端（例如坚果云 / Nextcloud）
 *   node scripts/webdav-capability-matrix.mjs --url https://dav.example.com/dav/ \
 *     --user me@example.com --pass '应用密码'
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ── 探针本体 ───────────────────────────────────────────────────────────

/**
 * 对一个 WebDAV 端点跑完整能力探测。
 *
 * @returns 结构化结果（字段含义见下方打印段）
 */
async function probe(baseUrl, user, pass) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const auth = user ? { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } : {};
  const url = p => base + p;
  const out = {
    reachable: false,
    mkcol: null,
    putEtag: null,
    propfindGetetag: null,
    propfindGetlastmodified: null,
    getEtag: null,
    httpIfMatch: null,
    httpIfNoneMatch: null,
    davIfHeader: null,
  };

  const req = async (method, p, headers = {}, body) => {
    const res = await fetch(url(p), { method, headers: { ...auth, ...headers }, body });
    return { status: res.status, etag: res.headers.get('ETag'), text: () => res.text() };
  };

  try {
    await req('PROPFIND', '', { Depth: '0' });
    out.reachable = true;
  } catch {
    return out;
  }

  const MK = '.tapstack-probe';
  const F = `${MK}/f.txt`;
  const PF_BODY = `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getlastmodified/></D:prop></D:propfind>`;

  // 建目录（405 = 已存在）
  const mk = await req('MKCOL', MK);
  out.mkcol = mk.status === 201 || mk.status === 405;

  // PUT：响应头是否带 ETag
  const put1 = await req('PUT', F, { 'Content-Type': 'text/plain' }, 'v1');
  out.putEtag = put1.etag;

  // PROPFIND：是否返回 getetag / getlastmodified
  const pf = await req('PROPFIND', F, { Depth: '0', 'Content-Type': 'application/xml' }, PF_BODY);
  const xml = pf.status === 207 || pf.status === 200 ? await pf.text() : '';
  out.propfindGetetag = /<[^>]*getetag[^>]*>([\s\S]*?)<\//i.test(xml);
  out.propfindGetlastmodified = /<[^>]*getlastmodified[^>]*>([\s\S]*?)<\//i.test(xml);

  // GET：拿到一个真实 ETag 供后续条件写使用
  const got = await req('GET', F);
  out.getEtag = got.etag;
  const realEtag = got.etag;

  // ── 条件写：必须**双向**测，只测过期方向会得出错误结论 ──────────────────
  //
  // 【为什么必须双向】第一版探针只发了「过期值」，看到 412 就记「生效」。
  // 但一个**对所有条件请求一律 412** 的服务端也会得到「生效」——
  // 而那会直接废掉正常写入（每次写都被拒）。只测一个方向等于给这种
  // 服务端发一张假的合格证。必须同时满足：
  //   · 过期值 → 412（真的在校验）
  //   · 正确值 → 2xx（不是一律拒绝）
  //
  // 结论因此有四种，而不是两种：
  //   honored     ✅ 两端都对，机制可用
  //   ignored     ✗ 过期值也被接受 ⇒ 根本没校验
  //   rejects-all ⚠️ 过期被拒、正确也被拒 ⇒ **不能用**（会把写入全废掉）
  //   ?a/b        其他（需要人工看）
  const evalConditional = async (headerName, staleValue, freshValue) => {
    const stale = await req('PUT', F, { [headerName]: staleValue }, 'stale-write');
    // 重新取一次当前 ETag —— 上一次尝试若真的写成功，ETag 已经变了
    const cur = await req('GET', F);
    const fresh = await req('PUT', F, { [headerName]: freshValue(cur.etag) }, 'fresh-write');
    const staleRejected = stale.status === 412;
    const freshOk = fresh.status >= 200 && fresh.status < 300;
    if (staleRejected && freshOk) return 'honored';
    if (!staleRejected && freshOk) return 'ignored';
    if (staleRejected && !freshOk) return 'rejects-all';
    return `?${stale.status}/${fresh.status}`;
  };

  out.httpIfMatch = await evalConditional('If-Match', '"deliberately-stale"', e => e ?? '"any"');
  out.httpIfNoneMatch =
    (await req('PUT', F, { 'If-None-Match': '*' }, 'x')).status === 412 ? 'honored' : 'ignored';

  // ③ WebDAV 原生 If 头（RFC 4918 §10.4）
  //
  // ⚠️ 语法必须用**实体标签形式 `["etag"]`（方括号）**，不是 `("etag")`（圆括号）。
  // 圆括号里放的是 Coded-URL 形式的锁令牌 `<urn:...>`，拿它装 ETag 是错的；
  // 服务端可能因为「解析不了」而返回 412 —— 那看起来像「生效」，其实是误报。
  if (realEtag) {
    out.davIfHeader = await evalConditional('If', '(["deliberately-stale"])', e => `([${e}])`);
  } else {
    out.davIfHeader = 'no-etag-to-test';
  }

  // 清理
  await req('DELETE', F);
  await req('DELETE', MK);
  return out;
}

// ── 本地四个独立实现的启动配置 ─────────────────────────────────────────

const USER = 'e2e-user';
const PASS = 'e2e-pass';

const SERVERS = [
  {
    name: 'dufs 0.46 (Rust)',
    start: (dir, port) => [
      'dufs',
      [dir, '--bind', '127.0.0.1', '--port', String(port), '--auth', `${USER}:${PASS}@/:rw`, '--allow-upload', '--allow-delete'],
    ],
  },
  {
    name: 'rclone serve webdav (Go)',
    // ⚠️ `--pass` 收的是**明文**（rclone 内部自己处理）。
    // 第一版我传了 `rclone obscure` 的结果，等于让它再解一次 → 解成乱码 → 一律 401。
    // 那一行因此全是 ✗，看起来像「rclone 什么都不支持」，其实是我的参数错。
    // 教训：对照表里出现一整行全 ✗ 时，先怀疑自己的测试，别急着当结论。
    start: (dir, port) => [
      'rclone',
      ['serve', 'webdav', dir, '--addr', `127.0.0.1:${port}`, '--user', USER, '--pass', PASS],
    ],
  },
  {
    name: 'wsgidav (Python)',
    start: (dir, port) => ['/tmp/wsgidavenv/bin/wsgidav', ['--host', '127.0.0.1', '--port', String(port), '--root', dir, '--auth', 'anonymous']],
    creds: [undefined, undefined],
  },
];

// ── 跑起来 ─────────────────────────────────────────────────────────────

async function waitReady(baseUrl, user, pass) {
  const auth = user ? { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } : {};
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(baseUrl, { method: 'PROPFIND', headers: { ...auth, Depth: '0' } });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return false;
}

const launched = [];
const rows = [];
try {
  for (const [i, spec] of SERVERS.entries()) {
    const dir = mkdtempSync(join(tmpdir(), `davcap-${i}-`));
    const port = 49100 + i;
    const baseUrl = spec.url ?? `http://127.0.0.1:${port}/`;
    let child = null;

    if (!spec.url) {
      const [cmd, args] = spec.start(dir, port);
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', d => (log += d));
      child.stderr.on('data', d => (log += d));
      launched.push({ child, dir });
      if (!(await waitReady(baseUrl, USER, PASS))) {
        console.log(`⚠️  ${spec.name}: 未能就绪，跳过。日志尾部：\n${log.slice(-500)}`);
        continue;
      }
    }

    const [u, p] = spec.creds ?? [USER, PASS];
    console.log(`探测 ${spec.name} …`);
    const r = await probe(baseUrl, u, p);
    rows.push({ name: spec.name, ...r });
  }
} catch (err) {
  console.error('探测过程异常：', err);
} finally {
  for (const { child, dir } of launched) {
    child.kill('SIGTERM');
  }
  await new Promise(r => setTimeout(r, 600));
  for (const { child, dir } of launched) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await new Promise(r => setTimeout(r, 400));
  const alive = launched.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  console.log(`\n清理：${launched.length} 个子进程，未退出 ${alive.length} 个`);
  for (const { dir } of launched) rmSync(dir, { recursive: true, force: true });
}

// ── 打印矩阵 ───────────────────────────────────────────────────────────

const cell = v => {
  if (v === null || v === undefined) return '—';
  if (v === true) return '✓';
  if (v === false) return '✗';
  if (v === 'honored') return '✓ 生效';
  if (v === 'ignored') return '✗ 忽略';
  if (v === 'rejects-all') return '⚠️ 一律拒绝（不可用）';
  return String(v);
};

console.log(`\n${'═'.repeat(100)}`);
console.log('WebDAV 服务端能力对照矩阵（实测，2026-10-13）');
console.log('═'.repeat(100));

const COLS = [
  ['MKCOL', 'mkcol'],
  ['PUT 带 ETag', 'putEtag'],
  ['PROPFIND getetag', 'propfindGetetag'],
  ['PROPFIND getlastmod', 'propfindGetlastmodified'],
  ['GET 带 ETag', 'getEtag'],
  ['HTTP If-Match', 'httpIfMatch'],
  ['HTTP If-None-Match', 'httpIfNoneMatch'],
  ['WebDAV If 头', 'davIfHeader'],
];

for (const row of rows) {
  console.log(`\n▸ ${row.name}${row.reachable ? '' : '（不可达）'}`);
  for (const [label, key] of COLS) {
    console.log(`    ${label.padEnd(20)} ${cell(row[key])}`);
  }
}

const honored = rows.filter(r => r.httpIfMatch === 'honored' || r.davIfHeader === 'honored');
console.log(`\n${'─'.repeat(100)}`);
console.log(`可用于乐观锁的服务端：${honored.length ? honored.map(r => r.name).join('、') : '无'}`);
console.log(`
结论（2026-10-13 实测，3 个独立实现）：
  1. 条件写是**可选**实现。协议（RFC 4918/9110）定义了语义，但不强制服务端实现。
     · dufs 0.46       —— 三种机制全部忽略
     · rclone 1.75.2   —— HTTP 条件头忽略；WebDAV If 头**对任何值一律 412**
     · wsgidav (Py)    —— 三种机制全部正确实现（过期→412、正确→2xx）
  2. **客户端只能发 HTTP \`If-Match\`，绝不能加 WebDAV \`If:\` 头。**
     看似「两个都发更稳妥」是错的：rclone 对任何 If 头一律 412，
     多带一个 If 头会让**所有写入在那类服务端上直接失败**。
     rclone 上 If-Match 被忽略（降级为无锁），但写入正常 —— 可用比不可用重要。
  3. 因此并发保护是**两层**：
     · 第一层（服务端强）乐观锁 —— 只有 wsgidav 这类服务端提供，需探测后才知道；
     · 第二层（客户端稳）认输预检（stamp 比较）—— **不依赖服务端能力，始终有效**。
     第二层才是主力；第一层是锦上添花。这条已写进 adapter.ts 与方案 §4.3。`);
