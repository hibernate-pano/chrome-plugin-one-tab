// 选项页实测探针（2026-10-14，一次性验证脚本）
//
// 为什么必须有这个：Chrome 扩展的 popup 无法直接预览，光改源码 + 跑 build
// **证明不了任何事**。本脚本用真实浏览器载入 dist 扩展，验证四件只能实测的事：
//
//   ① 设置页能被打开，且 WebDAV 表单在真实宽度下**不溢出**（这是搬出来的唯一理由）
//   ② 设置改动**真的落盘**：关掉窗口重开，值还是新的（不是只改了内存）
//   ③ 主题切换立即生效（data-theme 真的变了，且持久化）
//   ④ 从 popup 菜单点「设置…」能打开设置页（入口没断）
//
// 复用 ui-audit-screenshots.mjs 的踩坑结论：跳过引导走 React、先开页面建
// IndexedDB schema 再注入、独立临时 profile、headless:false（MV3 SW 在
// headless 下不一定起来）。
//
// 用法：先 `pnpm build`，再 `node scripts/_shot-options.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets/ui-audit');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-options-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到扩展 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    // ── ① 打开设置页 ────────────────────────────────────────────────────
    const opt = await ctx.newPage();
    await opt.setViewportSize({ width: 1280, height: 900, deviceScaleFactor: 2 });
    const optErrs = [];
    opt.on('console', m => { if (m.type() === 'error') optErrs.push(m.text()); });
    opt.on('pageerror', e => optErrs.push(String(e)));

    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt.waitForSelector('text=TapStack 设置', { timeout: 15000 });
    await opt.waitForTimeout(1200);
    check('① 设置页能打开并渲染', true);

    await opt.screenshot({ path: join(OUT_DIR, '10-options-light.png'), fullPage: true });
    console.log('   📷 10-options-light.png');

    // ── ② 溢出检测：这是搬出来的唯一理由，必须实测 ────────────────────────
    // 量 WebDAV 表单与其内部每一行的真实宽度，和容器宽度比。
    const overflow = await opt.evaluate(() => {
      const panel = document.querySelector('[data-testid="webdav-settings"]');
      if (!panel) return { error: '未找到 webdav-settings' };
      const panelRect = panel.getBoundingClientRect();
      const bad = [];
      // 按钮行是「最容易横向溢出」的地方：4 个按钮 flex-wrap 在 256px 里必然滚
      const buttons = [...panel.querySelectorAll('button')].map(b => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent.trim().slice(0, 12), right: Math.round(r.right), w: Math.round(r.width) };
      });
      const container = panel.closest('section') || panel.parentElement;
      const cRect = container.getBoundingClientRect();
      for (const b of buttons) {
        if (b.right > cRect.right + 1) bad.push(b);
      }
      // 文档级横向滚动条 = 一定有东西超出视口
      const docScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
      return {
        panelW: Math.round(panelRect.width),
        containerW: Math.round(cRect.right),
        overflowingButtons: bad,
        docHasHScroll: docScroll,
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
      };
    });
    check(
      '② WebDAV 表单在真实宽度下不横向溢出',
      overflow.overflowingButtons.length === 0 && !overflow.docHasHScroll,
      `面板宽 ${overflow.panelW}px，溢出按钮 ${overflow.overflowingButtons.length} 个，` +
      `文档横向滚动 ${overflow.docHasHScroll ? '有' : '无'}` +
      (overflow.overflowingButtons.length ? ` → ${JSON.stringify(overflow.overflowingButtons)}` : '')
    );

    // ── ③ 改设置 → 关窗口 → 重开，验证真的落盘 ────────────────────────────
    // 先切一个非默认主题（legacy → claude），非默认才验证得出「存住了」
    const claudeBtn = opt.locator('button[role="option"]').filter({ hasText: 'Claude' }).first();
    await claudeBtn.click();
    await opt.waitForTimeout(900);
    const themeAfterClick = await opt.evaluate(() => document.documentElement.dataset.theme);
    check('③a 主题点击后立即生效（data-theme 变化）', themeAfterClick === 'claude', `data-theme=${themeAfterClick}`);
    await opt.screenshot({ path: join(OUT_DIR, '11-options-claude.png'), fullPage: true });
    console.log('   📷 11-options-claude.png');

    // 再开一个自动同步开关（写 chrome.storage 的另一条路径）
    const syncSwitch = opt.locator('button[role="switch"][aria-label="自动同步"]');
    await syncSwitch.click();
    await opt.waitForTimeout(900);
    const syncAfter = await syncSwitch.getAttribute('aria-checked');
    check('③b 自动同步开关可切换', syncAfter === 'true', `aria-checked=${syncAfter}`);

    // 关掉这个窗口，另开一个读回来 —— 这才是「持久化」的真正判据
    await opt.close();
    const opt2 = await ctx.newPage();
    await opt2.setViewportSize({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await opt2.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt2.waitForSelector('text=TapStack 设置', { timeout: 15000 });
    await opt2.waitForTimeout(1500);

    const persisted = await opt2.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      syncEnabled: document.querySelector('button[role="switch"][aria-label="自动同步"]')?.getAttribute('aria-checked'),
    }));
    check(
      '③c 设置跨窗口持久化（重开仍是新值）',
      persisted.theme === 'claude' && persisted.syncEnabled === 'true',
      `重开后 theme=${persisted.theme} syncEnabled=${persisted.syncEnabled}`
    );

    // ── ④ 从 popup 菜单点「设置…」 ───────────────────────────────────────
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await pop.goto(`chrome-extension://${id}/src/popup/index.html`);
    await pop.waitForTimeout(1500);
    // 跳过引导：.onboarding-overlay 是 aria-modal 的全屏层，会拦掉菜单点击
    // （与 ui-audit-screenshots.mjs 同一个踩坑）。
    const skip = pop.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await pop.waitForTimeout(800);
    await pop.click('button[aria-label="菜单"]');
    await pop.waitForTimeout(700);
    const menuTxt = await pop.evaluate(() => document.body.innerText);
    check(
      '④a 菜单里有「设置…」入口',
      menuTxt.includes('设置…'),
      ''
    );
    check(
      '④b 菜单里不再有设置项（已搬走）',
      !menuTxt.includes('通知提醒') && !menuTxt.includes('自动同步') && !menuTxt.includes('主题风格'),
      '通知提醒/自动同步/主题风格都不该再出现'
    );
    await pop.screenshot({ path: join(OUT_DIR, '12-menu-slimmed.png') });
    console.log('   📷 12-menu-slimmed.png');

    // 点「设置…」看是否真的打开（openOptionsPage 在 open_in_tab 下开新标签）
    const pagesBefore = ctx.pages().length;
    await pop.locator('button', { hasText: '设置…' }).first().click();
    await pop.waitForTimeout(2000);
    const pagesAfter = ctx.pages().length;
    const opened = ctx.pages().some(p => p.url().includes('/src/options/index.html'));
    check(
      '④c 点「设置…」真的打开了设置页',
      opened || pagesAfter > pagesBefore,
      `页面数 ${pagesBefore} → ${pagesAfter}，命中 options URL: ${opened}`
    );

    // ── ⑤ 深色主题下再看一眼（设置页自身要跟随主题） ──────────────────────
    // ④c 点「设置…」后 openOptionsPage **复用/新建**了设置页标签，具体是哪个
    // 标签不确定。与其猜，直接找出当前所有 options 页面里可见的那个。
    //
    // ⚠️ 用 text= 而不是 getByRole('button', {name})：诊断显示这些按钮是
    // role="radio" 而非 role="button"，且可访问名来自内容文本 ——
    // getByRole('button') 因此永远匹配不到。教训：角色变了就别按旧角色找。
    const optPages = ctx.pages().filter(p => p.url().includes('/src/options/index.html'));
    let darkPage = null;
    for (const p of optPages) {
      await p.bringToFront().catch(() => {});
      await p.waitForTimeout(400);
      const btn = p.locator('button[role="radio"]', { hasText: '始终深色' });
      if (await btn.first().isVisible().catch(() => false)) { darkPage = p; break; }
    }
    if (!darkPage) {
      for (const p of optPages) {
        const diag = await p.evaluate(() => ({
          url: location.href, hidden: document.hidden,
          btnCount: document.querySelectorAll('button[role="radio"]').length,
        })).catch(e => ({ err: String(e) }));
        console.log('   🔍 诊断:', JSON.stringify(diag));
      }
      throw new Error('找不到可交互的设置页标签');
    }
    await darkPage.locator('button[role="radio"]', { hasText: '始终深色' }).first().click();
    await darkPage.waitForTimeout(900);
    const isDark = await darkPage.evaluate(() => document.documentElement.classList.contains('dark'));
    check('⑤ 深色模式切换生效', isDark, `html.dark=${isDark}`);
    await darkPage.screenshot({ path: join(OUT_DIR, '13-options-dark.png'), fullPage: true });
    console.log('   📷 13-options-dark.png');

    if (optErrs.length) {
      console.log('\n⚠️ 设置页控制台错误:');
      for (const e of [...new Set(optErrs)].slice(0, 8)) console.log('   ', e);
      check('⑥ 设置页无控制台错误', false, `${optErrs.length} 条`);
    } else {
      check('⑥ 设置页无控制台错误', true);
    }

    const failed = results.filter(r => !r.pass);
    writeFileSync(
      join(OUT_DIR, 'options-probe-result.json'),
      JSON.stringify({ results, consoleErrors: [...new Set(optErrs)] }, null, 2)
    );
    console.log(`\n${'='.repeat(50)}`);
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    if (failed.length) {
      console.log('失败项:');
      for (const f of failed) console.log('  ❌', f.name, f.detail);
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('探针异常:', err);
  process.exit(1);
});