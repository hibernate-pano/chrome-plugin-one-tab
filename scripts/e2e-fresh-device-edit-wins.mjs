// 双实例 E2E：全新设备（seq 从 0 起步）的编辑必须胜出并真正落库（P0-2 回归）
//
// 修复前的 bug：seqRegistry 只统计「本设备」印记。全新设备持久化 seq=0、且本地没有任何
// 自身印记 → 首个操作发出 s=1；而老设备早已发到 s=几。后果双重：
//   ① 客户端合并按全序决胜 → 云端 s 更大 → 新设备的编辑被回滚（用户看到改名又变回去）
//   ② 服务端守卫按「严格更旧」拒收 → 编辑根本没上云（且客户端只收到 error=null）
// 这正是「换机 / 重装扩展 / 清扩展数据后，改什么都存不住」的根因。
//
// 修复：取号改为 Lamport —— max(持久化, 观察到的全网最大印记) + 1。
//
// 本脚本的三重断言（都落在真实产物上，不做自证）：
//   ① B（新设备）重命名后，本地印记 s 必须 > 云端原印记 s（Lamport 取号生效）
//   ② 云端行的 name 变成 B 的输入且 last_op_seq 变大（服务端守卫放行 = 编辑真的上了云）
//   ③ A（老设备）下载后看到 B 的改名（没有被云端旧值回滚）
//
// 运行：node scripts/e2e-fresh-device-edit-wins.mjs（需先 pnpm build）

import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { openTabsInSameWindow } from './e2e-helpers.mjs';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-fresh-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';
const NAME_A = 'A-老设备起的名字';
const NAME_B = 'B-新设备改的名字';

function env() {
  const out = {};
  for (const f of ['.env', '.env.local']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}
const E = env();

function launchCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}
async function extId(ctx) { return new URL(ctx.serviceWorkers()[0].url()).host; }
async function noOverlay(page) {
  // 只用「点跳过引导」让 React 自己收掉遮罩。
  // 绝不要 el.remove() 直接删 React 管理的节点：之后 React patch DOM 会抛
  // NotFoundError(insertBefore/removeChild) 并把整个应用打进错误边界（假失败源）。
  const skip = page.locator('button[aria-label="跳过引导"]');
  if (await skip.count() && await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => {});
    await page.waitForTimeout(600);
  }
}
/** 直读扩展 IndexedDB（含 lastOp 印记，用于断言 Lamport 取号） */
const readLocalGroups = page => page.evaluate(async () => new Promise((resolve) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => resolve([]);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => {
      db.close();
      const entry = (all.result || []).find(v => v?.key === 'tab_groups');
      resolve(entry?.value || []);
    };
    all.onerror = () => { db.close(); resolve([]); };
  };
}));

/** 读扩展 chrome.storage.local 的关键值（IDB kv store） */
const readKvAll = page => page.evaluate(async () => new Promise((resolve) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => resolve([]);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => { db.close(); resolve(all.result || []); };
    all.onerror = () => { db.close(); resolve([]); };
  };
}));
const kvValue = (entries, key) => entries.find(e => e?.key === key)?.value ?? null;

/** 下载前置有 35s 上传保护窗口（decideDownloadPrecheck），窗口内下载会被 skip */
async function waitOutUploadGuard(page, gapMs = 36000) {
  const lastUpload = kvValue(await readKvAll(page), 'last_upload_time');
  if (!lastUpload) return;
  const age = Date.now() - new Date(lastUpload).getTime();
  if (age >= 0 && age < gapMs) {
    const wait = gapMs - age + 1000;
    console.log(`   ...距上次上传仅 ${(age / 1000).toFixed(0)}s，等 ${(wait / 1000).toFixed(0)}s 越过 35s 保护窗口`);
    await page.waitForTimeout(wait);
  }
}

