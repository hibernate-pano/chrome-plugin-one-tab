// 设置页真机走查 —— 「设置」是用户配置一切的地方，也是最容易被忘记的地方。
// 用法：pnpm build 之后 `node scripts/prod-options.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-options');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-options-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`chrome-extension://${id}/src/options/index.html`);
    await page.waitForTimeout(2000);

    // 1. 首屏可见内容
    const structure = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('section, [id^="sec-"]')].map(s => {
        const r = s.getBoundingClientRect();
        const h = s.querySelector('h2, h3, h1');
        return {
          id: s.id || '(no id)',
          title: h ? h.textContent.trim() : (s.querySelector('[class*="text-base"]')?.textContent.trim() || '?'),
          y: Math.round(r.y),
          h: Math.round(r.height),
          visibleInFold: r.y < 800 && r.bottom > 0,
        };
      });
      return {
        docH: document.documentElement.scrollHeight,
        sections: sec,
        // 首屏可见的开关数量
        switchesInFold: [...document.querySelectorAll('input[type="checkbox"], [role="switch"]')]
          .filter(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= 800; }).length,
        totalSwitches: document.querySelectorAll('input[type="checkbox"], [role="switch"]').length,
        // 首屏可见的按钮
        buttonsInFold: [...document.querySelectorAll('button')].filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.top >= 0 && r.bottom <= 800;
        }).map(b => b.textContent.trim().slice(0, 16) || b.getAttribute('aria-label')).filter(Boolean),
      };
    });
    console.log('设置页结构:', JSON.stringify(structure, null, 1));
    await page.screenshot({ path: join(OUT_DIR, '01-fold.png') });

    // 2. 有没有「返回」或明显的出口
    const nav = await page.evaluate(() => ({
      links: [...document.querySelectorAll('a')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
      backButtons: [...document.querySelectorAll('button')].filter(b => /返回|回到|关闭/.test(b.textContent + (b.getAttribute('aria-label')||''))).map(b => b.textContent.trim()),
      title: document.title,
    }));
    console.log('导航/出口:', JSON.stringify(nav, null, 1));

    // 3. 每个 section 的截图
    for (const s of structure.sections) {
      if (s.id === '(no id)' || s.h <= 1) continue;
      const el = page.locator(`section`).filter({ hasText: s.title }).first();
      if (await el.count()) {
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await el.screenshot({ path: join(OUT_DIR, `sec-${s.title}.png`) }).catch(() => {});
      }
    }

    // 4. 切换一个开关，看有没有反馈
    const sw2 = page.locator('input[type="checkbox"]').first();
    if (await sw2.count()) {
      const before = await sw2.isChecked();
      await sw2.click({ force: true });
      await page.waitForTimeout(1200);
      const after = await sw2.isChecked();
      console.log(`开关切换: ${before} → ${after}`);
      const feedback = await page.evaluate(() => {
        const t = document.querySelector('[role="status"], [role="alert"]');
        return t ? t.textContent.trim().slice(0, 120) : null;
      });
      console.log('切换后反馈:', feedback);
      await page.screenshot({ path: join(OUT_DIR, '02-toggle.png') });
    }

    // 5. 所有开关的 label 关联
    const labels = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('input[type="checkbox"], [role="switch"]').forEach(i => {
        const lab = i.id ? document.querySelector(`label[for="${i.id}"]`) : null;
        const wrapLab = i.closest('label');
        const text = (lab?.textContent || wrapLab?.textContent || i.getAttribute('aria-label') || '').trim();
        out.push({ id: i.id || '(no id)', hasLabel: !!(lab || wrapLab), text: text.slice(0, 40) });
      });
      return out;
    });
    console.log('开关 label 关联:', JSON.stringify(labels, null, 1));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
