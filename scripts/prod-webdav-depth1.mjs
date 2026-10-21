/**
 * WebDAV `PROPFIND Depth:1` —— **对真实服务端**的验证（2026-10-20）。
 *
 * ── 为什么需要这个脚本 ─────────────────────────────────────────────────
 * `client.ts` 的 `listDir()` 是「云端索引丢了 ⇒ 从目录重建索引」这条
 * 兜底路径的**唯一**入口。它上面挂着一道 fail-closed 闸：
 * 正文读不出 `<response>` / `<multistatus>` 没闭合 / `<response>` 缺 `<href>`
 * ⇒ 一律判成「列不出来」⇒ 上层中止同步（绝不把云端当成空库）。
 *
 * ⚠️ 这道闸是**收紧**出来的。收紧之前它把「HTTP 207」当成「列成功了」——
 * 而 207 只说明服务端回了多状态，**不保证正文里有我们认得的清单**。
 * 网关塞一份 HTML 错误页就能骗过它。
 *
 * 但收紧是有代价的：**如果判据写歪了，合法响应也会被当成「列不出来」**，
 * 于是所有 WebDAV 用户都同步不了（比原来更糟）。而这条链路此前的覆盖是：
 *   · 单测里 **0 条**直接测 `listDir`；
 *   · 真机脚本只测 **Depth:0**（stat 一个已知路径），**Depth:1 一条都没有**。
 *
 * 也就是说：这道闸的判据是在**从未被真机验证过的路径**上收紧的。
 * 本脚本补上这个洞 —— 起一个真实的 WebDAV 服务端，把**产品代码本身**
 * （`WebDavClient.listDir` + `WebDavBackendAdapter`）打过去，逐条核对判据。
 *
 * ── 为什么用 rclone serve webdav ──────────────────────────────────────
 * 它是四种常见实现里协议行为最"教科书"的一个（规范的多状态响应）。
 * 判据若在它身上过不了，那就是判据本身错了 —— 这正是我们要的信号。
 * 真实用户会用的三家（坚果云 / Nextcloud / 自建）形态相近但不完全一致，
 * 所以这里测的是**判据的上界**，不是每一家都必须过。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node --import ./tests/_register-loader.mjs --experimental-strip-types \
 *     scripts/prod-webdav-depth1.mjs
 *
 * 产出：终端上的逐条 PASS/FAIL。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 服务端选择 ────────────────────────────────────────────────────────────
// 判据必须对**每一家**都成立，不能只在一家的形态上验过。
// 用法：
//   node --import ./tests/_register-loader.mjs --experimental-strip-types \
//     scripts/prod-webdav-depth1.mjs            # 默认 rclone
//   ... scripts/prod-webdav-depth1.mjs dufs      # 换一家
//   ... scripts/prod-webdav-depth1.mjs dufs 49322
//
// 每家的启动参数不同，所以「怎么起」是这个脚本里唯一与判据无关的部分。
const SERVER_KIND = (process.argv[2] ?? 'rclone').toLowerCase();
const PORT = Number(process.argv[3] ?? (SERVER_KIND === 'dufs' ? 49322 : 49321));
const USER = 'tapstack';
const PASS = 'tapstack-probe-pass';
const BASE = `http://127.0.0.1:${PORT}/`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/** 起一个真实的 WebDAV 服务端。 */
async function startServer(root) {
  // 每家的命令行不同；**判据**（下面的 check）不因服务端而变。
  const argv =
    SERVER_KIND === 'dufs'
      // dufs 的参数与 rclone 不同，两点都要踩过才知道：
      //   ① `--bind 127.0.0.1:PORT` 会被当成**unix socket 路径**（不开 TCP 端口）
      //      ⇒ 必须拆成 `--bind 127.0.0.1` + `--port PORT`；
      //   ② 它默认**只读** —— 场景 6 要写文件，所以必须开上传/删除。
      // 另：dufs 的 <href> 是**绝对路径**（/TapStack/groups/），
      // rclone 的是**绝对 URL** —— 这正是这家特有、必须真机验的形状差异。
      ? [
          'dufs', root,
          '--bind', '127.0.0.1',
          '--port', String(PORT),
          '--auth', `${USER}:${PASS}@/:rw`,
          '--allow-upload', '--allow-delete',
        ]
      : SERVER_KIND === 'rclone'
        ? ['rclone', 'serve', 'webdav', root, '--addr', `127.0.0.1:${PORT}`, '--user', USER, '--pass', PASS]
        : null;
  if (!argv) {
    throw new Error(
      `不认识的服务端「${SERVER_KIND}」—— 只支持 rclone / dufs。` +
        '加一家时请在这里补它的启动参数，判据部分不用动。'
    );
  }
  const proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', d => { err += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(BASE, {
        method: 'PROPFIND',
        headers: { Depth: '0', Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
      });
      if (res.status) { await res.text(); return proc; }
    } catch {
      /* 还没起来 */
    }
    await new Promise(r => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`${SERVER_KIND} WebDAV 服务端没起来：${err.slice(0, 600)}`);
}