async function manualUpload(page) {
  await page.click('button[title="手动上传本地会话到云端"]');
  await page.waitForSelector('.fixed h3:has-text("上传到云端")');
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await page.waitForTimeout(5000);
}
async function manualDownload(page) {
  await page.click('button[title="手动从云端下载会话到本地"]');
  await page.waitForSelector('.fixed h3:has-text("下载到本地")');
  await page.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await page.waitForTimeout(5000);
}

/** 登录（register=true 时注册）；超时给足，规避 bundled Chromium 冷启动抖动 */
async function login(page, { register }) {
  await page.waitForTimeout(1500);
  await noOverlay(page);
  await page.click('button[aria-label="菜单"]', { timeout: 30000 });
  await page.click('button:has-text("登录 / 注册")', { timeout: 20000 });
  await page.waitForSelector('text=注册', { timeout: 20000 });
  if (register) await page.click('.fixed button:has-text("注册")');
  await page.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await page.fill(register ? 'input[placeholder="请输入密码"]' : 'input[placeholder="请输入您的密码"]', PWD);
  if (register) await page.fill('input[placeholder="请再次输入密码"]', PWD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 40000 });
  await page.waitForTimeout(2000); // 等登录初始化流程收敛
}

/** 通过 UI 重命名指定名称的会话（组级操作 → name 是明文列，云端可直接断言） */
async function renameGroup(page, fromName, toName) {
  // header 上的 hover tooltip 会浮在卡片按钮之上（真人移动鼠标会自然消失，Playwright 跳转不会），先移开
  await page.mouse.move(180, 520);
  await page.waitForTimeout(500);
  const card = page.locator('.tab-group-card').filter({ hasText: fromName }).first();
  if (!(await card.count())) throw new Error(`找不到会话卡片: ${fromName}`);
  await card.locator('button[aria-label="重命名会话"]').first().click({ timeout: 15000 });
  // 进入编辑态后组名变成 input 的 value（不再是文本节点），card 的 hasText 过滤会失效，
  // 因此改用只在编辑态存在的稳定选择器
  const input = page.locator('input[aria-label="编辑会话名称"]').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(toName);
  await input.press('Enter');
  await page.waitForTimeout(1500);
}

/** 以测试账号身份直读云端（RLS 下只能读自己的行） */
async function cloudRows() {
  const c = createClient(E.VITE_SUPABASE_URL, E.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: auth, error: authErr } = await c.auth.signInWithPassword({ email: EMAIL, password: PWD });
  if (authErr) throw new Error('云端登录失败: ' + authErr.message);
  const { data, error } = await c.from('tab_groups')
    .select('id,name,is_deleted,last_op_seq,last_op_device,version')
    .eq('user_id', auth.user.id);
  if (error) throw new Error('读云端失败: ' + error.message);
  // 绝不 signOut：默认 scope='global' 会吊销该账号的全部 refresh token，
  // 连被测扩展的登录态一起干掉（现象是后续下载报「用户未登录或会话已过期」）。
  // 本 client 用 persistSession:false，丢弃即可。
  return data || [];
}

