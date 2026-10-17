/**
 * WebDAV 后端真机端到端验证（2026-10-13）。
 *
 * ── 为什么必须有这个脚本（单元测试覆盖不到的）──────────────────────────
 * 单元测试用的是**内存版 WebDAV 服务器**——它按我对协议的**理解**写的。
 * 凡是「我理解错了」的地方，测试与实现会一起错：全绿，线上炸。
 * 这正是 `.memory/` 里那条纪律说的：「判断 E2E 是否可靠，要看它依赖的环境前提」。
 *
 * 本脚本对**独立的真实实现**（dufs 0.46，Rust 写的，不是我们写的）跑一遍，
 * 专验调研报告里标注为「**推测，需实测**」的那几条：
 *   1. PROPFIND Depth:0 是否返回 207 且带 getetag
 *   2. MKCOL 建目录、重复建是否 405
 *   3. **PUT + 过期 If-Match 是否真的返回 412** ← 并发安全的整条防线押在它上面
 *   4. PUT + If-None-Match:'*' 对已存在资源是否 412
 *   5. 中文 / 空格路径在真实服务端能否读写
 * 之后跑适配器完整往返：A 上传 → B 下载 → B 改 → A 拉 → 迟到旧副本不覆盖 → A 删 → B 服从。
 *
 * ── 运行 ───────────────────────────────────────────────────────────────
 *   node --import ./tests/_register-loader.mjs --experimental-strip-types \
 *     scripts/e2e-webdav-local.mjs
 * 需要 dufs 在 PATH（brew install dufs）。KEEP=1 保留临时目录供人工检查。
 *
 * ── 结束条件与清理 ─────────────────────────────────────────────────────
 * 自带退出码（0 全通过 / 1 有失败）。无论成败都 kill dufs 并**确认它真的没了**，
 * 再删临时目录（曾因遗留 HTTP server 让用户看到后台任务一直跑，见 .memory/）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WebDavClient } = await import('@/sync-backend/webdav/client');
const { WebDavBackendAdapter } = await import('@/sync-backend/webdav/adapter');
const { shardPath } = await import('@/sync-backend/webdav/layout');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 事实记录：只报告服务端行为，不判通过/失败（不同服务端本来就不一样）。 */
const findings = [];
function finding(name, value) {
  findings.push({ name, value });
  console.log(`  ·  ${name}：${value}`);
}

// ── 内存 KV 与夹具（与单元测试同构，但不依赖测试文件）────────────────────
function makeKv(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    async get(k) {
      return data.has(k) ? data.get(k) : null;
    },
    async set(k, v) {
      data.set(k, v);
    },
    async remove(k) {
      data.delete(k);
    },
  };
}

const T0 = new Date('2026-10-13T10:00:00.000Z').toISOString();
function makeGroup(id, over = {}) {
  return {
    id,
    name: `会话 ${id}`,
    createdAt: T0,
    updatedAt: T0,
    isLocked: false,
    lastOp: { d: 'dev-A', s: 10 },
    tabs: [
      { id: `${id}-t1`, url: `https://example.com/${id}`, title: '标题', createdAt: T0, lastAccessed: T0, pinned: false },
    ],
    ...over,
  };
}

function makeAdapter({ client, base, kv, deviceSeq, passphrase }) {
  return new WebDavBackendAdapter({
    client,
    config: { baseUrl: base, username: 'x', password: 'y', rootPath: 'TapStack', passphrase },
    kv,
    peekDeviceSeq: async () => deviceSeq,
  });
}

// ── 起服务器 ───────────────────────────────────────────────────────────

const WORK = mkdtempSync(join(tmpdir(), 'tapstack-webdav-e2e-'));
const PORT = 45000 + Math.floor(Math.random() * 2000);
const USER = 'e2e-user';
const PASS = 'e2e-pass';
const BASE = `http://127.0.0.1:${PORT}/`;

