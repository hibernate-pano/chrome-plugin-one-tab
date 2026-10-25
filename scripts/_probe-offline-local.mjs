/**
 * 真机量一量：**不登录 + 完全断网**，这个扩展还是不是一个好用的本地标签管理器。
 *
 * 断网做法：`--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`
 * ⇒ 所有外部域名解析失败（云端、字体、统计全挂），只有本地 127.0.0.1 的
 * 测试服务器还活着（用来造「可以保存的标签」）。这比 setOffline(true) 更贴近
 * 真实断网：本地服务仍可用，外部请求是真实的网络失败。
 *
 * 量什么：
 *  ① 首屏什么时候出列表（断网时会不会卡在 spinner 上等云端）��
 *  ② 「保存并关闭」这条主闭环还通不通；
 *  ③ 列表 / 搜索 / 改名 / 锁定 这些本地功能是否照常；
 *  ④ 界面上有没有把「断网」说成「未登录」或报错吓人。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-offline';
const PORT = 8899;

const PAGES = [
  ['/one', '第一个本地页面'],
  ['/two', '第二个本地页面'],
  ['/three', '第三个本地页面'],
];

function startServer() {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const page = PAGES.find(([p]) => p === path);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${page ? page[1] : '本地页'}</title>
      <h1>${page ? page[1] : '本地页'}</h1><p>${path}</p>`);
  });
  return new Promise(resolvePromise => server.listen(PORT, '127.0.0.1', () => resolvePromise(server)));
}

async function main() {
  const server = await startServer();
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-offline-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
      // 断网：所有外部域名解析失败，127.0.0.1 放行（本地测试页）
      // ⚠️ 必须同时关掉 DoH —— Chrome 默认走加密 DNS，会**绕过** host-resolver-rules
      //    （实测：不加这条时 fetch googleapis 照样通 ⇒ 断网没生效）。
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--dns-over-https-mode=off',
    ],
  });

  // 页级兜底：非 127.0.0.1 的 http(s) 一律断开
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('chrome-extension://')) return route.continue();
    return route.abort('internetdisconnected');
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到 service worker');
    const extId = new URL(sw.url()).host;
    console.log('扩展 ID：', extId);

    // 断网自证：外部域名必须解析失败（fail-closed：没断成就直接中止，不出结论）
    const netTest = await ctx.newPage();
    const reachable = await netTest.evaluate(async () => {
      try {
        await fetch('https://www.googleapis.com/', { mode: 'no-cors' });
        return '通了（断网没生效！）';
      } catch (e) {
        return `失败（${e.message}）`;
      }
    });
    console.log('外部网络自检：', reachable);
    if (reachable.startsWith('通了')) {
      console.error('❌ 断网没生效，这次测量作废（假断网 ⇒ 结论是假的）');
      await ctx.close();
      server.close();
      process.exit(2);
    }
    await netTest.close();

    // 造 3 个可保存的标签（都在同一窗口里）
    for (const [path] of PAGES) {
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${PORT}${path}`);
    }
    const pagesBefore = ctx.pages().length;
    console.log('窗口里的标签数（含弹窗页）：', pagesBefore);

    // ── 首屏 ────────────────────────────────────────────────────────────
    const page = await ctx.newPage();
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));

    const t0 = Date.now();
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);

    // 列表（空态也算）出现 = 首屏可用了
    let firstPaintMs = null;
    for (let i = 0; i < 120; i++) {
      const ok = await page.evaluate(() =>
        !!(document.querySelector('.session-list-stack, .session-grid, .empty-state, [class*="empty"]')));
      if (ok) { firstPaintMs = Date.now() - t0; break; }
      await page.waitForTimeout(100);
    }
    console.log('首屏出列表耗时：', firstPaintMs === null ? '❌ 30s 内没出来' : `${firstPaintMs}ms`);

    // 跳过引导
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        bodyText: text.replace(/\s+/g, ' ').slice(0, 700),
        hasSpinner: !!document.querySelector('.animate-spin, [class*="spinner"], [class*="loading"]'),
        // 有没有把断网说成「未登录」/ 报错
        mentions: ['未登录', '登录', '网络', '离线', '云端', '同步', '失败', '错误', '不可用']
          .filter(w => text.includes(w)),
        buttons: [...document.querySelectorAll('button')].map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 24),
      };
    });
    console.log('\n=== 断网首屏 ===');
    console.log('文本：', state.bodyText);
    console.log('还在转圈吗：', state.hasSpinner);
    console.log('出现的关键词：', JSON.stringify(state.mentions));
    console.log('按钮：', JSON.stringify(state.buttons, null, 0));
    await page.screenshot({ path: `${OUT}-1-first-screen.png` });

    // ── 主闭环：保存并关闭 ──────────────────────────────────────────────
    const saveBtn = page.locator('button[aria-label*="保存"]').first();
    const saveLabel = await saveBtn.getAttribute('aria-label');
    console.log('\n保存按钮：', saveLabel);
    await saveBtn.click();
    await page.waitForTimeout(2500);

    const afterSave = await page.evaluate(() => ({
      titles: [...document.querySelectorAll('.tab-group-title')].map(t => t.textContent.trim()),
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    }));
    console.log('保存后的会话：', JSON.stringify(afterSave.titles));
    console.log('保存后文本：', afterSave.bodyText);
    await page.screenshot({ path: `${OUT}-2-after-save.png` });

    // 原标签是否被关掉
    const remaining = ctx.pages().map(p => p.url()).filter(u => u.includes(`127.0.0.1:${PORT}`));
    console.log('还开着的本地标签：', JSON.stringify(remaining), '（保存并关闭应该把它们都关掉）');

    // ── 搜索 ────────────────────────────────────────────────────────────
    const search = page.locator('input[type="search"], input[placeholder*="搜索"]').first();
    if (await search.count()) {
      await search.fill('第一个');
      await page.waitForTimeout(800);
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('.tab-group-title')].map(t => t.textContent.trim()));
      console.log('\n搜「第一个」的结果：', JSON.stringify(found));
      await search.fill('');
      await page.waitForTimeout(500);
    }

    // ── 改名 + 锁定（纯本地） ───────────────────────────────────────────
    const card = page.locator('.tab-group').first();
    if (await card.count()) {
      const more = card.locator('summary[aria-haspopup="menu"], button[aria-haspopup="menu"]').first();
      if (await more.count()) {
        await more.click();
        await page.waitForTimeout(500);
        const items = await page.evaluate(() =>
          [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()));
        console.log('\n菜单项：', JSON.stringify(items));
        await page.keyboard.press('Escape');
      }
    }
    await page.screenshot({ path: `${OUT}-3-final.png` });

    console.log('\n=== 控制台报错（页面） ===');
    console.log(consoleErrors.length ? consoleErrors.slice(0, 8).join('\n') : '（无）');
    console.log('=== 未捕获异常 ===');
    console.log(pageErrors.length ? pageErrors.slice(0, 8).join('\n') : '（无）');

    // SW 侧的报错
    const swErrors = [];
    sw.on('console', m => { if (m.type() === 'error') swErrors.push(m.text().slice(0, 200)); });
    await page.waitForTimeout(500);
    console.log('=== SW 控制台报错 ===');
    console.log(swErrors.length ? swErrors.slice(0, 8).join('\n') : '（无）');

    await page.close();
  } finally {
    await ctx.close();
    server.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
