/**
 * 断网 + 未登录下的**本地功能全景**：
 *   A. 恢复（在当前窗口打开 / 在新窗口恢复）
 *   B. 改名 / 锁定 / 删除 + 撤销
 *   C. 本地用户看得见、但用不上的云端入口（上传 / 下载 / 登录）断网时是什么反馈
 *
 * 断网自检不通过 ⇒ 直接中止（不出结论）。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-offline';
const PORT = 8901;

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

/** 读当前界面上有没有 toast / 报错文案。 */
async function readFeedback(page) {
  return page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const toasts = [...document.querySelectorAll('[role="alert"], [role="status"], [class*="toast"], [class*="Toast"]')]
      .map(t => (t.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { toasts, tail: text.slice(-260) };
  });
}

async function main() {
  const server = await startServer();
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-offline2-'));
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

    // 造标签
    for (const [path] of PAGES) {
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${PORT}${path}`);
    }

    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => errors.push('EXC ' + String(e).slice(0, 160)));
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1200);

    // ── 保存 ────────────────────────────────────────────────────────────
    await page.locator('button[aria-label*="保存"]').first().click();
    await page.waitForTimeout(2000);
    console.log('保存后：', JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('.tab-group-title')].map(t => t.textContent.trim()))));

    // ── A. 在当前窗口打开（恢复） ───────────────────────────────────────
    const card = page.locator('.tab-group-card').first();
    const openInPlace = card.locator('button[aria-label^="在当前窗口打开整个会话"]').first();
    console.log('\n=== A. 恢复（在当前窗口打开）===');
    const tA = Date.now();
    await openInPlace.click();
    await page.waitForTimeout(2000);
    console.log('耗时', Date.now() - tA, 'ms');
    console.log('反馈：', JSON.stringify(await readFeedback(page)));
    const restored = ctx.pages().map(p => p.url()).filter(u => u.includes(`127.0.0.1:${PORT}`));
    console.log('被打开的本地标签：', JSON.stringify(restored));
    await page.screenshot({ path: `${OUT}-4-restored.png` });

    // 恢复后标签被消费掉了？会话里还剩几条
    console.log('恢复后会话内容：', JSON.stringify(await page.evaluate(() => {
      const card = document.querySelector('.tab-group-card');
      return card ? card.innerText.replace(/\s+/g, ' ').slice(0, 200) : '(无)';
    })));

    // ── B. 改名 / 锁定 / 删除 + 撤销 ────────────────────────────────────
    console.log('\n=== B. 改名 / 锁定 / 删除 ===');
    const more = card.locator('summary[aria-haspopup="menu"], button[aria-haspopup="menu"]').first();
    if (await more.count()) {
      await more.click();
      await page.waitForTimeout(400);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()));
      console.log('菜单项：', JSON.stringify(items));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // 锁定（卡头上的锁按钮）
    const lockBtn = card.locator('button[aria-label*="锁定"], button[aria-label*="解锁"]').first();
    if (await lockBtn.count()) {
      console.log('锁定按钮 aria：', await lockBtn.getAttribute('aria-label'));
      await lockBtn.click();
      await page.waitForTimeout(1200);
      console.log('锁定后：', JSON.stringify(await readFeedback(page)));
    }

    // 删除（卡头上的垃圾桶）
    const delBtn = card.locator('button[aria-label*="删除"]').first();
    if (await delBtn.count()) {
      await delBtn.click();
      await page.waitForTimeout(700);
      const dialog = page.locator('[role="dialog"]');
      if (await dialog.count()) {
        console.log('确认框文案：', (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 200));
        await page.screenshot({ path: `${OUT}-5-delete-confirm.png` });
        const confirm = dialog.locator('button').filter({ hasText: /删除|确定|确认/ }).last();
        await confirm.click();
        await page.waitForTimeout(1500);
      }
      const fb = await readFeedback(page);
      console.log('删除后反馈：', JSON.stringify(fb));
      await page.screenshot({ path: `${OUT}-6-after-delete.png` });

      // 撤销
      const undo = page.locator('button').filter({ hasText: /撤销|撤回|还原/ }).first();
      if (await undo.count()) {
        console.log('找到撤销按钮：', await undo.innerText());
        await undo.click();
        await page.waitForTimeout(1500);
        console.log('撤销后还剩几个会话：', await page.evaluate(() =>
          document.querySelectorAll('.tab-group-card').length));
      } else {
        console.log('❌ 撤销按钮没找到');
      }
    }

    // ── C. 云端入口断网时的反馈 ─────────────────────────────────────────
    console.log('\n=== C. 云端入口（断网、未登录）===');
    for (const [label, sel] of [['上传', 'button[aria-label*="上传"]'], ['下载', 'button[aria-label*="下载"]']]) {
      const btn = page.locator(sel).first();
      if (!(await btn.count())) { console.log(label, '按钮没找到'); continue; }
      const t = Date.now();
      await btn.click();
      await page.waitForTimeout(6000);
      console.log(`${label} → 耗时 ${Date.now() - t}ms，反馈：`, JSON.stringify(await readFeedback(page)));
      await page.screenshot({ path: `${OUT}-7-${label}.png` });
    }

    const loginBtn = page.locator('button').filter({ hasText: /登录/ }).first();
    if (await loginBtn.count()) {
      const t = Date.now();
      await loginBtn.click();
      await page.waitForTimeout(4000);
      console.log(`登录 → 耗时 ${Date.now() - t}ms，反馈：`, JSON.stringify(await readFeedback(page)));
      await page.screenshot({ path: `${OUT}-8-login.png` });
    }

    console.log('\n=== 控制台报错 ===');
    console.log(errors.length ? [...new Set(errors)].slice(0, 10).join('\n') : '（无）');
    await page.close();
  } finally {
    await ctx.close();
    server.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
