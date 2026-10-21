// 产品负责人亲自巡检 —— 按 Chrome popup 的**真实尺寸**看产品。
//
// 为什么不用 scripts/ui-audit-screenshots.mjs：那个脚本开 1280×800，而真实 popup
// 只有 400×600。1280 宽下好看的布局在 400 宽下可能是灾难（2026-10-19 的 P0 就是
// 这么漏的：搜索框在 400px 下宽 0）。这个脚本按真实尺寸拍。
//
// 用法：pnpm build 之后 `node scripts/prod-inspect.mjs [场景]`
// 产物：outputs/prod-inspect/*.png

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-inspect');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const POPUP = { width: 400, height: 600 };

function tab(groupId, url, title, ageHours) {
  const domain = new URL(url).hostname;
  return {
    id: crypto.randomUUID(),
    url,
    title,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    createdAt: iso(now - ageHours * 3600e3),
    lastAccessed: iso(now - ageHours * 3600e3),
    group_id: groupId,
    pinned: false,
  };
}

function group(name, { notes, favorite = false, locked = false, order, ageHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes,
    isFavorite: favorite,
    isLocked: locked,
    isDeleted: false,
    tabs: tabs.map(([url, title, age]) => tab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1,
    displayOrder: order,
    lastOp: { d: 'demo-device', s: order },
  };
}

const groups = [
  group('V2 同步架构评审', {
    notes: 'P1 对账观察期结论周五同步；重点看墓碑 sweep 接线方案',
    favorite: true,
    order: 1,
    ageHours: 2,
    tabs: [
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-pano/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://github.com/hibernate-pano/chrome-plugin-one-tab/actions', 'Actions · chrome-plugin-one-tab', 5],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News', 8],
    ],
  }),
  group('React 19 升级 PR', {
    order: 2,
    ageHours: 6,
    tabs: [
      ['https://github.com/facebook/react/releases', 'React Releases · facebook/react'],
      ['https://react.dev/reference/react/useActionState', 'useActionState – React'],
    ],
  }),
  group('Go 官方文档深潜', {
    order: 3,
    ageHours: 26,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
    ],
  }),
  group('面试准备（进行中）', {
    notes: '周五下午 3 点，二面。系统设计 + 同步协议',
    locked: true,
    order: 4,
    ageHours: 40,
    tabs: [
      ['https://github.com/donnemartin/system-design-primer', 'donnemartin/system-design-primer: Learn how to design large-scale systems'],
      ['https://martinfowler.com/articles/patterns-of-distributed-systems/', 'Patterns of Distributed Systems', 60],
    ],
  }),
  group('周报素材收集', {
    order: 5,
    ageHours: 52,
    tabs: [
      ['https://news.ycombinator.com/news', 'Hacker News'],
      ['https://www.v2ex.com/t/1080000', '大家都在用什么管理浏览器标签页？ - V2EX', 70],
    ],
  }),
];

async function injectGroups(page, data) {
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

async function newPage(ctx, id, viewport = POPUP) {
  const page = await ctx.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  const skip = page.locator('button[aria-label="跳过引导"]');
  await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
  await page.waitForTimeout(600);
  return page;
}

/** 量一量关键元素在真实尺寸下的几何 */
async function measure(page) {
  return page.evaluate(() => {
    const pick = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      docScrollH: document.documentElement.scrollHeight,
      headerSearch: pick('.app-header-search'),
      searchInput: pick('.search-input'),
      headerActions: pick('.app-header-actions'),
      headerBrand: pick('.app-header-brand'),
      body: pick('.app-body'),
      main: pick('main'),
      cards: [...document.querySelectorAll('.tab-group, [class*="tab-group"]')].slice(0, 3).map(el => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) };
      }),
      // 横向溢出检测：找出右边界超出视口的元素
      overflowers: [...document.querySelectorAll('*')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > document.documentElement.clientWidth + 1;
        })
        .slice(0, 12)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 70),
          right: Math.round(el.getBoundingClientRect().right),
          w: Math.round(el.getBoundingClientRect().width),
        })),
    };
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-prod-inspect-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  const report = {};
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('未找到 service worker');
    const id = new URL(sw.url()).host;
    console.log('扩展 ID:', id);

    // ── 1. 真实 popup 尺寸的满列表 ──
    const page = await newPage(ctx, id);
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT_DIR, '01-popup-400-full.png') });
    report.popup = await measure(page);
    console.log('① 真实 popup 尺寸几何:', JSON.stringify(report.popup, null, 1));

    // ── 2. 头部区域单独放大 ──
    const header = await page.locator('header, .app-header').first();
    if (await header.count()) {
      await header.screenshot({ path: join(OUT_DIR, '02-header-400.png') }).catch(() => {});
    }

    // ── 3. 会话卡头（图标区占比）──
    const cardHead = page.locator('.tab-group-header, [class*="group-header"]').first();
    if (await cardHead.count()) {
      await cardHead.screenshot({ path: join(OUT_DIR, '03-card-header-400.png') }).catch(() => {});
    }

    // ── 4. 菜单展开 ──
    await page.click('button[aria-label="菜单"]').catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, '04-menu-400.png') });
    report.menu = await measure(page);
    console.log('④ 菜单展开后几何:', JSON.stringify(report.menu?.overflowers, null, 1));
    await page.keyboard.press('Escape').catch(() => {});

    // ── 5. 搜索态 ──
    const search = page.locator('input[type="text"], input[placeholder*="搜索"]').first();
    await search.click();
    await search.fill('React');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT_DIR, '05-search-400.png') });
    await search.fill('');
    await page.waitForTimeout(500);

    // ── 6. 空态 ──
    await page.evaluate(async () => {
      await new Promise((res, rej) => {
        const req = indexedDB.open('tabvaultpro', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'tab_groups', value: [] });
          tx.oncomplete = () => { db.close(); res(); };
          tx.onerror = () => { db.close(); rej(tx.error); };
        };
      });
    });
    const page3 = await newPage(ctx, id);
    await page3.waitForSelector('text=先保存一个工作会话', { timeout: 15000 }).catch(() => {});
    await page3.waitForTimeout(800);
    await page3.screenshot({ path: join(OUT_DIR, '06-empty-400.png') });
    report.empty = await measure(page3);
    console.log('⑥ 空态几何:', JSON.stringify({ ...report.empty, overflowers: report.empty?.overflowers }, null, 1));

    // ── 7. 设置页（真实宽度 1280，但首屏可视）──
    const opt = await ctx.newPage();
    await opt.setViewportSize({ width: 1280, height: 800 });
    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt.waitForTimeout(1500);
    await opt.screenshot({ path: join(OUT_DIR, '07-options-1280.png') });
    report.options = await opt.evaluate(() => {
      const sections = [...document.querySelectorAll('h2, h3, [class*="section-title"]')].map(e => ({
        text: (e.textContent || '').trim().slice(0, 30),
        y: Math.round(e.getBoundingClientRect().y),
      }));
      return { docScrollH: document.documentElement.scrollHeight, sections };
    });
    console.log('⑦ 设置页:', JSON.stringify(report.options, null, 1));

    // 设置页首屏内可见的交互元素数量（首屏能不能干完事）
    report.options.aboveFold = await opt.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, input, select, [role="tab"], [role="switch"]')];
      const visible = els.filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= 800;
      });
      return visible.length;
    });
    console.log('   设置页首屏可见交互元素数:', report.options.aboveFold);
  } finally {
    await ctx.close();
  }
  console.log('\n=== REPORT ===\n' + JSON.stringify(report, null, 1));
}

main().catch(err => { console.error(err); process.exit(1); });
