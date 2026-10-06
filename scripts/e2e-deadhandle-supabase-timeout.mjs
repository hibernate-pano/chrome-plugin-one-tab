// 真实浏览器验证两条「单测证明不了」的修复（2026-10-06）。
//
// 为什么要真跑，而不是靠单测 + 内存桩：
//
//   A) IndexedDB 死句柄。生产故障是「Chrome 单方面关闭 IDB 连接，JS 变量仍指向
//      它」，此后 db.transaction() 永久挂起 → mutationQueue 的 running 永为 true
//      → 单写者队列被占死 → 之后所有命令都排在它后面（用户看到「点了没反应」）。
//      node 的内存桩只能*模拟*挂起，证明不了真实 IDBDatabase 在这种状态下的行为，
//      也证明不了修复后的 abort/重开真的能自愈。
//
//   B) Supabase 请求级超时。单测证明的是「我调用了自定义 fetch」——
//      上一版 e2e 更糟，测的竟是页面里手写的原生 fetch，与本仓库实现毫无关系，
//      属于自欺欺人。这里改为让**真实的 supabase 客户端**发出**真实请求**，
//      断言它确实带上了我们注入的 signal（超时能生效的前提）。
//
// 不等 45s：那个上界由 tests/supabaseRequestTimeout.test.ts 的常量断言守住
// （并与 popup 的 30s 协议上界联动）。e2e 等 45s 没有意义。
//
// 退出码非 0 表示失败（走 createGate）。
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup, login } from './e2e-helpers.mjs';
import { createGate, TEST_EMAIL_DOMAIN, accountMarker } from './e2e-support.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const label = process.argv[2] || 'deadhandle';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();
const gate = createGate();

const SEED = [{
  id: `seed-${rid()}`,
  name: '存活会话',
  tabs: [{ id: `t-${rid()}`, url: 'https://keep.example.com', title: 'keep',
    createdAt: now(), lastAccessed: now(), pinned: false }],
  createdAt: now(), updatedAt: now(), isLocked: false, version: 1,
}];

/** 在 SW 上下文里写真实 IDB（kv store 须已由 UI 首屏建立） */
async function seedViaSW(sw, groups) {
  await sw.evaluate(async (gs) => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); throw new Error('kv store 尚未建立'); }
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: gs });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
  }, groups);
}

