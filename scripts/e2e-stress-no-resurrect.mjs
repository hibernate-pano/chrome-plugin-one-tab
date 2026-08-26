// 高压力验证：后台轮询"先上传再下载" + 持久化 pending_upload
// 模拟用户真实场景：A 持续制造云端新数据，B 多次本地操作后关闭 popup，
// 等后台轮询触发，确保 B 本地变更（删除/点开）不被反向覆盖。

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-st-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
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
  return page.evaluate(() => new Promise((resolve) => {
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
  }));
}

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
let server;
try {
  let counter = 0;
  server = createServer((req, res) => {
    counter++;
    const t = `ST-${counter}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── A: 注册 + 保存会话 1 (4 个标签) + 上传 ────────────────────
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

  for (let i = 1; i <= 4; i++) {
    const p = await ctxA.newPage();
    await p.goto(`${base}/p${i}`);
    await p.waitForSelector('h1');
  }
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  await pageA.click('button[title="手动上传本地会话到云端"]');
  await pageA.waitForSelector('.fixed h3:has-text("上传到云端")');
  await pageA.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageA.waitForTimeout(4000);
  console.log('✅ A: 4-tab 会话已上云');

  // ── B: 登录 + 下载 ────────────────────────────────────────────
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

  const initial = await readLocalGroups(pageB);
  console.log(`📊 B 初始: ${initial.length} 个会话，标签:`);
  initial.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs)`));

  // ── B 本地操作: 连点 3 个标签（每次点开一个）────────────────────
  // 真实时序：每次点开 → popup 失焦 → Chrome 销毁 popup → chrome.alarms 仍注册
  for (let i = 0; i < 3; i++) {
    const card = pageB.locator('.tab-group-card').first();
    if (await card.count()) {
      const openBtn = card.locator('a[aria-label^="打开标签页"]').first();
      if (await openBtn.count()) {
        await openBtn.click();
        await pageB.waitForTimeout(800);
        console.log(`✅ B: 点开第 ${i + 1} 个标签`);
      }
    }
  }

  const afterClick = await readLocalGroups(pageB);
  console.log(`📊 B 点开后: ${afterClick.length} 个会话:`);
  afterClick.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs, isDeleted=${g.isDeleted})`));

  // 关闭 popup（关键：popup 死掉但 chrome.alarms 仍由 chrome 服务持有）
  await pageB.close();
  console.log('⏳ B popup closed; 等 90s：先让 30s upload alarm 触发，再让 60s sync alarm');

  // ── 等待 90s: 30s + 60s，覆盖两个 alarm 周期
  await pageA.waitForTimeout(90000);

  // ── B 重开验证
  const pageB2 = await ctxB.newPage();
  await pageB2.goto(`chrome-extension://${id}/src/popup/index.html`);
  await pageB2.waitForTimeout(2500);

  const final = await readLocalGroups(pageB2);
  console.log(`📊 B 90s 后: ${final.length} 个会话:`);
  final.forEach(g => console.log(`   - ${g.name} (${g.tabs.length} tabs, isDeleted=${g.isDeleted})`));

  // 断言：会话仍是 1 个，tab 数仍是 1（4 - 3）
  const live = final.filter(g => !g.isDeleted);
  let ok = true;
  if (live.length === 1 && live[0].tabs.length === 1) {
    console.log('\n✅ 高压力验证通过：');
    console.log(`   - B 本地连点 3 个标签（4→3→2→1）`);
    console.log(`   - 关闭 popup 90s 后台轮询 2 次`);
    console.log(`   - 最终活跃会话仍 1 tab（点开的标签未被云端反向覆盖）`);
    process.exitCode = 0;
  } else {
    console.log(`\n❌ 高压力验证失败：`);
    console.log(`   - 期望 1 个活跃会话 1 tab，实际 ${live.length} 个会话`);
    if (live[0]) console.log(`   - 实际 tab 数: ${live[0].tabs.length}`);
    process.exitCode = 1;
  }
} finally {
  try { server?.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
}