let ok = true;
const fail = m => { console.log(m); ok = false; };
const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
let server;
try {
  let n = 0;
  server = createServer((req, res) => {
    n++;
    const t = `FRESH-${n}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── 设备 A（老设备）：注册 → 多步操作把 seq 推高 → 上传 ──────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  // SW 侧日志（改名走 SW 的 mutationService，崩溃可能发生在 SW 或 popup 任一侧）
  const swA = ctxA.serviceWorkers()[0];
  if (swA) {
    swA.on('console', m => console.log(`   [SW:${m.type()}]`, m.text().slice(0, 260)));
    swA.on('pageerror', e => console.log('   [SW:pageerror]', e.message, (e.stack || '').split('\n')[1]?.trim().slice(0, 160)));
  }
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  pageA.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`   [A:${m.type()}]`, m.text().slice(0, 220)); });
  pageA.on('pageerror', e => console.log('   [A:pageerror]', e.message, '\n     ', (e.stack||'').split('\n')[1]?.trim().slice(0,160)));
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageA, { register: true });
  console.log('✅ A 注册并登录');

  const contentPages = await openTabsInSameWindow(pageA, ['/p1', '/p2', '/p3'].map(p => `${base}${p}`));
  for (const contentPage of contentPages) await contentPage.waitForSelector('h1');
  // 保存两次（新建两个会话）+ 重命名一次 = 让 A 的 seq 走到 ≥3
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  for (const pg of ctxA.pages()) {
    if (pg !== pageA && !pg.url().startsWith('chrome-extension://')) await pg.close().catch(() => {});
  }
  const aLocal0 = await readLocalGroups(pageA);
  const first = aLocal0.filter(g => !g.isDeleted)[0];
  console.log(`📊 A 本地会话: ${aLocal0.filter(g => !g.isDeleted).map(g => g.name).join(' | ')}`);
  console.log(`📊 改名【前】A 本地印记: ${JSON.stringify(first.lastOp)} (name=${first.name})`);
  await renameGroup(pageA, first.name, NAME_A);
  const aAfterRename = (await readLocalGroups(pageA)).find(g => g.id === first.id);
  console.log(`📊 改名【后】A 本地印记: ${JSON.stringify(aAfterRename?.lastOp)} (name=${aAfterRename?.name})`);
  const postRename = await pageA.evaluate(() => ({
    url: location.href,
    uploadBtn: !!document.querySelector('button[title="手动上传本地会话到云端"]'),
    loginBtn: /登录/.test(document.body.innerText || ''),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
  }));
  console.log('🔎 改名后 popup 状态:', JSON.stringify(postRename));
  await pageA.screenshot({ path: '/tmp/fresh-after-rename.png' }).catch(() => {});
  await manualUpload(pageA);
  console.log('✅ A 完成「多步操作 + 上传」');

  const cloud1 = await cloudRows();
  const row1 = cloud1.find(r => r.name === NAME_A);
  if (!row1) throw new Error(`云端找不到 A 的会话 ${NAME_A}；现有: ${cloud1.map(r => r.name).join(', ')}`);
  console.log(`📊 云端基线: name="${row1.name}" last_op_seq=${row1.last_op_seq} last_op_device=${row1.last_op_device}`);
  if (!(row1.last_op_seq >= 3)) {
    console.log(`⚠️  A 的印记只有 ${row1.last_op_seq}（预期 ≥3）：B 新设备即使取号=1 也可能不落后，判别力下降`);
  }

  // ── 设备 B（全新 profile = 新设备，seq 从 0 起步）：登录 → 下载 → 改名 ──
  await ctxB.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await login(pageB, { register: false });
  console.log('✅ B（新设备）登录');
  await manualDownload(pageB);

  const bLocal0 = await readLocalGroups(pageB);
  const bSess = bLocal0.find(g => g.id === row1.id);
  if (!bSess) throw new Error('B 下载后未拿到 A 的会话');
  console.log(`📊 B 下载到的印记: s=${bSess.lastOp?.s} d=${bSess.lastOp?.d}（云端 s=${row1.last_op_seq}）`);
  if (bSess.lastOp?.s !== row1.last_op_seq) {
    console.log(`   （注：B 本地印记 s=${bSess.lastOp?.s} 与云端 ${row1.last_op_seq} 不一致，可能已被其它流程更新）`);
  }

  await renameGroup(pageB, NAME_A, NAME_B);
  const bLocal1 = await readLocalGroups(pageB);
  const bAfter = bLocal1.find(g => g.id === row1.id);

  // ── 断言①：B 的印记必须严格大于云端原印记（Lamport 取号）─────────────
  console.log(`\n── 断言① B 本地印记: s=${bAfter?.lastOp?.s} d=${bAfter?.lastOp?.d}, 名字="${bAfter?.name}"`);
  if (bAfter?.name !== NAME_B) {
    fail(`❌ 断言①失败: B 本地名字应为 "${NAME_B}"，实际 "${bAfter?.name}"`);
  } else if (!(bAfter.lastOp?.s > row1.last_op_seq)) {
    fail(`❌ 断言①失败: B 的印记 s=${bAfter.lastOp?.s} 未超过云端 s=${row1.last_op_seq}`
      + '（新设备取号未按 Lamport 提升 → 会被云端回滚且被守卫拒收）');
  } else {
    console.log(`✅ 断言①通过: B 取号 s=${bAfter.lastOp.s} > 云端 s=${row1.last_op_seq}`);
  }

  // ── B 上传 → 断言②：云端真的被改了（守卫放行）────────────────────────
  await manualUpload(pageB);
  const cloud2 = await cloudRows();
  const row2 = cloud2.find(r => r.id === row1.id);
  console.log(`\n── 断言② 云端行: name="${row2?.name}" last_op_seq=${row2?.last_op_seq} (原 ${row1.last_op_seq})`);
  if (row2?.name !== NAME_B) {
    fail(`❌ 断言②失败: 云端 name 仍为 "${row2?.name}"，新设备编辑没上云（守卫吞掉或被回滚）`);
  } else if (!(row2.last_op_seq > row1.last_op_seq)) {
    fail(`❌ 断言②失败: 云端 last_op_seq 未增大（${row1.last_op_seq} → ${row2.last_op_seq}）`);
  } else {
    console.log(`✅ 断言②通过: 云端已接受新设备写入（seq ${row1.last_op_seq} → ${row2.last_op_seq}）`);
  }

  // ── A 下载 → 断言③：老设备能看到新设备的改名（未被回滚）─────────────
  await waitOutUploadGuard(pageA);
  let aAfter = null;
  let downloadRan = false;
  for (let i = 0; i < 3; i++) {
    const syncBefore = kvValue(await readKvAll(pageA), 'last_sync_time');
    await manualDownload(pageA);
    const syncAfter = kvValue(await readKvAll(pageA), 'last_sync_time');
    downloadRan = Boolean(syncAfter) && syncAfter !== syncBefore;
    aAfter = (await readLocalGroups(pageA)).find(g => g.id === row1.id);
    console.log(`   [第 ${i + 1} 次] 下载确实执行=${downloadRan} (last_sync_time ${syncBefore || '-'} → ${syncAfter || '-'}), A 端名字="${aAfter?.name}" 印记=${JSON.stringify(aAfter?.lastOp)}`);
    if (aAfter?.name === NAME_B) break;
    if (downloadRan) await pageA.waitForTimeout(1500);
  }
  if (!downloadRan) console.log('   ⚠️ 三次下载均未真正执行（都被前置保护 skip）→ 断言③不成立，需重试或延长等待');
  console.log(`\n── 断言③ A 端名字: "${aAfter?.name}" 印记=${JSON.stringify(aAfter?.lastOp)}`);
  if (aAfter?.name !== NAME_B) {
    fail(`❌ 断言③失败: A 端看到 "${aAfter?.name}"，期望 "${NAME_B}"（新设备编辑被回滚）`);
  } else {
    console.log('✅ 断言③通过: 新设备的编辑跨设备可见，未被回滚');
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`测试账号: ${EMAIL}`);
  console.log(`P0-2 回归（新设备编辑必须胜出）: ${ok ? '✅ 全部通过' : '❌ 存在失败'}`);
  console.log('═'.repeat(60));
  if (E.SUPABASE_SERVICE_ROLE_KEY) console.log('可用 service_role 清理测试账号');
  else console.log(`⚠️  未配置 service_role，测试账号需手动清理: ${EMAIL}`);
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('\n💥 测试执行异常:', e.message);
  process.exitCode = 1;
} finally {
  try { server?.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
}
