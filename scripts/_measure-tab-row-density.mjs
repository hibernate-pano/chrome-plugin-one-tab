/**
 * 标签行密度实测（只测量，不改代码）。
 *
 * 量的是**真机产物**（Chromium 加载 dist 的真实扩展）：
 *   · 每行的盒高 / 上下 padding / 下外边距 / 内容盒高 / 操作按钮高
 *   · 相邻两行的行距（行顶之差）
 *   · 同一张卡里「可删的行」与「锁定的行」的高度差
 *   · 6 套主题各自的行距（主题只靠 html[data-theme] 切换 ⇒ 直接改属性即可）
 *
 * 用法：pnpm build 之后 node scripts/_measure-tab-row-density.mjs
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
    id: crypto.randomUUID(),
    url,
    title,
    favicon: '',
    createdAt: iso(now - 3600e3),
    lastAccessed: iso(now - 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, { order, locked = false, tabs }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes: '',
    isFavorite: false,
    isLocked: locked,
    isDeleted: false,
    tabs: tabs.map(([url, title]) => tab(id, url, title)),
    createdAt: iso(now - 3600e3),
    updatedAt: iso(now - 1800e3),
    version: 1,
    displayOrder: order,
    lastOp: { d: 'measure', s: order },
  };
}

const groups = [
  group('未锁定会话（5 个标签）', {
    order: 1,
    tabs: [
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-pano/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News'],
      ['https://developer.mozilla.org/en-US/docs/Web/API/Storage_API', 'Storage API - Web APIs | MDN'],
      ['https://www.figma.com/file/abc123/One-Tab-Redesign', 'One Tab Redesign — Figma'],
    ],
  }),
  group('锁定会话（5 个标签）', {
    order: 2,
    locked: true,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
      ['https://react.dev/reference/react/useMemo', 'useMemo – React'],
      ['https://vite.dev/guide/', 'Vite Guide'],
      ['https://tailwindcss.com/docs', 'Tailwind CSS Documentation'],
    ],
  }),
];

const THEMES = ['legacy', 'creamy', 'prism', 'apple', 'chrome', 'claude'];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-density-'));
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

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForSelector('text=未锁定会话（5 个标签）', { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(800);

    const report = {};

    for (const theme of THEMES) {
      await page.evaluate(t => { document.documentElement.setAttribute('data-theme', t); }, theme);
      await page.waitForTimeout(400);

      const data = await page.evaluate(() => {
        const measure = (container) => {
          const rows = [...container.querySelectorAll('.tab-item')];
          if (!rows.length) return null;
          const rects = rows.map(r => r.getBoundingClientRect());
          const cs = getComputedStyle(rows[0]);
          const btn = rows[0].querySelector('.tab-item-actions button');
          const btnRect = btn ? btn.getBoundingClientRect() : null;
          const title = rows[0].querySelector('.tab-item-title');
          const titleRect = title ? title.getBoundingClientRect() : null;
          const contentH = Math.max(
            ...rows.map(r => {
              const kids = [...r.children].map(c => c.getBoundingClientRect().height);
              return kids.length ? Math.max(...kids) : 0;
            })
          );
          return {
            rowBox: +rects[0].height.toFixed(2),
            stride: +(rects[1].top - rects[0].top).toFixed(2),
            paddingTop: cs.paddingTop,
            paddingBottom: cs.paddingBottom,
            marginBottom: cs.marginBottom,
            marginTop: cs.marginTop,
            borderTop: cs.borderTopWidth,
            borderBottom: cs.borderBottomWidth,
            minHeight: cs.minHeight,
            maxChildH: +contentH.toFixed(2),
            btnH: btnRect ? +btnRect.height.toFixed(2) : null,
            titleH: titleRect ? +titleRect.height.toFixed(2) : null,
            containerH: +container.getBoundingClientRect().height.toFixed(2),
          };
        };
        const cards = [...document.querySelectorAll('.tab-group-card')];
        const out = {};
        for (const card of cards) {
          const name = card.querySelector('.tab-group-title')?.textContent?.trim() ?? '?';
          const container = card.querySelector('.tab-group-tabs-container');
          if (container) out[name] = measure(container);
          // 卡片级几何：卡头高 / 轨道高 / 整卡高（cardMetrics 的三个数）
          const header = card.querySelector('.tab-group-header');
          const track = container?.parentElement?.parentElement; // grid 1fr 轨道
          out[name].cardBox = +card.getBoundingClientRect().height.toFixed(2);
          out[name].headerH = header ? +header.getBoundingClientRect().height.toFixed(2) : null;
          out[name].trackH = track ? +track.getBoundingClientRect().height.toFixed(2) : null;
        }
        return out;
      });

      report[theme] = data;
      const card = page.locator('.tab-group-card').first();
      await card.screenshot({ path: join(OUT_DIR, `card-${theme}.png`) }).catch(() => {});
    }

    console.log(JSON.stringify(report, null, 2));
    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
