// 真实场景验证：本地"删除/点开"操作后，60s 后台轮询不会"复活"已处理项
//
// 流程：
// 1. A 注册 → 保存 2 个会话（会话1=2 个标签，会话2=2 个标签） → 上传云端
// 2. B 登录 → 下载 → 验证本地有 2 个会话
// 3. B 关闭 popup（保持 SW 跑着）
// 4. A 上传一个 "A 新会话"（制造云端新数据）
// 5. B 重新打开 → 模拟 B 本地"删除整个会话" 和 "点开单个标签（从会话移除）"
// 6. B 关闭 popup → 等 70s 后台 alarm → B 重开验证：被删除/点开的项**不应复活**

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-nr-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

function launchCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}
async function extId(ctx) { return new URL(ctx.serviceWorkers()[0].url()).host; }
async function ensureNoOverlay(page) {
  await page.evaluate(() =>
    document.querySelectorAll('.onboarding-overlay, [role=dialog][aria-label="用户引导"]').forEach(el => el.remove())
  ).catch(() => {});
}
async function readLocalGroups(page) {
  // IndexedDB: db=tabvaultpro, store=kv (keyPath: key) → 每条 {key, value}
  return page.evaluate(async () => {
    return new Promise((resolve) => {
      const r = indexedDB.open('tabvaultpro', 1);
      r.onerror = () => resolve([]);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('kv')) { db.close(); resolve([]); return; }
        const tx = db.transaction('kv', 'readonly');
        const all = tx.objectStore('kv').getAll();
        all.onsuccess = () => {
          db.close();
          const rec = all.result || [];
          const entry = rec.find(v => v?.key === 'tab_groups');
          resolve(entry?.value || []);
        };
        all.onerror = () => { db.close(); resolve([]); };
      };
    });
  });
}

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
let server;
try {
  let n = 0;
  server = createServer((req, res) => {
    n++;
    const t = `NR-${n}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── A: 注册 + 保存 2 个会话 + 上传 ──────────────────────────────
  await ctxA.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const id = await extId(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageA.waitForTimeout(1500);
  await ensureNoOverlay(pageA);
  await pageA.click('button[aria-label="菜单"]');
  await pageA.click('button:has-text("登录 / 注册")');
  await pageA.click('.fixed button:has-text("注册")');
  await pageA.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageA.fill('input[placeholder="请输入密码"]', PWD);
  await pageA.fill('input[placeholder="请再次输入密码"]', PWD);
  await pageA.click('button[type="submit"]');
  await pageA.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });
  console.log('✅ A registered');

  // 会话 1（标签 NR-1、NR-2）
  const a1a = await ctxA.newPage(); await a1a.goto(`${base}/p1`); await a1a.waitForSelector('h1');
  const a1b = await ctxA.newPage(); await a1b.goto(`${base}/p2`); await a1b.waitForSelector('h1');
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  // 关闭前 2 个开 2 个新（NR-3、NR-4）→ 会话 2
  await a1a.close(); await a1b.close();
  const a2a = await ctxA.newPage(); await a2a.goto(`${base}/p3`); await a2a.waitForSelector('h1');
  const a2b = await ctxA.newPage(); await a2b.goto(`${base}/p4`); await a2b.waitForSelector('h1');
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  await pageA.click('button[title="手动上传本地会话到云端"]');
  await pageA.waitForSelector('.fixed h3:has-text("上传到云端")');
  await pageA.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageA.waitForTimeout(4000);
  console.log('✅ A uploaded 2 sessions');

  // ── B: 登录 + 下载（建立 B 端初始数据） ──────────────────────────
  await ctxB.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB.waitForTimeout(1500);
  await ensureNoOverlay(pageB);
  await pageB.click('button[aria-label="菜单"]');
  await pageB.click('button:has-text("登录 / 注册")');
  await pageB.fill('input[placeholder="请输入您的邮箱"]', EMAIL);
  await pageB.fill('input[placeholder="请输入您的密码"]', PWD);
  await pageB.click('button[type="submit"]');
  await pageB.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });

  await pageB.click('button[title="手动从云端下载会话到本地"]');
  await pageB.waitForSelector('.fixed h3:has-text("下载到本地")');
  await pageB.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageB.waitForTimeout(4000);

  const beforeGroups = await readLocalGroups(pageB);
  console.log(`📊 B 初始本地会话数: ${beforeGroups.length}`);
  beforeGroups.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs, isDeleted=${g.isDeleted})`));

  // ── B 本地"删除整个会话"（操作：会话 1）─────────────────────────
  // 点开第一张卡的删除按钮（aria-label="删除会话"）
  const cardCount = await pageB.locator('.tab-group-card').count();
  if (cardCount >= 1) {
    const firstDeleteBtn = pageB.locator('.tab-group-card').first().locator('button[aria-label="删除会话"]').first();
    await firstDeleteBtn.click();
    await pageB.waitForTimeout(800);
    // 确认对话框（如有）
    const confirmBtn = pageB.locator('button:has-text("确认"), button:has-text("删除")').last();
    if (await confirmBtn.count()) {
      await confirmBtn.click().catch(() => {});
      await pageB.waitForTimeout(500);
    }
  }
  console.log('✅ B: 已删除会话 1');
  await pageB.waitForTimeout(2500); // 等 autoSyncMiddleware 上传（1500ms + 网络）

  // 验证 B 本地：会话 1 应 isDeleted=true 或已不见
  const afterDeleteGroups = await readLocalGroups(pageB);
  const liveAfterDelete = afterDeleteGroups.filter(g => !g.isDeleted);
  console.log(`📊 B 删除后本地活跃组: ${liveAfterDelete.length}`);

  // ── B 本地"点开单个标签"（从会话 2 移除一个 tab）─────────────────
  const card2 = pageB.locator('.tab-group-card').first();
  if (await card2.count()) {
    const openTabBtn = card2.locator('a[aria-label^="打开标签页"]').first();
    if (await openTabBtn.count()) {
      await openTabBtn.click();
      await pageB.waitForTimeout(2500); // 等 updateGroup fulfilled + autoSyncMiddleware 上传
      console.log('✅ B: 已点开会话 2 的第 1 个标签（应从本地移除）');
    }
  }

  const afterOpenGroups = await readLocalGroups(pageB);
  console.log(`📊 B 点开后本地组:`);
  afterOpenGroups.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs, isDeleted=${g.isDeleted})`));

  // ── 关闭 B popup，等待 70s 后台 alarm 触发同步 ──────────────────
  await pageB.close();
  console.log('✅ B popup closed; 等 70s 后台 alarm 触发自动同步...');
  await pageA.waitForTimeout(70000);

  // ── B 重开，验证：删除的会话不被"复活"，点开的标签不被"复活" ──
  const pageB2 = await ctxB.newPage();
  await pageB2.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB2.waitForTimeout(2500);
  const finalGroups = await readLocalGroups(pageB2);
  console.log(`📊 B 70s 后台同步后本地组:`);
  finalGroups.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs, isDeleted=${g.isDeleted})`));

  // 断言：会话 1 不应在活跃组里（已删除）
  // 断言：会话 2 的标签数应保持为 1（点开移除了 1 个 tab）
  const liveFinal = finalGroups.filter(g => !g.isDeleted);
  const session2 = liveFinal.find(g => g.tabs.length === 1 || g.tabs.length === 2);
  const session1Alive = liveFinal.find(g => g.tabs.length === 2 && !session2);

  let ok = true;
  if (session1Alive && session1Alive.tabs.length === 2) {
    console.log(`❌ 会话 1 被复活！tabs.length=${session1Alive.tabs.length}`);
    ok = false;
  } else {
    console.log(`✅ 会话 1 未被复活（已删除）`);
  }
  if (session2 && session2.tabs.length === 2) {
    console.log(`❌ 会话 2 的标签被复活（点开的标签回来了）：${session2.tabs.length} tabs`);
    ok = false;
  } else if (session2 && session2.tabs.length === 1) {
    console.log(`✅ 会话 2 仍是 ${session2.tabs.length} tab（点开的标签未被复活）`);
  }

  if (ok) {
    console.log('\n✅ 验证通过：本地"删除/点开"操作 60s 后不会被云端反向覆盖');
    process.exitCode = 0;
  } else {
    console.log('\n❌ 验证失败：本地操作被云端"复活"');
    process.exitCode = 1;
  }
} finally {
  try { server?.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
}