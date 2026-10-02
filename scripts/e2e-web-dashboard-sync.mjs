// Web 仪表盘 ↔ 云端 ↔ 扩展 的三方联动 E2E（跨端软删/改名写入路径回归）
//
// 为什么必须测：云端守护触发器最初写成 `NEW.last_op_seq <= OLD.last_op_seq THEN RETURN NULL`。
// Web 控制台（src/web/webApi.ts）的重命名/软删/恢复全是「局部 UPDATE」——payload 不带印记列，
// 于是 NEW.last_op_seq = OLD（而不是 NULL）→ 整行被静默跳过，且客户端只收到 error=null：
// 用户在网页版点删除/改名，界面上"成功"了，云端却毫无变化。
// 修复（严格 `<`）后这条路径才重新可用；本脚本用真实浏览器 + 真实云端钉住它。
//
// 断言链（全部落在真实产物上）：
//   ① 网页版能看到扩展上传的会话（读取 + 解密路径）
//   ② 网页版改名 → 云端 name 真的变了（局部 UPDATE 被放行）
//   ③ 网页版删除 → 云端 is_deleted = true（跨端删除广播写入被放行）
//   ④ 删除后网页版列表不再显示该会话，且不存在回收站/恢复入口（v1.22.0 无回收站）
//   ⑤ 扩展重新下载 → 该会话在本地物理消失（无墓碑、不进活跃列表）
//
// 运行：node scripts/e2e-web-dashboard-sync.mjs（需先 pnpm build && pnpm build:web）
//
// ── 凭据来源（2026-09-29 修）──
// 需要 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY（SUPABASE_SERVICE_ROLE_KEY 可选，
// 供收尾清理）。**优先读 process.env，缺失才回退读 .env / .env.local**（共享
// loadEnv）；变量名与 .env 里的一致，没有改。原先只读文件，密钥来源写死在代码里，
// CI 与其他环境无法注入。