const dufs = spawn(
  'dufs',
  [
    WORK,
    '--bind',
    '127.0.0.1',
    '--port',
    String(PORT),
    // ⚠️ `--auth` 只回答「谁能做什么」，写操作本身还要显式允许：
    // 第一次跑漏了 --allow-upload，MKCOL 直接 403（不是客户端的问题，是我的参数错）。
    '--auth',
    `${USER}:${PASS}@/:rw`,
    '--allow-upload',
    '--allow-delete',
    '--enable-cors',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
/** 进程退出的一次性等待器：直接读 `exitCode` 有时序陷阱（见下方清理段）。 */
const dufsExited = new Promise(res => dufs.once('exit', () => res(true)));

/**
 * 子进程是否已终止。
 *
 * ⚠️ **不能只看 `exitCode`**（2026-10-13 自己踩的）：被**信号**杀掉的子进程
 * `exitCode` 恒为 `null`，终止事实记在 `signalCode` 上
 * （Node 文档：exitCode 为 null「if the subprocess exited due to a signal」）。
 * 第一版只查 exitCode，于是进程明明已经死了，脚本还报「未退出」并把退出码
 * 判成失败 —— 一个**把成功报成失败**的假红，会让人去查不存在的问题。
 */
function hasExited() {
  return dufs.exitCode !== null || dufs.signalCode !== null;
}
let dufsLog = '';
dufs.stdout.on('data', d => (dufsLog += d));
dufs.stderr.on('data', d => (dufsLog += d));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE, { method: 'OPTIONS' });
      if (res.status > 0) return true;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

let exitCode = 1;
try {
  if (!(await waitReady())) throw new Error(`dufs 未在 5 秒内就绪。日志：\n${dufsLog}`);
  console.log(`dufs 已就绪：${BASE}（目录 ${WORK}）\n`);

  const client = new WebDavClient({ baseUrl: BASE, username: USER, password: PASS });

  console.log('【协议层实测：调研报告里的「推测」逐条验证】');

  await client.mkdirp('TapStack/groups/ab');
  check('MKCOL + PROPFIND 目录', (await client.stat('TapStack/groups/ab')).exists);
  await client.mkdirp('TapStack/groups/ab');
  check('MKCOL 重复建目录幂等（405 视为已存在，未抛错）', true);

  const put1 = await client.put('TapStack/probe.txt', 'v1', { ifNoneMatch: '*' });
  check('PUT 创建资源成功', true, `响应 ETag=${put1.etag ?? '（服务端未返回）'}`);

  const meta1 = await client.stat('TapStack/probe.txt');
  const got1 = await client.get('TapStack/probe.txt');
  // get() 自 2026-10-17 起有三态：内容 / { notFound } / null(304)。
  // 用 `?.` 会在「读不到」时静默变成 undefined，断言失败的原因会被
  // 指向「内容不对」而不是「文件没找到」——排错方向直接被带偏。
  const got1Body = got1 && !('notFound' in got1) ? got1.body : undefined;
  check(
    'PROPFIND / GET 能读到内容',
    got1Body === 'v1' && meta1.exists,
    got1 && 'notFound' in got1
      ? `读到的是 notFound（${got1.reason}）而非内容 —— 这是「文件不存在」，不是「内容不符」`
      : undefined
  );

  // ── 能力探测：这些是**事实记录**，不是断言 ────────────────────────────
  // 2026-10-13 实测发现：dufs **完全忽略**条件请求头。协议（RFC 4918/9110）
  // 定义了 If-Match/412，但没有任何东西强制服务器实现它。
  // 所以「服务端支不支持」必须记录事实；而「我们的探测函数猜得对不对」
  // 才是真正要断言的（见下）。
  finding('PUT 响应是否带 ETag', put1.etag ? '带' : '不带');
  finding('PROPFIND 是否返回 getetag', meta1.etag ? '返回' : '不返回（只返回 getlastmodified）');
  // 同上：三态返回必须先排除 notFound，否则「没读到」会被记成「服务器不发 ETag」。
  const got1Etag = got1 && !('notFound' in got1) ? got1.etag : null;
  finding('GET 响应是否带 ETag', got1Etag ? `带（${got1Etag}）` : got1 && 'notFound' in got1 ? `未读到内容（${got1.reason}）` : '不带');

  let conditionalWritesHonored = false;
  try {
    await client.put('TapStack/probe.txt', 'v2', { ifMatch: '"definitely-stale"' });
    conditionalWritesHonored = false;
  } catch (err) {
    conditionalWritesHonored = err?.isPreconditionFailed === true;
  }
  finding('过期 If-Match 是否被拒（412）', conditionalWritesHonored ? '被拒（服务端实现了条件写）' : '被接受 ⇒ 服务端忽略条件写');

  let ifNoneHonored = false;
  try {
    await client.put('TapStack/probe.txt', 'v3', { ifNoneMatch: '*' });
  } catch (err) {
    ifNoneHonored = err?.isPreconditionFailed === true;
  }
  finding('If-None-Match:* 对已存在资源是否被拒', ifNoneHonored ? '被拒' : '被接受 ⇒ 同上');

  // ★ 核心断言：适配器的能力探测必须与上面的**独立实测**结论一致。
  // 探测说谎会造成最坏的形态——代码以为有并发保护，用户被静默。
  const a0 = makeAdapter({ client, base: BASE, kv: makeKv({ device_id: 'probe' }), deviceSeq: 0, passphrase: null });
  const probed = await a0.probeConditionalWrites();
  check(
    'probeConditionalWrites() 与独立实测结论一致',
    probed === conditionalWritesHonored,
    `探测=${probed} 实测=${conditionalWritesHonored}`
  );

  // 探针文件不得留在用户目录（否则每跑一次同步就多一个垃圾文件）
  await new Promise(r => setTimeout(r, 100));
  check('能力探测的探针文件已清理', !existsSync(join(WORK, 'TapStack/.tapstack-probe')));

  await client.mkdirp('我的备份 目录/子层');
  await client.put('我的备份 目录/子层/文件.json', '{"中文":"内容"}');
  // 同上：读到 notFound 时要说「文件不存在」，而不是含糊地判成「内容不符」。
  const cnGot = await client.get('我的备份 目录/子层/文件.json');
  const cnBody = cnGot && !('notFound' in cnGot) ? cnGot.body : undefined;
  check(
    '中文 + 空格路径可读写',
    cnBody === '{"中文":"内容"}',
    cnGot && 'notFound' in cnGot ? `读到的是 notFound（${cnGot.reason}）而非内容` : undefined
  );

  await client.delete('TapStack/probe.txt');
  check('DELETE 后资源不存在', (await client.stat('TapStack/probe.txt')).exists === false);

  console.log('\n【适配器完整往返】');

  const a = makeAdapter({ client, base: BASE, kv: makeKv({ device_id: 'dev-A' }), deviceSeq: 10, passphrase: '口令-测试' });
  const g1 = makeGroup('aa11', { name: '工作会话', lastOp: { d: 'dev-A', s: 11 } });
  const g2 = makeGroup('bb22', { name: '研究资料', lastOp: { d: 'dev-A', s: 12 } });
  const upA = await a.uploadGroups([g1, g2]);
  check('设备 A 首次全量上传', upA.writtenIds.length === 2, `写入 ${upA.writtenIds.length} 个`);

  // ⚠️ 路径必须以 rootPath 为前缀：shardPath 返回的是**库内相对路径**
  //    （groups/aa/aa11.json），真实磁盘位置还要加上 TapStack/。
  //    第一次跑漏了前缀，报了 ENOENT —— 是我脚本的 bug，不是实现的。
  const cipher = readFileSync(join(WORK, 'TapStack', shardPath('aa11')), 'utf8');
  check('云端分片是密文（不含会话名明文）', !cipher.includes('工作会话') && cipher.includes('"enc"'), `${cipher.length} 字节`);
  const manifestRaw = readFileSync(join(WORK, 'TapStack/manifest.json'), 'utf8');
  check('manifest 明文（探活需要）且不含会话内容', !manifestRaw.includes('工作会话') && manifestRaw.includes('"shards"'));

  const b = makeAdapter({ client, base: BASE, kv: makeKv({ device_id: 'dev-B' }), deviceSeq: 5, passphrase: '口令-测试' });
  const downloaded = await b.downloadGroups();
  check('设备 B 下载并解密', downloaded.length === 2, `拿到 ${downloaded.length} 个`);
  check('解密后内容正确', downloaded.map(g => g.name).sort().join(',') === '工作会话,研究资料');

  const g1b = makeGroup('aa11', { name: '工作会话（B 改过）', lastOp: { d: 'dev-B', s: 99 } });
  const untouchedBefore = readFileSync(join(WORK, 'TapStack', shardPath('bb22')), 'utf8');
  const upB = await b.uploadGroups([g1b]);
  const untouchedAfter = readFileSync(join(WORK, 'TapStack', shardPath('bb22')), 'utf8');
  check('增量：只写变更的那个分片', upB.writtenIds.length === 1 && untouchedBefore === untouchedAfter);

  const seen = (await a.downloadGroups()).find(g => g.id === 'aa11');
  check('设备 A 看到 B 的改动', seen?.name === '工作会话（B 改过）', seen?.name ?? '未找到');

  const upStale = await a.uploadGroups([makeGroup('aa11', { name: 'A 的旧版本', lastOp: { d: 'dev-A', s: 3 } })]);
  const afterStale = await b.downloadGroups();
  check('过期副本不覆盖云端新版本（认输预检）', upStale.writtenIds.length === 0 && afterStale.find(g => g.id === 'aa11')?.name === '工作会话（B 改过）');

  await a.broadcastDeletes(['bb22']);
  const tomb = (await b.downloadGroups()).find(g => g.id === 'bb22');
  check('删除广播：B 收到墓碑', tomb?.isDeleted === true, `isDeleted=${tomb?.isDeleted}`);

  await a.uploadSettings({ groupNameTemplate: '测试 %d' });
  check('设置同步往返', (await b.downloadSettings())?.groupNameTemplate === '测试 %d');

  console.log('\n【落盘结构】');
  const prefixes = existsSync(join(WORK, 'TapStack/groups')) ? readdirSync(join(WORK, 'TapStack/groups')) : [];
  check('分片按 id 前两位分目录', prefixes.includes('aa') && prefixes.includes('bb'), `[${prefixes.join(',')}]`);
  check('明文设置不落盘', !readFileSync(join(WORK, 'TapStack/settings.json'), 'utf8').includes('测试 %d'));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(64)}`);
  console.log('【服务端能力实测结论】（供选型参考，非通过/失败）');
  for (const f of findings) console.log(`   · ${f.name}：${f.value}`);
  if (!conditionalWritesHonored) {
    console.log(
      '   ⚠️ 该服务端忽略条件写 ⇒ 真正的乐观锁不存在。' +
        '并发保护退化为「认输预检」（stamp 比较，与服务端无关，下方已断言）。'
    );
  }
  console.log('');
  if (failed.length === 0) {
    console.log(`✅ 全部通过：${results.length} 项`);
    exitCode = 0;
  } else {
    console.log(`❌ 失败 ${failed.length} / ${results.length} 项：`);
    for (const f of failed) console.log(`   · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
} catch (err) {
  console.error('\n❌ 脚本异常终止：', err);
  console.error('dufs 日志尾部：\n', dufsLog.slice(-2000));
  exitCode = 1;
} finally {
  // ── 清理：kill 子进程，并**等待它真的退出** ──────────────────────────
  // 不能只读 `dufs.exitCode`：Node 的子进程退出是异步的，kill 之后立刻读
  // 通常还是 null —— 那会报「未清理」，而实际上它几百毫秒后就没了
  // （第一次跑就误报过一次）。用 exit 事件 + 超时才是有证据的判断。
  dufs.kill('SIGTERM');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  if (!hasExited()) dufs.kill('SIGKILL');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  const cleaned = hasExited();
  console.log(`\n清理：dufs 已退出=${cleaned}`);
  if (!cleaned) exitCode = 1;
  if (process.env.KEEP === '1') console.log(`临时目录保留：${WORK}`);
  else if (cleaned) rmSync(WORK, { recursive: true, force: true });
}

process.exit(exitCode);
