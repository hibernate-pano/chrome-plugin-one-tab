/**
 * **真实** WebDAV 服务端的 Depth:1 列目录形状记录（2026-11-17）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 台账里那条「三家 WebDAV 各跑一次列目录实测」一直挂着，原因是**工具其实不存在**：
 * · `scripts/webdav-capability-matrix.mjs` 的文件头写着
 *   `--url/--user/--pass` 的用法，但代码里 `argOf` **定义了却从没被调用**，
 *   `SERVERS` 写死三个本地实现 ⇒ 它测不了真实服务端；
 * · `scripts/prod-webdav-depth1.mjs` 测的是 Depth:1，但服务端是它自己在
 *   本机起的 rclone ⇒ 测的是「判据 × 参照实现」，不是「判据 × 真实服务商」。
 *
 * 而那道闸恰恰是**收紧**出来的（2026-10-22～23：读不懂的 207 从「当成空库」
 * 改成 fail-closed `listed:false`）。收紧的判据**从未在真实服务商身上验过** ——
 * 万一写歪了，合法响应也被判成「列不出来」⇒ 所有 WebDAV 用户同步全废
 * （比收紧前更糟）。这不是假想：rclone 那一轮就抓到过一个 P0
 * （`<collection>` 上带命名空间声明属性 ⇒ 目录被判成文件）。
 *
 * ── 本脚本记什么（与台账那条待办的检查点一一对应）────────────────────────
 *   ① Depth:1 PROPFIND 的**状态码**；
 *   ② 正文里**有没有 `<multistatus>`**；
 *   ③ **有没有 `<response>` 块**（几个）；
 *   ④ **每个块有没有 `<href>`**；
 *   ⑤ `<href>` 是**绝对 URL / 绝对路径 / 相对路径**哪一种；
 *   ⑥ 目录**真的有分片时**，列出来的条目数是否与磁盘上的文件数一致；
 *   ⑦ 产品代码面对同一个响应判成「列得出」还是「列不出」——
 *      **合法响应被 fail-closed 误伤 ⇒ 同步全废**，这是最要紧的一条。
 *
 * ── 为什么同时用「裸 fetch」和「产品客户端」两路 ─────────────────────────
 * 只用自家客户端测 ⇒ 测出来的是「客户端 + 服务端」的**合成行为**，分不清是谁的问题；
 * 只用裸 fetch 测 ⇒ 不知道产品会不会把它判成「列不出来」。
 * ⇒ 两路都跑，各记各的；两路一致才说明这条链路在这家服务商上是通的。
 *
 * ── 凭据怎么进来（**安全约束，改前先读**）────────────────────────────────
 * 只走**环境变量**：`WEBDAV_URL` / `WEBDAV_USER` / `WEBDAV_PASS`。
 * ⚠️ **不要**改成命令行参数：`--pass xxx` 会出现在 `ps` 的输出与 shell history 里。
 * ⚠️ 本脚本**任何分支都不打印密码**（连长度都不打）。
 * 用法：
 *   set -a; . ./.env.webdav.local; set +a
 *   node --import ./tests/_register-loader.mjs --experimental-strip-types \
 *     scripts/real-webdav-depth1.mjs
 *
 * ── 副作用与清理 ─────────────────────────────────────────────────────────
 * 会在**固定工作区** `TapStack-probe/` 下建一个随机的 `run-<随机>/` 目录，
 * 在里面 MKCOL / PUT 几个小文件，跑完**逐个 DELETE**，最后删 run 目录本身，
 * 并断言它真的没了（PROPFIND ⇒ 404，不是「列出来是空的」）。
 *
 * ⚠️ 为什么是「固定工作区 + 随机 run 目录」，而不是「每次随机一个根目录」
 *    （2026-11-17 在坚果云上撞出来后改的）：
 *   坚果云**禁止通过 WebDAV 删除/移动根目录下的文件夹** ——
 *   DELETE / MOVE 一律 403 `OperationNotAllowed`（空目录也一样；
 *   子目录与文件都能正常删）。原来的设计每跑一次就在云盘根上留一个
 *   删不掉的 `TapStack-probe-<随机>/` ⇒ 跑三次就是三个垃圾目录。
 *   改成固定工作区后，只有**一个**可复用目录留在根上；run 目录是它的子目录
 *   ⇒ 每次都能删干净。工作区与产品的 `TapStack/` 根目录**完全分开**
 *   ⇒ 不碰用户自己的同步数据。
 */