import { chromium } from 'playwright';
import { mkdtempSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { readLocalGroups } from './e2e-helpers.mjs';
import { accountMarker, loadEnv } from './e2e-support.mjs';

const DIST = resolve(process.cwd(), 'dist');
const DIST_WEB = resolve(process.cwd(), 'dist-web');
const EMAIL = `e2e-web-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';
console.log(accountMarker(EMAIL)); // 供 run-e2e 收尾统一清理
const SEED_NAME = 'WEB-端到端-种子会话';
const RENAMED = 'WEB-网页版改的名字';

const E = loadEnv({ cwd: resolve(process.cwd()) });

// 受控实验开关：给网页版注入最小 chrome.storage 垫片（用 localStorage 承载）。
// 若注入后仪表盘能正常列出数据，则「登录不持久 = 复用扩展的 chrome.storage-only
// session 适配器」这条因果被证实。
const SHIM_CHROME_STORAGE = process.env.SHIM_CHROME_STORAGE === '1';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
function serveDistWeb() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(DIST_WEB, urlPath === '/' ? 'index.html' : urlPath);
    try { if (!statSync(file).isFile()) throw new Error('dir'); } catch { file = join(DIST_WEB, 'index.html'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function cloud() {
  const c = createClient(E.VITE_SUPABASE_URL, E.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: auth, error } = await c.auth.signInWithPassword({ email: EMAIL, password: PWD });
  if (error) throw new Error('云端登录失败: ' + error.message);
  return {
    client: c, userId: auth.user.id,
    async rows() {
      const { data, error: e2 } = await c.from('tab_groups').select('id,name,is_deleted,last_op_seq,last_op_device').eq('user_id', auth.user.id);
      if (e2) throw new Error('读云端失败: ' + e2.message);
      return data || [];
    },
  };
}

let ok = true;
const fail = m => { console.log(m); ok = false; };

// 看门狗：脚本总时长上限（正常 ~4 分钟）。挂住时给出最后的步骤提示并落盘，
// 而不是被外部 timeout 杀掉（那样 stdout 缓冲会丢，无法定位卡点）。
const WATCHDOG_MS = 12 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`\n⏰ 看门狗触发：脚本超过 ${WATCHDOG_MS / 60000} 分钟未结束（最后阶段见上方输出）`);
  process.exit(3);
}, WATCHDOG_MS);
const step = m => console.log(`\n── ${m}`);

// 网页版需要一个「非扩展」上下文；扩展需要一个 persistent context
const webCtx = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapstack-web-'));
  return chromium.launchPersistentContext(dir, { headless: false });
})();
const extDir = mkdtempSync(join(tmpdir(), 'tapstack-ext-'));
const extCtx = await chromium.launchPersistentContext(extDir, {
  headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
let webServer;
let contentServer; // 造数据用的本地站点：必须在 finally 关闭，否则 node 事件循环不退出（脚本"跑完但卡死不退出"）
try {
  // ── 1. 用扩展播种数据（Web 端没有"新建会话"能力，种子必须来自扩展）───────
  let n = 0;
  const content = createServer((req, res) => {
    n++; const t = `WEBSEED-${n}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => content.listen(0, '127.0.0.1', r));
  contentServer = content;
  const cbase = `http://127.0.0.1:${content.address().port}`;

  await extCtx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => {});
  const extIdResolved = new URL(extCtx.serviceWorkers()[0].url()).host;
  const pageE = await extCtx.newPage();
  await pageE.goto(`chrome-extension://${extIdResolved}/src/popup/index.html`);
  await pageE.waitForTimeout(1500);
  const skipBtnE = pageE.locator('button[aria-label="跳过引导"]');
  if (await skipBtnE.count() && await skipBtnE.isVisible().catch(() => false)) {
    await skipBtnE.click().catch(() => {});
    await pageE.waitForTimeout(600);
  }
  // 注意：不要 el.remove() 删遮罩（React 节点被外部删除会导致 insertBefore/removeChild NotFoundError 崩到错误边界）
  await pageE.click('button[aria-label="菜单"]', { timeout: 30000 });
  await pageE.click('button:has-text("登录 / 注册")', { timeout: 20000 });
  await pageE.click('.fixed button:has-text("注册")');
  await pageE.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageE.fill('input[placeholder="请输入密码"]', PWD);
  await pageE.fill('input[placeholder="请再次输入密码"]', PWD);
  await pageE.click('button[type="submit"]');
  await pageE.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 40000 });
  for (const p of ['/s1', '/s2']) {
    const pg = await extCtx.newPage(); await pg.goto(`${cbase}${p}`); await pg.waitForSelector('h1');
  }
  await pageE.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageE.waitForTimeout(2500);
  for (const pg of extCtx.pages()) if (pg !== pageE && !pg.url().startsWith('chrome-extension://')) await pg.close().catch(() => {});
  // 重命名成固定名字，便于网页版定位
  const card = pageE.locator('.tab-group-card').first();
  await pageE.mouse.move(180, 520); // 移开 header 的 hover tooltip，否则它会挡住卡片按钮
  await pageE.waitForTimeout(500);
  await card.locator('button[aria-label="重命名会话"]').first().click();
  const nameInput = pageE.locator('input[aria-label="编辑会话名称"]').first();
  await nameInput.waitFor({ state: 'visible' });
  await nameInput.fill(SEED_NAME);
  await nameInput.press('Enter');
  await pageE.waitForTimeout(1500);
  await pageE.click('button[title="手动上传本地会话到云端"]');
  await pageE.waitForSelector('.fixed h3:has-text("上传到云端")');
  await pageE.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageE.waitForTimeout(5000);
  console.log('✅ 扩展已播种并上传:', SEED_NAME);

  const api = await cloud();
  const seeded = (await api.rows()).find(r => r.name === SEED_NAME);
  if (!seeded) throw new Error('云端没有播种的会话，setup 失败');
  console.log(`   云端种子行: id=${seeded.id} is_deleted=${seeded.is_deleted} last_op_seq=${seeded.last_op_seq}`);

  // ── 2. 网页版：登录 → 断言看到该会话 ────────────────────────────────
  const { server, base } = await serveDistWeb();
  webServer = server;
  const pageW = await webCtx.newPage();
  if (SHIM_CHROME_STORAGE) {
    await pageW.addInitScript(() => {
      const get = async (keys) => {
        const arr = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys || {}));
        const out = {};
        for (const k of arr) { const v = localStorage.getItem('shim:' + k); if (v !== null) out[k] = v; }
        return out;
      };
      const set = async (obj) => { for (const [k, v] of Object.entries(obj)) localStorage.setItem('shim:' + k, v); };
      const remove = async (k) => { for (const kk of (Array.isArray(k) ? k : [k])) localStorage.removeItem('shim:' + kk); };
      window.chrome = Object.assign(window.chrome || {}, {
        storage: { local: { get, set, remove } },
      });
    });
    console.log('⚙️  已注入 chrome.storage 垫片（SHIM_CHROME_STORAGE=1）——用于证实 session 适配器是根因');
  }
  pageW.on('pageerror', e => console.log('   [web:pageerror]', e.message.slice(0, 200)));
  pageW.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`   [web:${m.type()}]`, m.text().slice(0, 240)); });
  pageW.on('requestfailed', r => console.log('   [web:reqfail]', r.url().slice(0, 110), r.failure()?.errorText));
  pageW.on('response', async r => {
    if (!r.url().includes('supabase.co')) return;
    const u = r.url().replace('https://reccclnaxadbuccsrwmg.supabase.co', '');
    console.log(`   [web:net] ${r.status()} ${u.slice(0, 100)}`);
  });
  await pageW.goto(base, { waitUntil: 'domcontentloaded' });
  await pageW.waitForSelector('input[placeholder="请输入您的邮箱"]', { timeout: 30000 });
  await pageW.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageW.fill('input[placeholder="请输入您的密码"]', PWD);
  await pageW.click('button[type="submit"]');
  await pageW.waitForTimeout(8000);
  const webState = await pageW.evaluate(() => ({
    url: location.href,
    cards: document.querySelectorAll('div.rounded-2xl').length,
    h2: [...document.querySelectorAll('h2')].map(h => h.textContent).slice(0, 6),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 360),
  }));
  console.log('🔎 网页版登录后状态:', JSON.stringify(webState));
  await pageW.screenshot({ path: '/tmp/web-after-login.png', fullPage: true }).catch(() => {});
  step('断言① 网页版能看到扩展上传的会话');
  const seen = await pageW.locator(`h2:has-text("${SEED_NAME}")`).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  if (!seen) { fail('❌ 断言①失败: 网页版列表里没有播种的会话（读取/解密路径异常）'); }
  else console.log('✅ 断言①通过: 网页版成功列出扩展上传的会话');

  const webCard = pageW.locator('div.rounded-2xl').filter({ hasText: SEED_NAME }).first();

  // ── 3. 网页版改名 → 云端 name 变化 ─────────────────────────────────
  await webCard.locator('button:has-text("重命名")').click();
  const modalInput = pageW.locator('input[placeholder="请输入名称"]');
  await modalInput.waitFor({ state: 'visible', timeout: 15000 });
  await modalInput.fill(RENAMED);
  await pageW.locator('button:has-text("确认")').last().click();
  await pageW.waitForTimeout(2500);
  step('断言② 网页版改名落到云端');
  const afterRename = (await api.rows()).find(r => r.id === seeded.id);
  if (afterRename?.name !== RENAMED) {
    fail(`❌ 断言②失败: 云端 name="${afterRename?.name}"，期望 "${RENAMED}"（网页版局部 UPDATE 被守卫吞掉）`);
  } else console.log(`✅ 断言②通过: 云端 name 已变为 "${RENAMED}"`);

  // ── 4. 网页版删除 → 云端 is_deleted = true ──────────────────────────
  await pageW.locator('div.rounded-2xl').filter({ hasText: RENAMED }).first()
    .locator('button:has-text("删除")').first().click(); // 组头删除（tab 行也有同名按钮）
  await pageW.locator('.fixed button:has-text("删除")').last().click({ timeout: 10000 }); // 弹窗确认按钮文案是「删除」
  await pageW.waitForTimeout(2500);
  step('断言③ 网页版删除落到云端（跨端软删）');
  const afterDelete = (await api.rows()).find(r => r.id === seeded.id);
  if (afterDelete?.is_deleted !== true) {
    fail(`❌ 断言③失败: 云端 is_deleted=${afterDelete?.is_deleted}，期望 true（网页版删除没传播）`);
  } else console.log('✅ 断言③通过: 云端已标记 is_deleted=true');

  // ── 5. 删除后网页版列表不再显示，且没有回收站/恢复入口 ──────────────
  // v1.22.0 起删除即物理清除：Web 端读路径跳过 is_deleted 行（webApi.ts），
  // 界面上不存在「已删除（N）——可恢复」这类回收站入口。旧断言④（点恢复按钮）
  // 测的是 1.21.x 的回收站模型，留着就是假红。
  step('断言④ 删除后网页版列表隐藏且无回收站入口');
  let hidden = false;
  for (let i = 0; i < 8 && !hidden; i++) {
    await pageW.waitForTimeout(1000);
    hidden = (await pageW.locator(`h2:has-text("${RENAMED}")`).count()) === 0;
  }
  const trashToggle = pageW.locator('button:has-text("已删除")').first();
  if (!hidden) {
    fail(`❌ 断言④失败: 删除后网页版列表仍显示「${RENAMED}」（is_deleted 行未被读路径过滤）`);
  } else if (await trashToggle.count()) {
    fail('❌ 断言④失败: 网页版出现回收站入口（v1.22.0 无回收站，属语义回归）');
  } else {
    console.log('✅ 断言④通过: 删除后网页版列表隐藏该会话，且无回收站/恢复入口');
  }

  // ── 6. 扩展下载 → 该会话在本地物理消失 ──────────────────────────────
  await pageE.click('button[title="手动从云端下载会话到本地"]');
  await pageE.waitForSelector('.fixed h3:has-text("下载到本地")');
  await pageE.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageE.waitForTimeout(5000);
  step('断言⑤ 网页版删除后，扩展端活跃列表不再出现该会话');
  const activeNames = await pageE.locator('.tab-group-card h3').allTextContents().catch(() => []);
  const visible = await pageE.locator(`h3:has-text("${RENAMED}")`).count().catch(() => 0);
  console.log(`   扩展端当前卡片标题: ${JSON.stringify(activeNames)}`);
  const extGroups = await readLocalGroups(pageE);
  const localAfter = extGroups.find(g => g.id === seeded.id);
  // v1.22.0 无墓碑：云端 is_deleted 行 + 更新印记在合并时让本地活跃副本整组消失
  // （物理移除，本地不留 isDeleted 行）。旧断言要求 isDeleted===true 是 1.21.x 语义。
  if (localAfter) {
    fail(`❌ 断言⑤失败: 扩展下载后本地仍存在该会话（isDeleted=${localAfter.isDeleted}）→ 网页版删除未跨端生效`);
  } else if (visible > 0) {
    fail('❌ 断言⑤失败: 本地存储已无该会话却仍出现在活跃列表（渲染异常）');
  } else {
    console.log('✅ 断言⑤通过: 扩展下载后该会话本地物理消失（无墓碑、不进活跃列表）');
  }

  console.log('\n' + '═'.repeat(62));
  console.log(`测试账号: ${EMAIL}`);
  console.log(`Web 仪表盘跨端写入 E2E: ${ok ? '✅ 全部通过' : '❌ 存在失败'}`);
  console.log('═'.repeat(62));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('\n💥 测试执行异常:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { contentServer?.close(); } catch {}
  try { webServer?.close(); } catch {}
  try { await webCtx.close(); } catch {}
  try { await extCtx.close(); } catch {}
}
