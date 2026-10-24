// 真机验证：提示条（Tooltip）的宽度与可见性（2026-10-24）。
//
// ── 为什么必须真机 ───────────────────────────────────────────────────────
//
// 缺陷本体是**排版**：「顶栏『切换双栏布局』的提示条被压成 26px 宽、
// 118px 高、一个汉字一行」。这句话里的每一个数字都来自**真实布局**，
// 单测里没有第二个浏览器可量 —— 而源码里看不出「绝对定位元素的收缩宽度
// 取决于包含块」这件事（读代码只会看到 `right-0`，看不出它会被压成 26px）。
//
// ⇒ 判据只能落在真机量出来的几何上：
//   ① 短提示语必须是**一行**，且宽度明显大于触发元素（36px 的图标按钮）；
//   ② 长提示语必须换行成**正常的多行块**，不许一个汉字一行；
//   ③ 任何情况下提示条都必须**完整落在视口内**（宽度变大之后，
//      靠左的触发元素会把它顶出左缘 ⇒ 组件里有「夹回视口」那一步）。
//
// 用法：先 `pnpm build`，再 `node scripts/verify-tooltip-width.mjs`。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/verify-tooltip-width');

const problems = [];
const log = [];

function check(ok, message, detail = '') {
  if (!ok) problems.push(`${message}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 量一条提示条的真实几何。 */
async function measureTip(page, label) {
  return page.evaluate(label => {
    const tip = document.querySelector('.tooltip');
    if (!tip) return { label, found: false };
    const r = tip.getBoundingClientRect();
    const cs = getComputedStyle(tip);
    const lineHeight = parseFloat(cs.lineHeight) || 16;
    const contentHeight = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return {
      label,
      found: true,
      text: (tip.textContent ?? '').slice(0, 40),
      width: Math.round(r.width),
      height: Math.round(r.height),
      lines: Math.max(1, Math.round(contentHeight / lineHeight)),
      left: Math.round(r.left),
      right: Math.round(r.right),
      viewportWidth: window.innerWidth,
      fullyVisible: r.left >= 0 && r.right <= window.innerWidth,
    };
  }, label);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-tooltip-'));
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

  try {
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await sleep(500);
    }
    if (!sw) throw new Error('扩展的 service worker 没有起来');
    const extId = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await sleep(1500);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => skip.click())
      .catch(() => {});

    // 造一个会话（卡片头里才有「锁定」按钮 —— 那条提示语最长）。
    // ⚠️ 网页必须开在**另一个标签页**里：扩展页面上才有 chrome.* API，
    //    把它导航到 example.com 就等于把扩展页面本身换掉了。
    const webPage = await ctx.newPage();
    for (const url of ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']) {
      await webPage.goto(url);
    }
    await sleep(1200);
    await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId: tabs[0]?.windowId },
      });
    });
    await sleep(1200);
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await sleep(1800);

    // ── ① 顶栏的短提示语 ────────────────────────────────────────────────
    const toggle = page.locator('button[aria-label="切换为双栏布局"]').first();
    await toggle.waitFor({ state: 'visible', timeout: 5000 });
    await toggle.hover();
    await sleep(700);
    const short = await measureTip(page, '顶栏·切换布局');
    log.push(short);
    check(short.found, '顶栏提示条没有出现');
    check(
      short.lines === 1,
      '顶栏的短提示语必须是一行',
      `实测 ${short.lines} 行（宽 ${short.width}px、高 ${short.height}px）`
    );
    check(
      short.width > 60,
      '顶栏提示条的宽度必须明显大于触发元素（36px 的图标按钮）',
      `实测 ${short.width}px —— 小于它就说明又被压扁了`
    );
    check(short.fullyVisible, '顶栏提示条必须完整落在视口内', `left=${short.left} right=${short.right}`);

    // ── ② 卡片头的长提示语 ───────────────────────────────────────────────
    const lock = page.locator('button[aria-label*="锁定"], button[aria-label*="解锁"]').first();
    if (await lock.count()) {
      await lock.hover();
      await sleep(700);
      const long = await measureTip(page, '卡片头·锁定');
      log.push(long);
      check(
        long.lines >= 2 && long.lines <= 6,
        '长提示语必须换行成正常的多行块（不许一个汉字一行）',
        `实测 ${long.lines} 行`
      );
      check(
        long.width <= 20 * 16 + 1,
        '提示条宽度不许超过 20rem 的上限',
        `实测 ${long.width}px`
      );
      check(long.fullyVisible, '长提示条必须完整落在视口内', `left=${long.left} right=${long.right}`);
    } else {
      problems.push('没找到卡片头的锁定按钮 —— 长提示语这一项没验成');
    }

    // ── ③ 窄视口（400px）：不许被挤出视口 ────────────────────────────────
    await page.setViewportSize({ width: 400, height: 800 });
    await sleep(800);
    const narrowBtn = page.locator('.app-header-actions .btn-icon:visible').first();
    if (await narrowBtn.count()) {
      await narrowBtn.hover().catch(() => {});
      await sleep(700);
      const narrow = await measureTip(page, '400px 视口·顶栏按钮');
      log.push(narrow);
      check(narrow.found, '窄视口下提示条没有出现');
      check(narrow.fullyVisible, '窄视口下提示条必须完整落在视口内', `left=${narrow.left} right=${narrow.right}`);
      check(
        narrow.lines === 1,
        '窄视口下的短提示语仍必须是一行',
        `实测 ${narrow.lines} 行（宽 ${narrow.width}px）`
      );
    }

    await page.screenshot({ path: join(OUT_DIR, 'tooltip-400.png') }).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(JSON.stringify(log, null, 2));
  if (problems.length > 0) {
    console.error('\n❌ 提示条真机验证失败：');
    for (const p of problems) console.error(`  · ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 提示条真机验证通过');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
