// 内网 / localhost 场景的**会话名**真机复验（2026-10-22 审计 U-06）。
//
// ── 为什么要有这个脚本 ───────────────────────────────────────────────────
//
// `scripts/lead-inspect.mjs` 注入的会话名是**写死的中文名**
// （「V2 同步架构评审」…），它验的是**版面**，验不到**命名链**：
// 命名发生在**保存那一刻**（`createTabGroupFromChromeTabs` ⇒
// `buildTimestampSessionName`），列表页渲染的是**存下来的名字**。
//
// ⇒ 这个脚本走**产品真实的保存路径**：
//   ① 起两个真的本地 HTTP 服务（3000 / 8080），让 localhost 页面真的加载、
//      真的有标题；
//   ② 在**同一个窗口**里开这些标签（`http://localhost:3000/…`、
//      `http://[::1]:8080/…`、`http://192.168.1.5/admin`…）；
//   ③ 打开扩展页，点真实的「保存并关闭」按钮；
//   ④ 读列表里那张卡的标题 —— 必须是**保存那一刻**（`2026-10-25 14:30`
//      这种形状），**不是**插件写死的中文名、也不是「标签组 10月22日 …」。
//
// ⚠️ 2026-10-25 产品定案：默认名**一律**是保存时刻（**没有例外**）⇒
//    站点身份**不再**进名字 ⇒ 脚本要看的站点身份在**标签行右侧的域名**上，
//    截图里能看到。
//
// 【为什么要起真的服务器】`http://localhost:3000` 如果没有服务在听，
// 页面会加载失败（标题变成错误页），而「加载失败」本身可能引入
// 别的变量（标题为空、tab.url 是否还保留…）。起真的服务 ⇒ 场景是真的。
//
// 用法：`pnpm build` 之后 `node scripts/lead-inspect-localhost.mjs`
// 产物：outputs/lead-inspect-localhost/*.png

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-inspect-localhost');
const DESK = { width: 1440, height: 900 };

/** 起一个真的本地服务：返回 { origin, close } */
function startServer(port, title) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>` +
        `<body style="font-family:system-ui;padding:40px"><h1>${title}</h1></body></html>`
    );
  });
  // 绑 '::' ⇒ 双栈，localhost(127.0.0.1) 与 [::1] 都能连上
  server.listen(port, '::');
  return {
    origin: `http://localhost:${port}`,
    close: () => new Promise(done => server.close(done)),
  };
}

const run = async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const app3000 = startServer(3411, '本地项目 · 前端');
  const app8080 = startServer(8412, '本地项目 · 接口文档');
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-localhost-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  const report = { cards: [], windows: null, capturedBySave: null };
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('未找到 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    // ── 1. 在同一个窗口里开「内网 / 本地」标签 ──────────────────────────
    const pages = ctx.pages();
    const first = pages[0] ?? (await ctx.newPage());
    await first.goto(`${app3000.origin}/app`);

    const targets = [
      `${app3000.origin}/app`,
      `${app3000.origin}/settings`,
      'http://[::1]:8412/docs',
      'http://192.168.1.5/admin',
    ];
    for (const url of targets) {
      const p = await ctx.newPage();
      await p.goto(url).catch(() => {});
      await p.waitForTimeout(300);
    }

    // 诊断：SW 眼里的「当前窗口」到底装了什么（保存走的就是这个口径）
    report.windows = await sw.evaluate(async () => {
      const wins = await chrome.windows.getAll({ populate: true });
      return wins.map(w => ({
        id: w.id,
        focused: w.focused,
        tabs: (w.tabs ?? []).map(t => t.url),
      }));
    });
    report.capturedBySave = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.map(t => t.url);
    });
    console.log('窗口布局:', JSON.stringify(report.windows, null, 1));
    console.log('保存会捕获的标签:', JSON.stringify(report.capturedBySave, null, 1));

    // ── 2. 打开扩展页，点真实的「保存并关闭」 ───────────────────────────
    const page = await ctx.newPage();
    await page.setViewportSize(DESK);
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => skip.click())
      .catch(() => {});
    await page.waitForTimeout(800);

    await page.screenshot({ path: join(OUT_DIR, '01-before-save.png'), fullPage: true });

    await page.getByRole('button', { name: /保存并关闭/ }).first().click();
    await page.waitForTimeout(3500);

    // ── 3. 读列表里的会话名 ──────────────────────────────────────────────
    report.cards = await page.evaluate(() =>
      [...document.querySelectorAll('.tab-group-title')].map(el => el.textContent?.trim() ?? '')
    );
    console.log('列表里的会话名:', JSON.stringify(report.cards, null, 1));

    await page.screenshot({ path: join(OUT_DIR, '02-after-save.png'), fullPage: true });

    // 卡片头特写（会话名在卡头的位置）
    const cardHead = page.locator('[class*="group-header"], .tab-group-header').first();
    if (await cardHead.count()) {
      await cardHead.screenshot({ path: join(OUT_DIR, '03-card-header.png') }).catch(() => {});
    }

    console.log('\n=== REPORT ===');
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await ctx.close();
    await app3000.close();
    await app8080.close();
  }
};

run().catch(e => {
  console.error('失败:', e);
  process.exit(1);
});
