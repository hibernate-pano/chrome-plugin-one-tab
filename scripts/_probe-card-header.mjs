/**
 * 会话卡头（标签组那一行）的高度实测。
 *
 * 量的是：卡头盒高、上下 padding、**最高的那个子元素**是谁、
 * 以及各个子元素各自多高（按钮 / 徽章 / 时间 / 标题）。
 *
 * 用法：pnpm build 之后 node scripts/_probe-card-header.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
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
    ['https://news.ycombinator.com/item?id=1', 'CRDTs and the cost of consistency | Hacker News'],
  ].map(([url, title]) => tab(id, url, title)),
  createdAt: iso(now - 3600e3), updatedAt: iso(now - 1800e3),
  version: 1, displayOrder: 1, lastOp: { d: 'probe', s: 1 },
}];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-hdr-'));
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

    for (const width of [1280, 768, 390]) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
      const skip = page.locator('button[aria-label="跳过引导"]');
      await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
      await page.waitForSelector('text=工作台 · 同步架构评审', { timeout: 15000 });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(700);

      const report = await page.evaluate(() => {
        const header = document.querySelector('.tab-group-header');
        const cs = getComputedStyle(header);
        const kids = [...header.children].map(el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: el.className?.toString().slice(0, 60) ?? '',
            h: +r.height.toFixed(2),
            w: +r.width.toFixed(2),
          };
        });
        // 所有后代里最高的几个
        const all = [...header.querySelectorAll('*')].map(el => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: el.className?.toString().slice(0, 50) ?? '',
            h: +r.height.toFixed(2),
          };
        }).sort((a, b) => b.h - a.h).slice(0, 8);
        return {
          headerH: +header.getBoundingClientRect().height.toFixed(2),
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          minHeight: cs.minHeight,
          borderBottom: cs.borderBottomWidth,
          display: cs.display,
          alignItems: cs.alignItems,
          gap: cs.gap,
          kids,
          tallest: all,
        };
      });
      console.log(`\n=== viewport ${width} ===`);
      console.log(JSON.stringify(report, null, 2));
      await page.close();
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
