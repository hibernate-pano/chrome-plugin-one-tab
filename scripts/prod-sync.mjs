// 未登录用户点同步按钮会发生什么 —— 新用户最常撞上的路径。
// 用法：pnpm build 之后 `node scripts/prod-sync.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-sync');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-sync-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 600 });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1500);

    // 未登录时同步按钮的状态
    const syncState = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => {
        const l = b.getAttribute('aria-label') || '';
        return l.includes('上传') || l.includes('下载');
      });
      return btns.map(b => ({
        label: b.getAttribute('aria-label'),
        disabled: b.disabled,
        title: b.title,
        opacity: getComputedStyle(b).opacity,
        cursor: getComputedStyle(b).cursor,
        cls: b.className.slice(0, 60),
      }));
    });
    console.log('未登录时同步按钮:', JSON.stringify(syncState, null, 1));

    // 点一下上传，看发生什么
    const up = page.locator('button[aria-label="上传本地会话到云端"]');
    if (await up.count()) {
      await up.click({ timeout: 5000 }).catch(e => console.log('点击失败:', e.message.split('\n')[0]));
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(OUT_DIR, '01-click-upload.png') });
      const after = await page.evaluate(() => ({
        modalOpen: !!document.querySelector('[role="dialog"]'),
        modalText: document.querySelector('[role="dialog"]')?.textContent?.trim().slice(0, 200),
        toast: document.querySelector('[role="alert"], [role="status"]')?.textContent?.trim().slice(0, 200),
        bodyText: document.body.textContent?.includes('登录'),
      }));
      console.log('点上传后:', JSON.stringify(after, null, 1));
    }

    // 菜单里同步相关的项
    await page.click('button[aria-label="菜单"]');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, '02-menu.png') });
    const menuText = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]');
      return m ? m.textContent.trim() : null;
    });
    console.log('菜单内容:', menuText);

    // 顶栏空间占用
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const header = await page.evaluate(() => {
      const actions = document.querySelector('.app-header-actions');
      const search = document.querySelector('.app-header-search');
      const brand = document.querySelector('.app-header-brand');
      const syncBtns = [...document.querySelectorAll('button')].filter(b => {
        const l = b.getAttribute('aria-label') || '';
        return l.includes('上传') || l.includes('下载');
      });
      const r = e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; };
      return {
        viewport: document.documentElement.clientWidth,
        brand: r(brand), search: r(search), actions: r(actions),
        syncTotalW: syncBtns.reduce((s, b) => s + b.getBoundingClientRect().width, 0),
        actionsChildren: [...actions.children].map(c => ({
          cls: c.className.slice(0, 30),
          label: c.querySelector('button')?.getAttribute('aria-label') || c.textContent.trim().slice(0,10),
          w: Math.round(c.getBoundingClientRect().width),
        })),
      };
    });
    console.log('\n顶栏空间占用:', JSON.stringify(header, null, 1));

    // 主题切换按钮的 title/aria
    const themeBtn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('模式'));
      return b ? { label: b.getAttribute('aria-label'), title: b.title } : null;
    });
    console.log('主题按钮:', JSON.stringify(themeBtn));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
