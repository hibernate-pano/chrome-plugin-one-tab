// UI 快照对比：把某个 dist 的界面拍下来，用来和另一个版本**并排比**。
//
// ── 用途 ─────────────────────────────────────────────────────────────────
//
// 「把界面回退到 v1.25.1」这类活儿，光看 diff 看不出「长相差在哪」——
// 必须两版**同样的数据、同样的视口**各拍一张，才知道该退哪几处。
//
// 用法：
//   node scripts/shot-ui.mjs <dist 目录> <输出目录> [标签]
//
// 产出：<输出目录>/manager.png、options.png、manager-search.png、report.json
//
// ⚠️ 数据是**造**出来的（几个 example.com 标签 + 几次保存），
//   两版跑出来的会话名/时间戳会不同 ⇒ 比的是**布局与控件**，不是文字。
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.argv[2] ?? 'dist');
const OUT_DIR = resolve(process.argv[3] ?? 'outputs/shot-ui');
const LABEL = process.argv[4] ?? 'current';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-shot-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
    viewport: { width: 1440, height: 1000 },
  });

  const report = { label: LABEL, dist: DIST, shots: [] };

  try {
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await sleep(500);
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const extId = new URL(sw.url()).host;
    report.extId = extId;

    // ── 造 3 个会话（不同标签数）────────────────────────────────────────
    // ⚠️ 必须在**扩展页**里 evaluate：普通网页上下文里没有 `chrome` API。
    const page = await ctx.newPage();
    const session = await ctx.newCDPSession(page);
    const manager = await ctx.newPage();
    await manager.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await sleep(1500);
    const skip = manager.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 5000 }).then(() => skip.click()).catch(() => {});
    await sleep(800);

    const makeSession = async (urls) => {
      for (const url of urls) {
        await session.send('Target.createTarget', { url, newWindow: false });
      }
      await sleep(900);
      const res = await manager.evaluate(async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const windowId = tabs[0]?.windowId;
        return chrome.runtime.sendMessage({ type: 'SAVE_ALL_TABS', data: { windowId } });
      });
      // 关掉刚存的那些标签，留一张空白页
      await manager.evaluate(async () => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const ids = tabs.filter(t => /^https?:/.test(t.url ?? '')).map(t => t.id);
        if (ids.length) await chrome.tabs.remove(ids);
      });
      await sleep(600);
      return res;
    };

    await makeSession(['https://example.com/', 'https://example.com/one', 'https://example.com/two']);
    await makeSession(['https://example.com/three']);
    await makeSession([
      'https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d',
    ]);

    // ── 管理页 ──────────────────────────────────────────────────────────
    await manager.reload();
    await sleep(1800);
    await manager.screenshot({ path: join(OUT_DIR, 'manager.png'), fullPage: false });
    report.shots.push('manager.png');

    // 展开第一张卡（不同版本里卡头结构不一样，这一步最能看出差别）
    const cardHeader = manager.locator('[data-testid="tab-group-header"], .tab-group-header, .session-card-header').first();
    await cardHeader.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await cardHeader.click().catch(() => {});
    await sleep(900);
    await manager.screenshot({ path: join(OUT_DIR, 'manager-expanded.png') });
    report.shots.push('manager-expanded.png');

    // 搜索/筛选面板
    const searchInput = manager.locator('input[type="search"], input[placeholder*="搜索"]').first();
    await searchInput.fill('example').catch(() => {});
    await sleep(900);
    await manager.screenshot({ path: join(OUT_DIR, 'manager-search.png') });
    report.shots.push('manager-search.png');
    await searchInput.fill('').catch(() => {});

    // ── 设置页 ──────────────────────────────────────────────────────────
    const options = await ctx.newPage();
    await options.goto(`chrome-extension://${extId}/src/options/index.html`);
    await sleep(1800);
    await options.screenshot({ path: join(OUT_DIR, 'options.png'), fullPage: true });
    report.shots.push('options.png');
  } finally {
    await ctx.close().catch(() => {});
  }

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('截图脚本崩了：', err);
  process.exit(1);
});
