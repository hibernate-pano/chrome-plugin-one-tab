// 设置页信息架构真机走查（2026-10-20 第二轮审计）。
//
// 验三件事 —— 它们都只在**真浏览器**里才看得见（源码看着都对）：
//
//   ① 出口：页首有「回到 TapStack」，点了真的能到管理页。
//      而且如果管理页已经开着，必须**切过去**而不是再开一个。
//   ② 账号区：设置页自己没有登录入口时，那句「去右上角菜单登录」是死指针。
//      这里确认本页真的渲染出了登录入口，且页面上不存在「右上角菜单」。
//   ③ 折叠：「自带存储配置」默认收起，但**能展开**，且展开后表单真的可交互
//      （折叠时它的输入框必须不在 Tab 序列里 —— 用真实 Tab 键验证）。
//
// 用法：pnpm build 之后 `node scripts/prod-options-ia.mjs`
// 结果：每条打印 PASS/FAIL，任一 FAIL ⇒ exit 1。

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-ia-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--lang=zh-CN',
    ],
  });

  try {
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('service worker 没起来 —— 扩展没加载');
    const id = new URL(sw.url()).host;

    const optionsUrl = `chrome-extension://${id}/src/options/index.html`;
    const managerUrl = `chrome-extension://${id}/src/popup/index.html`;

    // ══════════════════════════════════════════════════════════════════
    // 1280×800（真实标签页宽度，不是 400px 的假前提）
    // ══════════════════════════════════════════════════════════════════
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(optionsUrl);
    await page.waitForTimeout(1800);

    // ── ① 出口存在且在首屏 ─────────────────────────────────────────────
    const exitBtn = page.getByRole('button', { name: /回到 TapStack/ });
    const exitCount = await exitBtn.count();
    check('① 页首有「回到 TapStack」按钮', exitCount === 1, `count=${exitCount}`);
    if (exitCount === 1) {
      const box = await exitBtn.boundingBox();
      check(
        '① 出口在首屏内（y < 视口高）',
        !!box && box.y >= 0 && box.y < 800,
        box ? `y=${Math.round(box.y)}` : 'no box'
      );
    }

    // ── ② 账号区：本页自己的登录入口 ───────────────────────────────────
    const bodyText = await page.evaluate(() => document.body.innerText);
    check(
      '② 页面不含「右上角菜单」（本页没有菜单）',
      !bodyText.includes('右上角菜单'),
      bodyText.includes('右上角菜单') ? '仍出现死指针' : ''
    );
    // 未登录 + 默认云端后端 ⇒ 应显示账号区
    const hasAccountBlock = bodyText.includes('尚未登录 TapStack 云端');
    const hasLoginBtn = (await page.getByRole('button', { name: /登录 \/ 注册/ }).count()) === 1;
    check('② 未登录时显示账号区', hasAccountBlock);
    check('② 账号区有可点的「登录 / 注册」', hasLoginBtn);

    // 点开登录弹窗，确认它真的出现（不是空按钮）
    if (hasLoginBtn) {
      await page.getByRole('button', { name: /登录 \/ 注册/ }).click();
      await page.waitForTimeout(600);
      const dialogCount = await page.getByRole('dialog', { name: /登录或注册账号/ }).count();
      check('② 点「登录 / 注册」真的弹出登录框', dialogCount === 1, `dialog=${dialogCount}`);
      // Esc 关掉
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterEsc = await page.getByRole('dialog', { name: /登录或注册账号/ }).count();
      check('② Esc 能关掉登录框', afterEsc === 0, `dialog=${afterEsc}`);
    }

    // ── ③ 「自带存储配置」默认折叠，且能展开 ────────────────────────────
    const disclosure = page.getByRole('button', { name: /自带存储配置/ });
    const dCount = await disclosure.count();
    check('③ 找到「自带存储配置」的折叠按钮', dCount === 1, `count=${dCount}`);
    if (dCount === 1) {
      const expanded = await disclosure.getAttribute('aria-expanded');
      check('③ 默认是折叠的（aria-expanded=false）', expanded === 'false', `aria-expanded=${expanded}`);

      // 折叠态：面板里的输入框不得可聚焦（hidden 生效的硬证据）
      const focusableWhenCollapsed = await page.evaluate(() => {
        const panel = document.getElementById('webdav-settings-panel');
        if (!panel) return -1;
        const inputs = [...panel.querySelectorAll('input, select, textarea, button')];
        return inputs.filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length;
      });
      check(
        '③ 折叠时面板内无可见控件（hidden 真生效）',
        focusableWhenCollapsed === 0,
        `visible=${focusableWhenCollapsed}`
      );

      // 用真实键盘 Tab 验证：折叠时 Tab 不进面板
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      let reachedPanel = false;
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const panel = document.getElementById('webdav-settings-panel');
          return !!panel && panel.contains(document.activeElement);
        });
        if (inside) {
          reachedPanel = true;
          break;
        }
      }
      check('③ 折叠时键盘 Tab 不会进面板（真按 Tab 键验证）', !reachedPanel);

      // 展开
      await disclosure.click();
      await page.waitForTimeout(500);
      const expanded2 = await disclosure.getAttribute('aria-expanded');
      check('③ 点击后展开（aria-expanded=true）', expanded2 === 'true', `aria-expanded=${expanded2}`);
      const visibleWhenExpanded = await page.evaluate(() => {
        const panel = document.getElementById('webdav-settings-panel');
        if (!panel) return -1;
        return [...panel.querySelectorAll('input, select, textarea, button')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).length;
      });
      check(
        '③ 展开后表单真的可见可交互',
        visibleWhenExpanded > 0,
        `visible=${visibleWhenExpanded}`
      );

      // 手动展开后不得被自动改回去（等一会儿再看）
      await page.waitForTimeout(1500);
      const stillExpanded = await disclosure.getAttribute('aria-expanded');
      check('③ 手动展开后不被自动改回折叠', stillExpanded === 'true', `aria-expanded=${stillExpanded}`);
    }

    // ── ① 出口的真实跳转（最后测，因为它会离开本页）─────────────────────
    //
    // 两条分支都要验，因为它们的失败方式完全不同：
    //   · 没有管理页 ⇒ 必须新开一个（不测的话「点了没反应」）；
    //   · 已有管理页 ⇒ 必须**切过去**（不测的话用户会得到两个管理页，
    //     而且他改的设置在一个页面里生效、另一个页面看不到）。
    if (exitCount === 1) {
      const before = ctx.pages().length;
      await exitBtn.click();
      await page.waitForTimeout(2000);
      const after = ctx.pages().length;
      const managerOpen = ctx.pages().some(p => p.url().includes('/src/popup/index.html'));
      check('① 没有管理页时，点出口会新开一个', managerOpen, `pages ${before}→${after}`);
      check('① 且只多开一个标签', after === before + 1, `${before}→${after}`);

      // 分支二：管理页已经开着 ⇒ 必须切过去，不得再开一个。
      const page2 = await ctx.newPage();
      await page2.setViewportSize({ width: 1280, height: 800 });
      await page2.goto(optionsUrl);
      await page2.waitForTimeout(1500);
      const before2 = ctx.pages().length;
      const managersBefore = ctx.pages().filter(p => p.url().includes('/src/popup/index.html')).length;
      await page2.getByRole('button', { name: /回到 TapStack/ }).click();
      await page2.waitForTimeout(2000);
      const after2 = ctx.pages().length;
      const managersAfter = ctx.pages().filter(p => p.url().includes('/src/popup/index.html')).length;
      check(
        '① 已有管理页时切过去（不再新开）',
        after2 === before2 && managersAfter === managersBefore,
        `pages ${before2}→${after2}，管理页 ${managersBefore}→${managersAfter}`
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // 1440×900 复测（用户的大屏）
    // ══════════════════════════════════════════════════════════════════
    const wide = await ctx.newPage();
    await wide.setViewportSize({ width: 1440, height: 900 });
    await wide.goto(optionsUrl);
    await wide.waitForTimeout(1500);
    const wideText = await wide.evaluate(() => document.body.innerText);
    check('宽屏 1440：仍无「右上角菜单」', !wideText.includes('右上角菜单'));
    const wideExit = await wide.getByRole('button', { name: /回到 TapStack/ }).count();
    check('宽屏 1440：出口仍在', wideExit === 1, `count=${wideExit}`);
    // 水平溢出检查（页首那行 flex-wrap 不该把页面撑宽）
    const overflow = await wide.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check('宽屏 1440：无横向溢出', overflow <= 0, `overflow=${overflow}px`);

    // ══════════════════════════════════════════════════════════════════
    // 窄视口（设置页是**独立标签页**，用户可以把窗口拉得很窄）
    //
    // 之前只测了 1280 / 1440 —— 但设置页不像 popup 那样被钉死在 400px，
    // 它是一个**普通的标签页**，会被用户拖成 320px 宽（分屏、并排窗口）。
    // 那种宽度下：出口按钮（「回到 TapStack」）必须还在首屏、还点得到；
    // 折叠起来的自带存储面板不能横向溢出。
    // ══════════════════════════════════════════════════════════════════
    for (const width of [360, 320]) {
      const narrow = await ctx.newPage();
      await narrow.setViewportSize({ width, height: 720 });
      await narrow.goto(optionsUrl);
      await narrow.waitForTimeout(1200);

      const narrowOverflow = await narrow.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      check(
        `窄屏 ${width}：无横向溢出`,
        narrowOverflow <= 0,
        `overflow=${narrowOverflow}px`
      );

      // 出口按钮：必须**在首屏**（不用滚就能看到），且可点
      const exitBox = await narrow.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b =>
          (b.textContent || '').includes('回到 TapStack')
        );
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
      });
      check(
        `窄屏 ${width}：出口按钮在首屏且可点`,
        !!exitBox && exitBox.y >= 0 && exitBox.y < 720 && exitBox.h >= 28 && exitBox.w >= 60,
        JSON.stringify(exitBox)
      );

      // 折叠状态下不能有可见控件漏出来（之前只在 1280 验过）
      const visibleInPanel = await narrow.evaluate(() => {
        const panel = document.querySelector('#webdav-settings-panel');
        if (!panel) return -1;
        const controls = panel.querySelectorAll('input, button, select, textarea');
        let visible = 0;
        for (const c of controls) {
          const r = c.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) visible++;
        }
        return visible;
      });
      check(
        `窄屏 ${width}：折叠的自带存储面板没有可见控件`,
        visibleInPanel === 0,
        `visible=${visibleInPanel}`
      );

      await narrow.close();
    }
  } finally {
    await ctx.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  · ${f.name}  ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
