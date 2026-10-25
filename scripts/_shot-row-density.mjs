/**
 * 收紧前后的整页对照图（浅色 / 深色 / 窄屏）。
 *
 * 用法：pnpm build 之后 node scripts/_shot-row-density.mjs
 * 产物：outputs/row-density/page-{theme}-{mode}.png
 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/row-density');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title) {
  return {
    id: crypto.randomUUID(), url, title, favicon: '',
    createdAt: iso(now - 3600e3), lastAccessed: iso(now - 3600e3),
    group_id: groupId, pinned: false,
  };
}

function group(name, { order, locked = false, tabs }) {
  const id = crypto.randomUUID();
  return {
    id, name, notes: '', isFavorite: false, isLocked: locked, isDeleted: false,
    tabs: tabs.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - 3600e3), updatedAt: iso(now - 1800e3),
    version: 1, displayOrder: order, lastOp: { d: 'shot', s: order },
  };
}

const groups = [
  group('工作台 · 同步架构评审', {
    order: 1,
    tabs: [
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-pano/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News'],
      ['https://developer.mozilla.org/en-US/docs/Web/API/Storage_API', 'Storage API - Web APIs | MDN'],
      ['https://www.figma.com/file/abc123/One-Tab-Redesign', 'One Tab Redesign — Figma'],
    ],
  }),
  group('调研 · Go 并发模型', {
    order: 2,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
      ['https://react.dev/reference/react/useMemo', 'useMemo – React'],
      ['https://vite.dev/guide/', 'Vite Guide'],
    ],
  }),
  group('已归档（锁定）· 面试准备', {
    order: 3,
    locked: true,
    tabs: [
      ['https://leetcode.com/problemset/', 'LeetCode Problemset'],
      ['https://interviewing.io/recording', 'Interviewing.io — recordings'],
      ['https://www.pramp.com/', 'Pramp'],
    ],
  }),
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-shot-'));
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
    const id = new URL(sw.url()).host;

    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${id}/src/popup/index.html`);
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

    for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      await page.goto(`chrome-extension://${id}/src/popup/index.html`);
      const skip = page.locator('button[aria-label="跳过引导"]');
      await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
      await page.waitForSelector('text=工作台 · 同步架构评审', { timeout: 15000 });
      await page.mouse.move(2, 2);
      await page.waitForTimeout(900);

      for (const [theme, dark] of [['legacy', false], ['claude', true]]) {
        await page.evaluate(([t, d]) => {
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.toggle('dark', d);
        }, [theme, dark]);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT_DIR, `page-${theme}-${dark ? 'dark' : 'light'}-${vp.name}.png`), fullPage: false });
      }
      await page.close();
    }
    console.log('✅ 截图完成');
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
