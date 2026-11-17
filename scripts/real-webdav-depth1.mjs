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
 * 会在**探针目录**（`TapStack-probe-<随机>`）里 MKCOL / PUT 几个小文件，
 * 跑完**逐个 DELETE**（先文件后目录）。探针目录与产品的 `TapStack/` 根目录
 * **完全分开** ⇒ 不碰用户自己的同步数据。清理在 `finally` 里做，
 * 中途失败也会清。清理结果会打印出来（清不掉 = 云端留了垃圾，需要人处理）。
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
const PROBE_ROOT = `TapStack-probe-${randomUUID().slice(0, 8)}`;

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
console.log(`探针目录: ${PROBE_ROOT}/（与产品的 TapStack/ 根目录分开，不碰用户数据）`);

// ── 建夹具 ───────────────────────────────────────────────────────────────
const created = [];
const shardName = `${randomUUID()}.json`;
try {
  const mk = await mkcol(PROBE_ROOT);
  if (mk === 201 || mk === 200 || mk === 405) {
    // 405 = 已存在（本探针目录是随机的，撞上几乎不可能）⇒ 当作可继续。
    created.push(PROBE_ROOT);
  } else {
    console.error(`❌ MKCOL ${PROBE_ROOT} ⇒ HTTP ${mk} —— 这家服务商可能不支持 MKCOL。`);
    console.error('   （不支持 MKCOL 不等于不可用：产品写路径需要它，但读路径未必。）');
  }
  for (const dir of [`${PROBE_ROOT}/groups`, `${PROBE_ROOT}/groups/ab`, `${PROBE_ROOT}/empty`]) {
    const st = await mkcol(dir);
    if (st === 201 || st === 200 || st === 405) created.push(dir);
    else console.error(`⚠️ MKCOL ${dir} ⇒ HTTP ${st}`);
  }
  // 分片文件 + 一个**不是**分片的文件（探针要能区分「文件」与「目录」）
  const s1 = await put(`${PROBE_ROOT}/groups/ab/${shardName}`, JSON.stringify({ v: 1, plain: 'probe' }));
  const s2 = await put(`${PROBE_ROOT}/groups/ab/notes.txt`, 'not a shard');
  note('PUT 分片文件', `HTTP ${s1}`);
  note('PUT 普通文件', `HTTP ${s2}`);
} catch (err) {
  console.error('❌ 建夹具失败：', String(err?.message ?? err));
}

// ── 场景 A：裸 fetch 的 Depth:1 形状（服务端本身的行为）──────────────────
console.log('\n── 场景 A：裸 fetch 的 Depth:1 响应形状 ──');
let rawGroups = null;
try {
  rawGroups = await rawPropfind(`${PROBE_ROOT}/groups`);
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

  const g = await client.listDir(`${PROBE_ROOT}/groups`);
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

  const a = await client.listDir(`${PROBE_ROOT}/groups/ab`);
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

  const e = await client.listDir(`${PROBE_ROOT}/empty`);
  check('空目录：listed=true 且条目为空（空 ≠ 不知道）', e.listed === true && e.entries.length === 0, `listed=${e.listed} entries=${e.entries.length}`);

  const n = await client.listDir(`${PROBE_ROOT}/nope`);
  check('不存在的目录：listed=false（列不出来）', n.listed === false, `listed=${n.listed}`);

  if (rawGroups) {
    // 裸 fetch 看到的**子目录**（Depth:1 的响应里含被查目录自己 ⇒ 先去掉它）
    const rawNames = rawGroups.hrefs
      .map(h => (h ?? '').replace(/^\//, '').replace(/\/$/, ''))
      .filter(h => h && h !== `${PROBE_ROOT}/groups`);
    note('裸 fetch 看到的子目录', JSON.stringify(rawNames));
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
console.log('\n── 清理探针目录 ──');
try {
  for (const f of [`${PROBE_ROOT}/groups/ab/${shardName}`, `${PROBE_ROOT}/groups/ab/notes.txt`]) {
    const st = await del(f);
    note(`DELETE ${f.split('/').pop()}`, `HTTP ${st}`);
  }
  for (const d of [`${PROBE_ROOT}/groups/ab`, `${PROBE_ROOT}/groups`, `${PROBE_ROOT}/empty`, PROBE_ROOT]) {
    const st = await del(d);
    note(`DELETE ${d}`, `HTTP ${st}`);
  }
  // 验干净：列一次探针根目录，不该再有它
  const after = await rawPropfind(PROBE_ROOT);
  check(
    '探针目录已清空（列不出内容）',
    after.blocks.length === 0 || after.blocks.length === 1,
    `blocks=${after.blocks.length}`,
  );
} catch (err) {
  console.error('⚠️ 清理异常：', String(err?.message ?? err));
  console.error(`   请手动删掉云端目录：${PROBE_ROOT}/`);
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
