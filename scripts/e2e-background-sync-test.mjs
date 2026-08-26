// 真实环境验证：后台 60s 轮询真实生效
// 流程：A 注册→上传会话1；B 登录并下载会话1；B 关闭 popup；A 上传会话2；
//      等 ≥70s 让 B 端 SW alarm 触发自动下载合并；
//      B 重新打开 popup → 断言看到 ≥2 个会话（无需手动点下载）

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const DIST = resolve(process.cwd(), 'dist');
const EMAIL = `e2e-bgsync-${randomUUID().slice(0, 6)}@test.tapstack.dev`;
const PWD = 'SyncTest#2026!';

function launchCtx(label) {
  const dir = mkdtempSync(join(tmpdir(), `tapstack-${label}-`));
  return chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
}
async function extIdFrom(ctx) {
  return new URL(ctx.serviceWorkers()[0].url()).host;
}
async function ensureNoOverlay(page) {
  await page.evaluate(() =>
    document.querySelectorAll('.onboarding-overlay, [role=dialog][aria-label="用户引导"]')
      .forEach(el => el.remove())
  ).catch(() => {});
}
async function loginViaUI(page, extId, email, pwd, mode /* 'login' | 'register' */) {
  await page.click('button[aria-label="菜单"]');
  await page.click('button:has-text("登录 / 注册")');
  if (mode === 'register') {
    await page.click('.fixed button:has-text("注册")');
    await page.fill('input[placeholder="请输入您的邮箱"]', email);
    await page.fill('input[placeholder="请输入密码"]', pwd);
    await page.fill('input[placeholder="请再次输入密码"]', pwd);
  } else {
    await page.fill('input[placeholder="请输入您的邮箱"]', email);
    await page.fill('input[placeholder="请输入您的密码"]', pwd);
  }
  await page.click('button[type="submit"]');
  await page.waitForSelector('button[title="手动上传本地会话到云端"]', { timeout: 25000 });
}

const ctxA = await launchCtx('A');
const ctxB = await launchCtx('B');
let server;
try {
  // 本地静态站点，提供带唯一中文标题的页面（确保 charset=utf-8，参考历史教训）
  let nonce = 0;
  server = createServer((req, res) => {
    nonce++;
    const t = `BG-${nonce}-标签`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${t}</title><h1>${t}</h1>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A: 注册
  await ctxA.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const extId = await extIdFrom(ctxA);
  const pageA = await ctxA.newPage();
  await pageA.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await pageA.waitForTimeout(1500);
  await ensureNoOverlay(pageA);
  await loginViaUI(pageA, extId, EMAIL, PWD, 'register');
  console.log('✅ A registered & logged in');

  // A: 打开 2 个本地页面 + 保存 + 上传（会话 1）
  const pA1 = await ctxA.newPage();
  await pA1.goto(`${base}/p1`);
  await pA1.waitForSelector('h1');
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  await pageA.click('button[title="手动上传本地会话到云端"]');
  await pageA.waitForSelector('.fixed h3:has-text("上传到云端")');
  await pageA.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageA.waitForTimeout(4000);
  console.log('✅ A uploaded session #1');

  // B: 登录 + 下载（建立 B 端本地初始数据 + 已登录态，使 SW 能恢复 session）
  await ctxB.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => {});
  const pageB = await ctxB.newPage();
  await pageB.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await pageB.waitForTimeout(1500);
  await ensureNoOverlay(pageB);
  await loginViaUI(pageB, extId, EMAIL, PWD, 'login');
  await pageB.click('button[title="手动从云端下载会话到本地"]');
  await pageB.waitForSelector('.fixed h3:has-text("下载到本地")');
  await pageB.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageB.waitForTimeout(4000);
  const bInitialCount = await pageB.evaluate(() => {
    const m = document.body.innerText.match(/(\d+)\s*会话/);
    return m ? parseInt(m[1]) : 0;
  });
  console.log(`✅ B logged in & downloaded: ${bInitialCount} session(s) visible`);

  // 关键：B 关闭 popup，但 SW 进程会保持；chrome.alarms 仍能触发
  await pageB.close();
  console.log('✅ B popup closed (SW keeps running, alarm scheduled)');

  // A: 打开新页面 + 保存 + 上传（会话 2）
  const pA2 = await ctxA.newPage();
  await pA2.goto(`${base}/p2`);
  await pA2.waitForSelector('h1');
  await pageA.locator('[aria-label="保存当前窗口中的所有标签页为会话"]').first().click();
  await pageA.waitForTimeout(2500);
  await pageA.click('button[title="手动上传本地会话到云端"]');
  await pageA.waitForSelector('.fixed h3:has-text("上传到云端")');
  await pageA.locator('.fixed h4:has-text("合并模式"), .fixed h4:has-text("覆盖模式")').first().click();
  await pageA.waitForTimeout(4000);
  console.log('✅ A uploaded session #2 (B should auto-pull in ≤60s)');

  // 等 70s：periodInMinutes=1 → 60s 周期 + 启动抖动
  const WAIT_MS = 70000;
  console.log(`⏳ Waiting ${WAIT_MS / 1000}s for B background alarm to fire & auto-sync…`);
  await pageA.waitForTimeout(WAIT_MS);

  // B 重新打开 popup，看后台是否拿到了会话 2
  const pageB2 = await ctxB.newPage();
  await pageB2.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await pageB2.waitForTimeout(2500);
  const bFinalCount = await pageB2.evaluate(() => {
    const m = document.body.innerText.match(/(\d+)\s*会话/);
    return m ? parseInt(m[1]) : 0;
  });
  console.log(`📊 B after background sync (no manual action): ${bFinalCount} session(s) visible`);

  // 展开看是否真的拿到了会话 2
  const expandBtn = pageB2.locator('button[aria-label="展开会话"]').first();
  const allTitles = [];
  const cards = await pageB2.locator('.tab-group-card').all();
  for (const card of cards) {
    const exp = card.locator('button[aria-label="展开会话"]');
    if (await exp.count()) {
      await exp.first().click().catch(() => {});
      await pageB2.waitForTimeout(200);
    }
    const ts = await card.evaluate(el => {
      const t = el.innerText;
      const m = t.match(/BG-\d+-标签/g);
      return m || [];
    });
    allTitles.push(...ts);
  }
  const hasSession2 = allTitles.some(t => /^BG-2-/.test(t));
  console.log(`📊 B 渲染的标签标题: ${allTitles.join(', ') || '(无)'}`);

  if (bFinalCount > bInitialCount) {
    console.log('\n✅ 后台 60s 轮询验证通过：');
    console.log(`   B 未打开 popup、未手动操作，alarm 触发自动从云端拉取了 A 后上传的新会话`);
    console.log(`   会话数: ${bInitialCount} → ${bFinalCount}（B 端 IndexedDB 持久化新数据）`);
    process.exitCode = 0;
  } else {
    console.log(`\n❌ 后台轮询验证失败：`);
    console.log(`   B 会话数未增加（${bInitialCount} → ${bFinalCount}）`);
    process.exitCode = 1;
  }
} finally {
  try { server?.close(); } catch {}
  try { await ctxA.close(); } catch {}
  try { await ctxB.close(); } catch {}
  console.log('已清理临时 user-data-dir');
}