const ctx = await launchCtx(label);
let failed = false;
try {
  // 构建前置检查：本脚本的 B 段判据依赖「缩短的上界」才成立（见文件头）。
  // 用生产构建跑会白等 45s，最后拿 Playwright 自己的 90s 路由超时收场 ——
  // 那既不是被我们的超时救回来的，也会让脚本整体超时。fail fast 并说清怎么修。
  const distDir = resolve(process.cwd(), 'dist');
  if (!existsSync(distDir)) {
    throw new Error('未找到 dist/ —— 请先运行：VITE_SYNC_REQUEST_TIMEOUT_MS=3000 pnpm build');
  }
  const builtTimeout = (() => {
    // 产物里形如 `setTimeout(()=>r.abort(),hn)`，hn 是压缩后的常量名；
    // 真正的数值在 IIFE 三元里（`:45e3` 或 `:3e3`）。两处都找。
    for (const f of readdirSync(distDir)) {
      if (!f.endsWith('.js')) continue;
      const s = readFileSync(join(distDir, f), 'utf8');
      if (!s.includes('AbortController')) continue;
      const m = s.match(/Number\.isFinite\(\w+\)&&\w+>0\?\w+:([\de]+)/);
      if (m) return Number(m[1]);
    }
    return null;
  })();
  if (builtTimeout !== null && builtTimeout > 10_000) {
    throw new Error(
      `当前 dist 的请求超时上界是 ${builtTimeout}ms（生产值）。` +
      'B 段要验证「挂住的请求被中止」，45s 会让脚本整体超时。\n' +
      '   请改用：VITE_SYNC_REQUEST_TIMEOUT_MS=3000 pnpm build'
    );
  }

  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  let sw = ctx.serviceWorkers()[0];
  if (!sw) throw new Error('未找到扩展 service worker');
  const extId = sw.url().split('/')[2];

  const page = await openPopup(ctx, extId);
  await dismissOnboarding(page);
  // 首屏 loadGroups 会触发 ensureVersion 建库；先让它跑完再写数据。
  await page.waitForTimeout(2500);
  await seedViaSW(sw, SEED);
  await page.waitForTimeout(500);

  // ── 登录 ──
  //
  // B 部分（真实网络路径）**必须**已登录：downloadAndMerge 的第一道门就是
  // ensureAuthenticated，未登录时直接返回 not_authenticated，一个请求都不会发 ——
  // 上一版正是因此「未命中任何请求」。e2e 用脚本自建的测试账号（test.tapstack.dev），
  // 不需要预置凭据；run-e2e 收尾会按域名把它清理掉。
  const email = `e2e-${rid()}@${TEST_EMAIL_DOMAIN}`;
  const password = 'Tapstack-e2e-2026!x';
  console.log(accountMarker(email));
  await login(page, email, password, { register: true });

  // ══ A) 真实 IndexedDB 句柄失效 ══
  //
  // 复现方式：真实打开一条句柄 → 确认可用 → 单方面 close()（等价于浏览器
  // 回收连接）→ 在已关闭的句柄上建事务。这就是生产里「变量在、连接没了」
  // 之后的真实 API 行为，不需要内存桩。
  const probe = await sw.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('tabvaultpro', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(new Error('open failed'));
    });
    const okBefore = await new Promise((res) => {
      const tx = db.transaction('kv', 'readonly');
      const q = tx.objectStore('kv').get('tab_groups');
      q.onsuccess = () => res(true);
      q.onerror = () => res(false);
    });
    db.close();
    let threw = null;
    try {
      db.transaction('kv', 'readonly');
    } catch (e) {
      threw = e?.name ?? String(e);
    }
    return { okBefore, threw };
  });
  gate.check('真实 IDB 句柄在关闭前可用', probe.okBefore === true, JSON.stringify(probe));
  gate.check('真实 IDB 句柄关闭后建事务抛 InvalidStateError（不是静默挂起）',
    typeof probe.threw === 'string' && /InvalidState/i.test(probe.threw),
    `实际：${probe.threw}`);

  // 关键行为：扩展自己的写路径在句柄失效后必须**失败得干净**（不挂起、
  // 不吞错），并且**下一次调用能自愈** —— 这正是看门狗要保护的两件事。
  const first = await page.evaluate(async () => {
    const t0 = Date.now();
    const res = await chrome.runtime.sendMessage({
      type: 'MUTATE',
      data: { op: 'renameGroup', groupId: '__probe__', name: 'x' },
    });
    return { ms: Date.now() - t0, responded: res !== undefined };
  });
  gate.check('句柄失效后语义命令仍有界返回（未挂起）',
    first.responded === true && first.ms < 10000, JSON.stringify(first));

  // 自愈：数据必须还在，且再发一条命令仍然正常（看门狗丢弃句柄后重开）
  const groupsAfter = await readGroupsFromSW(ctx);
  gate.check('故障后本地数据完好（未被故障清空）',
    groupsAfter.some(g => g.id === SEED[0].id),
    `现有：${groupsAfter.map(g => g.name).join(',')}`);

  const second = await page.evaluate(async () => {
    const t0 = Date.now();
    const res = await chrome.runtime.sendMessage({
      type: 'MUTATE',
      data: { op: 'renameGroup', groupId: '__probe2__', name: 'y' },
    });
    return { ms: Date.now() - t0, responded: res !== undefined };
  });
  gate.check('后续命令仍正常（看门狗后队列可继续服务）',
    second.responded === true && second.ms < 10000, JSON.stringify(second));

  // ══ B) 请求级超时真的会触发（真实网络 + 真实 abort） ══
  //
  // 先确认登录态还在：B 段必须真的发得出带鉴权的请求，否则 downloadAndMerge
  // 会在 ensureAuthenticated 就返回 not_authenticated —— 请求根本没发出去，
  // 判据就会因为「没等超时」而假绿（第一版踩过：命中拦截 0 次）。
  const authed = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find(k => /^sb-.*-auth-token$/.test(k));
    const raw = key ? all[key] : null;
    // supabase-js 存的是 JSON 串（不同版本可能是对象，两种都认）
    let parsed = raw;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = null; } }
    return {
      key: key ?? null,
      shape: raw === null ? 'null' : typeof raw,
      hasSession: !!(parsed && (parsed.session?.access_token || parsed.access_token)),
      keys: parsed ? Object.keys(parsed).slice(0, 6) : [],
    };
  });
  gate.check('B 段开始前登录态仍在（否则请求根本发不出去，判据会假绿）',
    authed.hasSession === true, JSON.stringify(authed));

  //
  // 这一段的设计是被前两版逼出来的：
  //   v1 测的是页面里手写的原生 fetch + AbortController —— 与本仓库实现无关；
  //   v2 断言「请求带上了 signal」，撤销实现后依然全绿（假通过）。
  // 真正能区分「超时生效」与「超时没接上」的判据只有一个：
  //   **把请求挂住足够久，然后观察它是否被中止。**
  // 为此把构建期上界缩短（VITE_SYNC_REQUEST_TIMEOUT_MS，见 client.ts 注释），
  // 生产构建不带该变量、恒为 45s，行为不变。

  const hung = [];
  await ctx.route('**://*.supabase.co/**', async (route) => {
    hung.push(route.request().url());
    // 永不 fulfill：模拟弱网 / 服务挂起。只有客户端真的中止才会解除。
    await new Promise((resolve) => { setTimeout(resolve, 90_000); });
    try { await route.abort('aborted'); } catch { /* 已断开 */ }
  });

  const netProbe = await page.evaluate(async () => {
    const t0 = Date.now();
    const res = await chrome.runtime.sendMessage({
      type: 'SYNC',
      data: { op: 'download', auto: true },
    });
    return { ms: Date.now() - t0, got: res !== undefined, ok: res?.ok, err: res?.error ?? null };
  });
  gate.check('挂起的请求确实发往了 Supabase（拦截命中）', hung.length > 0, '未命中任何请求');
  gate.check('挂起的请求在超时上界附近被中止，而不是无限等待',
    netProbe.got === true && netProbe.ms < 30_000,
    `耗时 ${netProbe.ms}ms，返回：${JSON.stringify(netProbe)}`);

  const after = await page.evaluate(async () => {
    const t0 = Date.now();
    const res = await chrome.runtime.sendMessage({
      type: 'MUTATE',
      data: { op: 'renameGroup', groupId: '__after-timeout__', name: 'z' },
    });
    return { ms: Date.now() - t0, responded: res !== undefined };
  });
  gate.check('超时后队列已释放（后续命令有界返回）',
    after.responded === true && after.ms < 10_000, JSON.stringify(after));

  await ctx.unroute('**://*.supabase.co/**');

} catch (e) {
  failed = true;
  console.error('\n[e2e] 执行异常：', e?.message ?? e);
} finally {
  await ctx.close();
}

if (failed) {
  console.error(`\n❌ ${label} 执行异常`);
  process.exitCode = 1;
}
gate.report(`${label} 判据`);
