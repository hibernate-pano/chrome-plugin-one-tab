/**
 * 响应式对照截图：同一份数据在桌面 / 平板 / 手机三档宽度下各拍一张，
 * 用于核对顶栏栅格、会话栅格、操作条显隐在窄屏是否退化。
 *
 * 用法：pnpm build 之后 node scripts/_shot-responsive.mjs
 * 产物：store-assets/ui-audit/resp-{desktop,tablet,mobile}.png
 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets/ui-audit');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function tab(groupId, url, title, ageHours) {
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    createdAt: iso(now - ageHours * 3600e3),
    lastAccessed: iso(now - ageHours * 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, { order, ageHours, locked = false, tabs }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: locked,
    isDeleted: false,
    tabs: tabs.map(([url, title, age]) => tab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1,
    displayOrder: order,
    lastOp: { d: 'shot', s: order },
  };
}

const groups = [
  group('V2 同步架构评审', {
    order: 1,
    ageHours: 2,
    tabs: [
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-pano/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News', 8],
    ],
  }),
  group('Go 官方文档深潜', {
    order: 2,
    ageHours: 26,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev', 30],
    ],
  }),
  group('面试准备（进行中）', {
    order: 3,
    ageHours: 40,
    locked: true,
    tabs: [
      ['https://github.com/donnemartin/system-design-primer', 'donnemartin/system-design-primer: Learn how to design large-scale systems'],
    ],
  }),
];

async function inject(page, data) {
  await page.evaluate(async rows => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, data);
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-resp-'));
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

    // 先在一页注入数据，后续各档复用同一个 profile 的 IndexedDB
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
          tx.onerror = () => { db.close(); rej(tx.error); };
        };
      });
    }, groups);
    await seed.close();

    for (const vp of VIEWPORTS) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      await page.goto(`chrome-extension://${id}/src/popup/index.html`);
      const skip = page.locator('button[aria-label="跳过引导"]');
      await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
      await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
      // 鼠标移开，避免 hover 态混进对照图
      await page.mouse.move(2, 2);
      await page.waitForTimeout(900);

      const file = join(OUT_DIR, `resp-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`✅ resp-${vp.name} (${vp.width}px)`);
      await page.close();
    }
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });