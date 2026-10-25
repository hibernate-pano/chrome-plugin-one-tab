/**
 * 断网 + 未登录：**本地功能全景**（第二版，把顺序排对）。
 *
 * 顺序：保存 → 卡片操作（改名/锁定/删除/撤销）→ 本地导出 → 云端入口的失败反馈。
 * 上一版把「恢复」放在最前面，未锁定会话恢复即被消费 ⇒ 卡片没了，后半段全测不到。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-offline';
const PORT = 8902;

const PAGES = [['/one', '甲页面'], ['/two', '乙页面'], ['/three', '丙页面']];

function startServer() {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const page = PAGES.find(([p]) => p === path);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${page ? page[1] : '本地页'}</title><h1>${page ? page[1] : '本地页'}</h1>`);
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function feedback(page) {
  return page.evaluate(() => ({
    toasts: [...document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"]')]
      .map(t => (t.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    dialogs: [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]')]
      .map(d => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 260)).filter(Boolean),
  }));
}

async function main() {
  const server = await startServer();
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-offline3-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--dns-over-https-mode=off',
    ],
  });
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('chrome-extension://')) return route.continue();
    return route.abort('internetdisconnected');
  });

  const errors = [];
  const downloads = [];
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    const extId = new URL(sw.url()).host;

    const netTest = await ctx.newPage();
    const reachable = await netTest.evaluate(async () => {
      try { await fetch('https://www.googleapis.com/', { mode: 'no-cors' }); return '通了'; }
      catch (e) { return `失败（${e.message}）`; }
    });
    console.log('外部网络自检：', reachable);
    await netTest.close();
    if (reachable === '通了') { console.error('❌ 断网没生效，测量作废'); process.exit(2); }

    for (const [path] of PAGES) {
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${PORT}${path}`);
    }

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('EXC ' + String(e).slice(0, 160)));
    page.on('download', d => downloads.push(d.suggestedFilename()));
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1200);

    // ── 保存 ────────────────────────────────────────────────────────────
    await page.locator('button[aria-label*="保存"]').first().click();
    await page.waitForTimeout(2000);
    console.log('保存后会话：', JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('.tab-group-title')].map(t => t.textContent.trim()))));

    const card = page.locator('.tab-group-card').first();

    // ── 卡片「更多」菜单 ────────────────────────────────────────────────
    console.log('\n=== 卡片菜单 ===');
    const wideButtons = await page.evaluate(() =>
      [...document.querySelectorAll('.tab-group-header button')].map(b => b.getAttribute('aria-label')));
    console.log('卡头按钮：', JSON.stringify(wideButtons));
    const more = page.locator('summary[aria-haspopup="menu"]').first();
    console.log('更多按钮的可见性诊断：', JSON.stringify(await page.evaluate(() => {
      const el = document.querySelector('summary[aria-haspopup="menu"]');
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const chain = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const s = getComputedStyle(n);
        chain.push(`${n.tagName}.${(n.className || '').toString().slice(0, 40)} display=${s.display} vis=${s.visibility} w=${Math.round(n.getBoundingClientRect().width)} h=${Math.round(n.getBoundingClientRect().height)} cv=${s.contentVisibility}`);
        n = n.parentElement;
      }
      return { found: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, display: cs.display, visibility: cs.visibility, chain };
    }, null)));
    if (await more.count()) {
      await more.click({ force: true, timeout: 8000 }).catch(e => console.log('点不开：', e.message.slice(0, 80)));
      await page.waitForTimeout(500);
      console.log('菜单项：', JSON.stringify(await page.evaluate(() =>
        [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()))));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      console.log('（窄屏没有更多菜单？）');
    }

    // ── 改名 ────────────────────────────────────────────────────────────
    console.log('\n=== 改名 ===');
    const renameBtn = card.locator('button[aria-label*="重命名"]').first();
    console.log('重命名按钮 aria：', await renameBtn.getAttribute('aria-label').catch(() => '(没有)'));
    if (await renameBtn.count()) await renameBtn.click();
    else await card.locator('.tab-group-title').first().click();
    await page.waitForTimeout(600);
    const input = card.locator('input').first();
    if (await input.count()) {
      await input.fill('改过名的会话');
      await input.press('Enter');
      await page.waitForTimeout(1200);
      console.log('改名后：', JSON.stringify(await page.evaluate(() =>
        [...document.querySelectorAll('.tab-group-title')].map(t => t.textContent.trim()))));
      console.log('反馈：', JSON.stringify(await feedback(page)));
    } else {
      console.log('没找到改名输入框');
    }

    // ── 锁定 ────────────────────────────────────────────────────────────
    console.log('\n=== 锁定 ===');
    const lockBtn = card.locator('button[aria-label*="锁定"], button[aria-label*="解锁"]').first();
    if (await lockBtn.count()) {
      console.log('按钮 aria：', await lockBtn.getAttribute('aria-label'));
      await lockBtn.click();
      await page.waitForTimeout(1500);
      console.log('锁定后反馈：', JSON.stringify(await feedback(page)));
      console.log('锁定后按钮 aria：', await lockBtn.getAttribute('aria-label'));
    }

    // ── 删除 + 撤销 ─────────────────────────────────────────────────────
    console.log('\n=== 删除 + 撤销 ===');
    const delBtn = card.locator('button[aria-label*="删除"]').first();
    if (await delBtn.count()) {
      await delBtn.click();
      await page.waitForTimeout(800);
      let dlg = page.locator('[role="dialog"]');
      if (await dlg.count()) {
        console.log('确认框：', (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 180));
        await page.screenshot({ path: `${OUT}-5-delete-confirm.png` });
        const ok = dlg.locator('button').filter({ hasText: /删除|确定|确认/ }).last();
        await ok.click();
      } else {
        console.log('没有确认框（直接删了？）');
      }
      await page.waitForTimeout(1500);
      console.log('删除后反馈：', JSON.stringify(await feedback(page)));
      console.log('还剩几个会话：', await page.evaluate(() => document.querySelectorAll('.tab-group-card').length));
      await page.screenshot({ path: `${OUT}-6-after-delete.png` });

      const undo = page.locator('button').filter({ hasText: /撤销|撤回|还原/ }).first();
      if (await undo.count()) {
        console.log('撤销按钮文案：', (await undo.innerText()).trim());
        await undo.click();
        await page.waitForTimeout(1800);
        console.log('撤销后还剩几个会话：', await page.evaluate(() => document.querySelectorAll('.tab-group-card').length));
        console.log('撤销后反馈：', JSON.stringify(await feedback(page)));
      } else {
        console.log('❌ 找不到撤销按钮');
      }
    }

    // ── 本地导出（本地用户唯一的备份手段） ─────────────────────────────
    console.log('\n=== 本地导出 ===');
    const menuBtn = page.locator('[aria-label="菜单"], button[aria-label*="菜单"]').first();
    if (await menuBtn.count()) {
      await menuBtn.click();
      await page.waitForTimeout(600);
      const exportItem = page.locator('[role="menuitem"]').filter({ hasText: '导出数据' }).first();
      if (await exportItem.count()) {
        await exportItem.click();
        await page.waitForTimeout(2000);
        console.log('下载文件：', JSON.stringify(downloads));
        console.log('导出反馈：', JSON.stringify(await feedback(page)));
      } else {
        const items = await page.evaluate(() =>
          [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()));
        console.log('菜单项：', JSON.stringify(items));
      }
      await page.keyboard.press('Escape');
    }

    // ── 云端入口：断网时的失败反馈（等 20s，看它到底说不说话） ──────────
    console.log('\n=== 云端入口（断网）===');
    for (const [label, sel] of [['上传', 'button[aria-label*="上传"]'], ['下载', 'button[aria-label*="下载"]']]) {
      const btn = page.locator(sel).first();
      if (!(await btn.count())) { console.log(label, '按钮没找到'); continue; }
      const t = Date.now();
      await btn.click();
      let said = null;
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(1000);
        const fb = await feedback(page);
        const hit = fb.toasts.find(x => /失败|错误|网络|不可用|未登录|超时|无法|需要登录/.test(x));
        const dlg = fb.dialogs.find(x => /失败|错误|网络|不可用|未登录|超时|无法|登录/.test(x));
        if (hit || dlg) { said = { at: Date.now() - t, hit: hit || dlg }; break; }
      }
      const fb2 = await feedback(page);
      console.log(`${label} → `, said ? `第 ${said.at}ms 出声：${said.hit}` : '25 秒内没有任何失败反馈');
      console.log(`   （当时界面上：toast=${JSON.stringify(fb2.toasts)} dialog=${JSON.stringify(fb2.dialogs)}）`);
      await page.screenshot({ path: `${OUT}-7-${label}.png` });
    }

    console.log('\n=== 控制台报错 ===');
    console.log(errors.length ? [...new Set(errors)].slice(0, 8).join('\n') : '（无）');
    await page.close();
  } finally {
    await ctx.close();
    server.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