import { randomUUID } from 'node:crypto';

// ── 凭据（只从环境变量读）────────────────────────────────────────────────
const URL_ = process.env.WEBDAV_URL;
const USER = process.env.WEBDAV_USER;
const PASS = process.env.WEBDAV_PASS;

if (!URL_ || !USER || !PASS) {
  console.error(
    '缺少凭据：请先 `set -a; . ./.env.webdav.local; set +a`（WEBDAV_URL / WEBDAV_USER / WEBDAV_PASS）。\n' +
      '⚠️ 刻意**不支持**命令行传密码：`--pass` 会进 `ps` 与 shell history。',
  );
  process.exit(2);
}

const BASE = URL_.endsWith('/') ? URL_ : `${URL_}/`;
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
/** 固定工作区（根级）：坚果云不允许删根级目录 ⇒ 只建一次、反复复用。 */
const WORKSPACE = 'TapStack-probe';
/** 本次运行的隔离目录（工作区的子目录 ⇒ 每次都能删干净）。 */
const RUN_DIR = `${WORKSPACE}/run-${randomUUID().slice(0, 8)}`;

let passCount = 0;
let failCount = 0;
/** 记一条结论（**只记结论，不记凭据**）。 */
const check = (label, ok, detail = '') => {
  if (ok) {
    passCount++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
/** 只记事实（不改判据），供台账抄。 */
const note = (label, value) => console.log(`  · ${label}: ${value}`);

/** 一次 Depth:1 PROPFIND 的**原始**结果（不经产品代码）。 */
const rawPropfind = async (path) => {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getetag/>' +
    '<D:getlastmodified/><D:getcontentlength/></D:prop></D:propfind>';
  const res = await fetch(BASE + path, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', Authorization: AUTH },
    body,
  });
  const text = await res.text();
  const blocks = [...text.matchAll(/<(?:[A-Za-z0-9]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9]+:)?response>/g)].map(
    m => m[0],
  );
  const hrefs = blocks.map(b => (b.match(/<(?:[A-Za-z0-9]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href>/) ?? [])[1]);
  return { status: res.status, text, blocks, hrefs };
};

/** `<href>` 是哪种形态？绝对 URL / 绝对路径 / 相对路径 / 其它。 */
const hrefForm = (href) => {
  if (!href) return '缺失';
  if (/^https?:\/\//i.test(href)) return '绝对 URL';
  if (href.startsWith('/')) return '绝对路径';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return '带 scheme 的 URI';
  return '相对路径';
};

/**
 * `<href>` ⇒ 相对 baseUrl 的路径（去掉前后斜杠）。
 *
 * ⚠️ 为什么不能直接去掉第一个 `/`（2026-11-17 在坚果云上踩到）：
 *   坚果云的 href 是**带 base 路径的绝对路径**：`/dav/TapStack-probe/...`
 *   （baseUrl 是 `https://dav.jianguoyun.com/dav/`）。直接去首斜杠得到
 *   `dav/TapStack-probe/...` ⇒ 与产品侧的 `TapStack-probe/...` 永远不相等
 *   ⇒ Depth:1 响应里的「被查目录自己」过滤不掉 ⇒ 两路对账**假红**。
 *   这里按 baseUrl 的 pathname（如 `/dav/`）剥前缀；rclone 那种绝对 URL
 *   先取 pathname 再剥。
 */
const relFromBase = (href) => {
  let p = String(href ?? '').trim();
  if (!p) return '';
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return '';
  }
  const basePath = new URL(BASE).pathname; // 以 / 结尾（BASE 已归一）
  if (p.startsWith(basePath)) p = p.slice(basePath.length);
  else p = p.replace(/^\//, '');
  return p.replace(/\/+$/, '');
};

const mkcol = async (path) => {
  const res = await fetch(BASE + path, { method: 'MKCOL', headers: { Authorization: AUTH } });
  return res.status;
};
const put = async (path, content) => {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: content,
  });
  return res.status;
};
const del = async (path) => {
  const res = await fetch(BASE + path, { method: 'DELETE', headers: { Authorization: AUTH } });
  return res.status;
};