async function main() {
  // 产品代码本身（走别名加载器，测的就是仓库里那份源码）
  const { WebDavClient } = await import('../src/sync-backend/webdav/client.ts');
  const { WebDavBackendAdapter } = await import('../src/sync-backend/webdav/adapter.ts');
  const { shardPath, encodeGroup } = await import('../src/sync-backend/webdav/layout.ts');

  const root = mkdtempSync(join(tmpdir(), 'tapstack-dav-'));
  let server;

  try {
    // ── 搭出真实的目录布局 ──────────────────────────────────────────────
    // ⚠️ 所有目录必须在**服务端启动前**建好：rclone serve webdav 在启动时
    //    把目录树读进内存，之后新建的目录它看不见（PROPFIND 回 404）。
    //    这不是产品缺陷，是探针的环境约束 —— 但它会伪装成「列不出来」，
    //    所以必须在探针里显式规避，否则会得出错误的结论。
    const shardDir = join(root, 'TapStack', 'groups', 'ab');
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(join(shardDir, 'abcdef12-3456-7890-abcd-ef1234567890.json'), '{"id":"x"}');
    writeFileSync(join(shardDir, 'notes.txt'), 'not a shard');
    mkdirSync(join(root, 'TapStack', 'groups', 'cd'), { recursive: true });
    writeFileSync(join(root, 'TapStack', 'groups', 'cd', 'cdef1234-5678-90ab-cdef-1234567890ab.json'), '{"id":"y"}');
    // 场景 3 用的空目录
    mkdirSync(join(root, 'TapStack', 'empty'), { recursive: true });

    // ── 场景 5 的分片也必须在启动前写好（同一个约束）────────────────────
    const mkGroup = (id, name, tabs) => ({
      id,
      name,
      notes: '',
      isFavorite: false,
      isLocked: false,
      isDeleted: false,
      tabs: tabs.map(([url, title]) => ({
        id: `t-${id}-${title}`, url, title, favicon: '', createdAt: '2026-10-20T00:00:00.000Z',
        lastAccessed: '2026-10-20T00:00:00.000Z',
      })),
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      version: 1,
      lastOp: { d: 'device-a', s: 1 },
    });
    const cloudGroups = [
      mkGroup('abcdef12-3456-7890-abcd-ef1234567890', '云端会话 A', [
        ['https://example.com/a', '页面 A'],
      ]),
      mkGroup('cdef1234-5678-90ab-cdef-1234567890ab', '云端会话 B', [
        ['https://example.com/b', '页面 B'],
      ]),
    ];
    for (const g of cloudGroups) {
      const p = join(root, 'TapStack', shardPath(g.id));
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, JSON.stringify({ v: 1, plain: encodeGroup(g) }));
    }

    server = await startServer(root);
    console.log(`\n── ${SERVER_KIND} WebDAV 已启动：${BASE} ──`);

    const client = new WebDavClient({ baseUrl: BASE, username: USER, password: PASS });

    // ══ 场景 1：真实的 Depth:1 响应，判据必须放行 ══════════════════════
    console.log('\n── 场景 1：真实服务端的 Depth:1 ──');
    {
      const r = await client.listDir('TapStack/groups');
      check('真实服务端列得出 groups/', r.listed === true, `listed=${r.listed}`);
      check(
        '列出了 2 个前缀子目录（ab / cd）',
        r.entries.length === 2,
        `entries=${r.entries.map(e => e.name).join(',') || '(空)'}`
      );
      check(
        '子目录被正确识别为 collection',
        r.entries.every(e => e.isCollection),
        JSON.stringify(r.entries.map(e => `${e.name}:${e.isCollection}`))
      );
      check(
        '路径归一正确（相对 baseUrl，无前后斜杠）',
        r.entries.every(e => e.path.startsWith('TapStack/groups/')),
        JSON.stringify(r.entries.map(e => e.path))
      );
    }

    // ══ 场景 2：前缀子目录的 Depth:1 —— 分片文件要能被认出来 ════════════
    console.log('\n── 场景 2：前缀子目录的 Depth:1 ──');
    {
      const r = await client.listDir('TapStack/groups/ab');
      check('真实服务端列得出 groups/ab/', r.listed === true, `listed=${r.listed}`);
      check(
        '列出了 2 个文件（1 个分片 + 1 个 notes.txt）',
        r.entries.length === 2,
        `entries=${r.entries.map(e => e.name).join(',') || '(空)'}`
      );
      check(
        '文件不是 collection',
        r.entries.every(e => !e.isCollection),
        JSON.stringify(r.entries.map(e => `${e.name}:${e.isCollection}`))
      );
    }

    // ══ 场景 3：空目录 —— 「列出来是空的」必须与「列不出来」分开 ════════
    console.log('\n── 场景 3：空目录 —— 空 ≠ 不知道 ──');
    {
      const r = await client.listDir('TapStack/empty');
      check(
        '空目录 listed=true 且 entries 为空',
        r.listed === true && r.entries.length === 0,
        `listed=${r.listed} entries=${r.entries.length}`
      );
    }

    // ══ 场景 4：不存在的目录 —— 必须 listed=false（列不出来）═════════════
    console.log('\n── 场景 4：不存在的目录 ──');
    {
      const r = await client.listDir('TapStack/nope');
      check('不存在的目录 listed=false', r.listed === false, `listed=${r.listed}`);
    }

    // ══ 场景 4b：目录**读不出来**（服务端拒绝这个方法）═════════════════
    //
    // 场景 4 验的是「目录不存在」（404）。但真实服务端的失败形态不止一种：
    // 有的实现会对 PROPFIND 直接回 405（方法不允许）��有的回 403。
    // 这些形态都必须落到**同一个结论**：listed=false（列不出来），
    // 而**不是** listed=true + 空清单（= 静默当成空库 ⇒ 云端有的会话被本机
    // 子集覆盖 ⇒ 对所有设备隐形且不可恢复）。
    //
    // 为什么在这里验而不是在单测里：这条闸的判据此前**从未被真机验证过**
    // —— 而「假服务器全绿」根本不能代表真机可用（见 rclone 那一轮抓到的 P0）。
    console.log('\n── 场景 4b：服务端拒绝列目录（405）──');
    {
      const { WebDavClient: RawClient } = await import('../src/sync-backend/webdav/client.ts');
      // 只在这个用例里把 fetch 换掉：真实服务端 + 真实客户端，只把**响应**换掉。
      // 这样验的是「客户端面对 405 时怎么判」，而不是「客户端能不能发请求」。
      const patched = new RawClient(
        { baseUrl: BASE, username: USER, password: PASS },
        async (url, init) => {
          // 只在这个用例里把**响应**换掉：真实客户端 + 假响应。
          // 目的是验「客户端面对 405 时怎么判」，不是验「服务端会不会回 405」。
          void url; void init;
          return new Response('', { status: 405, statusText: 'Method Not Allowed' });
        }
      );
      const r = await patched.listDir('TapStack/groups');
      check(
        '服务端回 405 ⇒ listed=false（列不出来，不是「空目录」）',
        r.listed === false,
        `listed=${r.listed}`
      );
      check(
        '405 时不得返回任何条目（否则会被当成空库）',
        Array.isArray(r.entries) && r.entries.length === 0,
        `entries=${r.entries?.length}`
      );
    }

    // ══ 场景 5：真实服务端下的完整重建路径（索引丢了 ⇒ 从目录重建）══════
    // 这是本次收紧最终服务的场景：manifest 不存在，但 groups/ 里有分片。
    // 判据若写歪（合法响应被判成「列不出来」），这里会抛错 ⇒ 同步全废。
    console.log('\n── 场景 5：索引丢了 ⇒ 从真实目录重建索引 ──');
    {
      const kv = {
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
        keys: async () => [],
      };
      const adapter = new WebDavBackendAdapter({
        client,
        config: { baseUrl: BASE, username: USER, password: PASS, rootPath: 'TapStack' },
        kv,
        now: () => '2026-10-20T08:00:00.000Z',
        peekDeviceSeq: async () => 1,
      });

      let got = null;
      let err = null;
      try {
        got = await adapter.downloadGroups();
      } catch (e) {
        err = e;
      }
      check(
        '索引丢了但分片在 ⇒ 重建成功（不抛错）',
        err === null,
        err ? String(err.message).slice(0, 200) : '无错'
      );
      check(
        '重建出了 2 个云端会话（不是当成空库返回 0 个）',
        Array.isArray(got) && got.length === 2,
        `got=${Array.isArray(got) ? got.length : JSON.stringify(got)}`
      );
      if (Array.isArray(got)) {
        check(
          '会话名对得上（说明读的是真内容，不是空壳）',
          got.map(g => g.name).sort().join(',') === '云端会话 A,云端会话 B',
          got.map(g => g.name).join(',')
        );
      }
    }
    // ══ 场景 6：完整往返（本机写 → 云端 → 读回）═════════════════════════
    // 到这里为止验的都是「读」这一侧。真正的产品闭环是「写进去再读回来」——
    // 而它跨了 MKCOL / PUT / 写索引 / 列目录 / 读回 五种操作，
    // 每一种都可能只在真实服务端上才暴露问题（比如 MKCOL 之后目录
    // 能不能被 Depth:1 列出来）。
    console.log('\n── 场景 6：写入 → 云端 → 读回（真实服务端）──');
    {
      const kv = {
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
        keys: async () => [],
      };
      const adapter = new WebDavBackendAdapter({
        client,
        config: { baseUrl: BASE, username: USER, password: PASS, rootPath: 'TapStack' },
        kv,
        now: () => '2026-10-20T08:00:00.000Z',
        peekDeviceSeq: async () => 1,
      });

      const mkLocal = (id, name) => ({
        id,
        name,
        notes: '',
        isFavorite: false,
        isLocked: false,
        isDeleted: false,
        tabs: [{
          id: `t-${id}`, url: `https://example.com/${id}`, title: `页面 ${name}`,
          favicon: '', createdAt: '2026-10-20T00:00:00.000Z',
          lastAccessed: '2026-10-20T00:00:00.000Z',
        }],
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
        version: 1,
        lastOp: { d: 'device-x', s: 10 },
      });

      // ⚠️ 用一个**全新的 id 前缀**，避免和场景 5 预置的云端分片混在一起。
      const local = mkLocal('11111111-2222-3333-4444-555555555555', '本机会话');
      let upErr = null;
      try {
        await adapter.uploadGroups([local]);
      } catch (e) {
        upErr = e;
      }
      check(
        '上传不抛错（MKCOL + PUT + 写索引在真实服务端上都成立）',
        upErr === null,
        upErr ? String(upErr.message).slice(0, 220) : '无错'
      );

      // 真实服务端上，索引文件必须真的落盘了
      const manifestRes = await client.get('TapStack/manifest.json');
      check(
        '云端真的多了一份索引（manifest.json 已落盘）',
        !!manifestRes && !('notFound' in manifestRes),
        manifestRes && 'notFound' in manifestRes ? 'manifest 不存在' : '存在'
      );

      // 再读回来：本机会话 + 预置的两个云端会话 = 3 个
      let got = null;
      let readErr = null;
      try {
        got = await adapter.downloadGroups();
      } catch (e) {
        readErr = e;
      }
      check(
        '下载不抛错',
        readErr === null,
        readErr ? String(readErr.message).slice(0, 220) : '无错'
      );
      check(
        '读回 3 个会话（2 个预置 + 1 个刚上传）',
        Array.isArray(got) && got.length === 3,
        `got=${Array.isArray(got) ? got.length : JSON.stringify(got)}`
      );
      if (Array.isArray(got)) {
        check(
          '刚上传的那个会话确实在里面（名字对得上）',
          got.some(g => g.name === '本机会话'),
          got.map(g => g.name).join(',')
        );
      }
    }
  } finally {
    server?.kill();
    rmSync(root, { recursive: true, force: true });
  }

  console.log('\n════════ 汇总 ════════');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
