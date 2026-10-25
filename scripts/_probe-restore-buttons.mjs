/**
 * 真机看「在当前窗口打开」/「在新窗口恢复」这两颗按钮：
 * 位置、图标形状、以及窄屏的「更多」菜单。
 *
 * 用法：pnpm build 之后 node scripts/_probe-restore-buttons.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-restore-buttons';   // 探针产物别落进 store-assets（那是提交商店的素材目录）
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(), url, title, favicon: '',
    createdAt: iso(now - 3600e3), lastAccessed: iso(now - 3600e3),
    group_id: groupId, pinned: false,
  };
}

const id = crypto.randomUUID();
const groups = [{
  id, name: '工作台 · 同步架构评审', notes: '', isFavorite: false, isLocked: false, isDeleted: false,
  tabs: [
    ['https://github.com/a/b/pulls', 'Pull requests · a/b'],
    ['https://docs.google.com/document/d/1/edit', 'V2 执行计划评审 — Google 文档'],
  ].map(([url, title]) => tab(id, url, title)),
  createdAt: iso(now - 3600e3), updatedAt: iso(now - 1800e3),
  version: 1, displayOrder: 1, lastOp: { probe: 'probe', s: 1 },
}];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-restore-'));
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
    if (!sw) throw new Error('15s 内未找到 service worker');
    const extId = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await seed.evaluate(async rows => {
      await new Promise((res, rej) => {
        const req = indexedDB.open('tabvaultpro', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
          tx.oncomplete = () => { db.close(); res(); };
          tx.onerror = () => { db.close(); rej(req.error); };
        };
      });
    }, groups);
    await seed.close();

    // ── 宽屏：两颗按钮都在卡头上 ──────────────────────────────────────────
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForSelector('text=工作台 · 同步架构评审', { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600);

    const header = page.locator('.tab-group-header').first();
    await header.screenshot({ path: `${OUT}-wide.png` });

    const buttons = await page.evaluate(() => {
      const head = document.querySelector('.tab-group-header');
      return [...head.querySelectorAll('button')].map(b => {
        const r = b.getBoundingClientRect();
        return {
          aria: b.getAttribute('aria-label'),
          x: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
          accent: b.className.includes('tab-group-action-accent'),
          paths: b.querySelectorAll('path').length,
        };
      });
    });
    console.log('宽屏卡头按钮（按 DOM 序 = 按视觉序）:');
    console.log(JSON.stringify(buttons, null, 2));

    // ── 窄屏：主操作常驻，次操作收进「更多」 ──────────────────────────────
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(600);
    await header.screenshot({ path: `${OUT}-narrow.png` });
    const narrowButtons = await page.evaluate(() => {
      const head = document.querySelector('.tab-group-header');
      return [...head.querySelectorAll('button')]
        .filter(b => b.getBoundingClientRect().width > 0)
        .map(b => ({ aria: b.getAttribute('aria-label'), accent: b.className.includes('tab-group-action-accent') }));
    });
    console.log('\n窄屏卡头可见按钮:');
    console.log(JSON.stringify(narrowButtons, null, 2));

    const more = page.locator('summary[aria-haspopup="menu"]').first();
    await more.click();
    await page.waitForTimeout(500);
    const panel = page.locator('[role="menu"]').first();
    await panel.screenshot({ path: `${OUT}-narrow-menu.png` });
    const menuItems = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map(i => i.textContent.trim()));
    console.log('\n窄屏「更多」菜单项:');
    console.log(JSON.stringify(menuItems, null, 2));

    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