console.log(`\n── 真实服务端 Depth:1 实测 ──`);
console.log(`端点: ${BASE}`);
console.log(`工作区: ${WORKSPACE}/（固定、复用——坚果云禁止删根级目录，所以不删它）`);
console.log(`本次运行目录: ${RUN_DIR}/（子目录 ⇒ 跑完删干净）`);

// ── 建夹具 ───────────────────────────────────────────────────────────────
const shardName = `${randomUUID()}.json`;
try {
  // 工作区：固定名字 ⇒ 已存在（405）是常态，不是错误。
  const mkWs = await mkcol(WORKSPACE);
  if (!(mkWs === 201 || mkWs === 200 || mkWs === 405)) {
    console.error(`❌ MKCOL ${WORKSPACE} ⇒ HTTP ${mkWs} —— 这家服务商可能不支持 MKCOL。`);
    console.error('   （不支持 MKCOL 不等于不可用：产品写路径需要它，但读路径未必。）');
  }
  const mk = await mkcol(RUN_DIR);
  if (!(mk === 201 || mk === 200)) {
    console.error(`⚠️ MKCOL ${RUN_DIR} ⇒ HTTP ${mk} —— 后面的场景可能因此失败。`);
  }
  for (const dir of [`${RUN_DIR}/groups`, `${RUN_DIR}/groups/ab`, `${RUN_DIR}/empty`]) {
    const st = await mkcol(dir);
    if (!(st === 201 || st === 200 || st === 405)) console.error(`⚠️ MKCOL ${dir} ⇒ HTTP ${st}`);
  }
  // 分片文件 + 一个**不是**分片的文件（探针要能区分「文件」与「目录」）
  const s1 = await put(`${RUN_DIR}/groups/ab/${shardName}`, JSON.stringify({ v: 1, plain: 'probe' }));
  const s2 = await put(`${RUN_DIR}/groups/ab/notes.txt`, 'not a shard');
  note('PUT 分片文件', `HTTP ${s1}`);
  note('PUT 普通文件', `HTTP ${s2}`);
} catch (err) {
  console.error('❌ 建夹具失败：', String(err?.message ?? err));
}

// ── 场景 A：裸 fetch 的 Depth:1 形状（服务端本身的行为）──────────────────
console.log('\n── 场景 A：裸 fetch 的 Depth:1 响应形状 ──');
let rawGroups = null;
try {
  rawGroups = await rawPropfind(`${RUN_DIR}/groups`);
  note('Depth:1 PROPFIND 状态码', String(rawGroups.status));
  note('正文里有 <multistatus>', rawGroups.text.includes('multistatus') ? '有' : '没有');
  note('<response> 块数', String(rawGroups.blocks.length));
  note(
    '每个块都有 <href>',
    rawGroups.hrefs.every(h => typeof h === 'string' && h.length > 0) ? '是' : '否',
  );
  const forms = [...new Set(rawGroups.hrefs.map(hrefForm))];
  note('<href> 形态', forms.join('、') || '(无)');
  note('<href> 原样', JSON.stringify(rawGroups.hrefs));

  check('Depth:1 PROPFIND 状态码是 207（多状态）', rawGroups.status === 207, `实际 ${rawGroups.status}`);
  check('正文含 <multistatus>', rawGroups.text.includes('multistatus'));
  check('有 <response> 块', rawGroups.blocks.length > 0, `${rawGroups.blocks.length} 个`);
  check('每个 <response> 块都有 <href>', rawGroups.hrefs.every(h => typeof h === 'string' && h.length > 0));
} catch (err) {
  check('裸 fetch 的 Depth:1 请求', false, String(err?.message ?? err));
}

// ── 场景 B：产品代码面对同一个响应（判据会不会误伤）──────────────────────
console.log('\n── 场景 B：产品代码（WebDavClient.listDir）面对同一个响应 ──');
try {
  const { WebDavClient } = await import('../src/sync-backend/webdav/client.ts');
  const client = new WebDavClient({ baseUrl: BASE, username: USER, password: PASS });

  const g = await client.listDir(`${RUN_DIR}/groups`);
  check('合法响应被放行（listed=true，不是「列不出来」）', g.listed === true, `listed=${g.listed}`);
  check(
    '列出的条目数与磁盘一致（groups/ 下有 1 个子目录）',
    g.entries.length === 1,
    `entries=${g.entries.map(e => e.name).join(',') || '(空)'}`,
  );
  check(
    '子目录被识别为 collection',
    g.entries.every(e => e.isCollection),
    JSON.stringify(g.entries.map(e => `${e.name}:${e.isCollection}`)),
  );

  const a = await client.listDir(`${RUN_DIR}/groups/ab`);
  check('列得出前缀子目录（listed=true）', a.listed === true, `listed=${a.listed}`);
  check(
    '文件数与磁盘一致（1 个分片 + notes.txt）',
    a.entries.length === 2,
    `entries=${a.entries.map(e => e.name).join(',') || '(空)'}`,
  );
  check(
    '文件**不是** collection',
    a.entries.every(e => !e.isCollection),
    JSON.stringify(a.entries.map(e => `${e.name}:${e.isCollection}`)),
  );

  const e = await client.listDir(`${RUN_DIR}/empty`);
  check('空目录：listed=true 且条目为空（空 ≠ 不知道）', e.listed === true && e.entries.length === 0, `listed=${e.listed} entries=${e.entries.length}`);

  const n = await client.listDir(`${RUN_DIR}/nope`);
  check('不存在的目录：listed=false（列不出来）', n.listed === false, `listed=${n.listed}`);

  if (rawGroups) {
    // 裸 fetch 看到的**子目录**（Depth:1 的响应里含被查目录自己 ⇒ 先去掉它）
    const selfPath = `${RUN_DIR}/groups`;
    const rawNames = rawGroups.hrefs.map(relFromBase).filter(p => p && p !== selfPath);
    note('裸 fetch 看到的子目录（href 已剥 base 前缀）', JSON.stringify(rawNames));
    check(
      '两路一致：产品列出的条目数 = 裸 fetch 看到的子目录数',
      g.entries.length === rawNames.length,
      `产品 ${g.entries.length} vs 裸 ${rawNames.length}`,
    );
  }
} catch (err) {
  check('产品客户端的 Depth:1 路径', false, String(err?.message ?? err));
}

// ── 清理 ─────────────────────────────────────────────────────────────────
console.log('\n── 清理本次运行目录 ──');
try {
  for (const f of [`${RUN_DIR}/groups/ab/${shardName}`, `${RUN_DIR}/groups/ab/notes.txt`]) {
    const st = await del(f);
    note(`DELETE ${f.split('/').pop()}`, `HTTP ${st}`);
  }
  for (const d of [`${RUN_DIR}/groups/ab`, `${RUN_DIR}/groups`, `${RUN_DIR}/empty`, RUN_DIR]) {
    const st = await del(d);
    note(`DELETE ${d}`, `HTTP ${st}`);
  }
  // ⚠️ 验干净必须问「它还在不在」，而不是「列出来是不是空的」：
  //   不存在的目录和被删空的目录，在 Depth:1 下都可能只剩「自己」一个块
  //   —— 用「块数 ≤ 1」当判据，等于**目录还留着也绿灯**。
  //   （2026-11-17：这条判据曾在坚果云上假绿，而根目录其实 403 没删掉。）
  const after = await rawPropfind(RUN_DIR);
  check('运行目录已真的删掉（PROPFIND ⇒ 404）', after.status === 404, `HTTP ${after.status}`);
  note('固定工作区（保留复用，不删）', `${WORKSPACE}/`);
} catch (err) {
  console.error('⚠️ 清理异常：', String(err?.message ?? err));
  console.error(`   请手动删掉云端目录：${RUN_DIR}/`);
}

console.log(`\n════════ 汇总 ════════`);
console.log(`${passCount} 通过 / ${failCount} 失败`);
if (failCount > 0) {
  console.log(
    '\n⚠️ 有失败项：**先别急着下结论**——把上面每一条的原始值抄进台账，\n' +
      '   特别要分清「服务端形态特殊」与「我们的判据写歪了」这两种可能。',
  );
}
process.exit(failCount > 0 ? 1 : 0);
