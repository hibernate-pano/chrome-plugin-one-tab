// 负责人亲自巡检 —— 按**真实标签页宽度**（不是 400px popup）看产品。
//
// 与 scripts/prod-inspect.mjs 的区别：那���按 popup 尺寸拍，
// 但 manifest.json 里 action 没有 default_popup ⇒ 用户看到的是**普通标签页**，
// 宽度由浏览器窗口决定（1280/1440/1920 都常见）。
// 这个脚本按真实宽度拍，并抓交互态。
//
// 用法：pnpm build 之后 `node scripts/lead-inspect.mjs`
// 产物：outputs/lead-inspect/*.png

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/lead-inspect');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

const DESK = { width: 1440, height: 900 };
const NARROW = { width: 1024, height: 768 };

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

// 一批**真实感的**会话：长标题、长域名、混合站点、混合时长
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
      ['https://github.com/facebook/react/pull/28768', 'Upgrading to React 19 – React Blog'],
    ],
  }),
  group('Go 官方文档深潜', {
    order: 3,
    ageHours: 26,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
      ['https://go.dev/blog/maps', 'Go maps - Go 1.25 Release Notes'],
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

async function newPage(ctx, id, viewport) {
  const page = await ctx.newPage();
  await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  const skip = page.locator('button[aria-label="跳过引导"]');
  await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
  await page.waitForTimeout(600);
  return page;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-lead-'));
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

    // ── 1. 真实标签页宽度下的满列表 ──
    const page = await newPage(ctx, id, DESK);
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT_DIR, '01-desk-full.png'), fullPage: true });

    // 顶栏几何：谁最重
    report.header = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('header button, .app-header button')];
      return btns.map(b => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return {
          label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24),
          w: Math.round(r.width),
          h: Math.round(r.height),
          bg: cs.backgroundColor,
          color: cs.color,
          fontWeight: cs.fontWeight,
        };
      });
    });
    console.log('① 顶栏按钮:', JSON.stringify(report.header, null, 1));

    // 横向占用：1280 宽下顶栏浪费
    report.headerGeom = await page.evaluate(() => {
      const h = document.querySelector('header, .app-header');
      const brand = document.querySelector('.app-header-brand');
      const search = document.querySelector('.app-header-search');
      const actions = document.querySelector('.app-header-actions');
      const pick = el => el ? (r => ({ x: Math.round(r.x), w: Math.round(r.width) }))(el.getBoundingClientRect()) : null;
      return {
        headerW: h ? Math.round(h.getBoundingClientRect().width) : null,
        brand: pick(brand),
        search: pick(search),
        actions: pick(actions),
        docClientW: document.documentElement.clientWidth,
      };
    });
    console.log('① 顶栏几何:', JSON.stringify(report.headerGeom, null, 1));

    // ── 2. 会话卡头部（图标区）──
    const cardHead = page.locator('[class*="group-header"], .tab-group-header').first();
    if (await cardHead.count()) {
      await cardHead.screenshot({ path: join(OUT_DIR, '02-card-header.png') }).catch(() => {});
    }
    report.cardHeader = await page.evaluate(() => {
      const head = document.querySelector('[class*="group-header"], .tab-group-header');
      if (!head) return null;
      return {
        text: head.innerText.replace(/\n/g, ' | ').slice(0, 120),
        buttons: [...head.querySelectorAll('button')].map(b => ({
          aria: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          html: b.innerHTML.replace(/\s+/g, ' ').slice(0, 60),
        })),
      };
    });
    console.log('② 会话卡头:', JSON.stringify(report.cardHeader, null, 1));

    // ── 3. 悬停态（图标有没有 tooltip 之外的可见反馈）──
    const firstIcon = page.locator('[class*="group-header"] button, .tab-group-header button').first();
    if (await firstIcon.count()) {
      await firstIcon.hover();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT_DIR, '03-hover-icon.png') }).catch(() => {});
    }

    // ── 4. 顶栏菜单展开 ──
    await page.locator('button[aria-label="菜单"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, '04-menu.png') });
    report.menu = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"], [class*="dropdown"]');
      if (!m) return null;
      const items = [...m.querySelectorAll('button, a')].map(i => (i.innerText || i.getAttribute('aria-label') || '').trim().slice(0, 40));
      return { items, rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(m.getBoundingClientRect()) };
    });
    console.log('④ 菜单:', JSON.stringify(report.menu, null, 1));
    await page.keyboard.press('Escape').catch(() => {});

    // ── 5. 搜索 + 筛选面板展开（看列表被推走多少）──
    const search = page.locator('input[type="text"], input[placeholder*="搜索"]').first();
    await search.click();
    await search.fill('React');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT_DIR, '05-search.png') });

    await search.fill('');
    await page.waitForTimeout(400);
    const filterToggle = page.locator('text=显示筛选').first();
    if (await filterToggle.count()) {
      await filterToggle.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(OUT_DIR, '06-filter-open.png') });
      report.filterCost = await page.evaluate(() => {
        const panel = [...document.querySelectorAll('div')].find(d => d.innerText && d.innerText.includes('保存时间') && d.innerText.includes('域名') && d.getBoundingClientRect().height < 400);
        const firstCard = document.querySelector('[class*="tab-group"], .tab-group');
        if (!panel || !firstCard) return null;
        return {
          panelH: Math.round(panel.getBoundingClientRect().height),
          firstCardY: Math.round(firstCard.getBoundingClientRect().y),
          viewportH: document.documentElement.clientHeight,
        };
      });
      console.log('⑥ 筛选面板代价:', JSON.stringify(report.filterCost));
    }

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
    await page.reload();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(OUT_DIR, '07-empty.png') });

    // ── 7. 窄一点的窗口（1024，常见笔记本）──
    const page2 = await newPage(ctx, id, NARROW);
    await injectGroups(page2, groups);
    await page2.reload();
    await page2.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page2.waitForTimeout(1200);
    await page2.screenshot({ path: join(OUT_DIR, '08-narrow-1024.png') });

    // ── 8. 设置页 ──
    const opt = await ctx.newPage();
    await opt.setViewportSize(DESK);
    await opt.goto(`chrome-extension://${id}/src/options/index.html`);
    await opt.waitForTimeout(2500);
    await opt.screenshot({ path: join(OUT_DIR, '09-options.png'), fullPage: true });

    console.log('\n=== REPORT ===');
    console.log(JSON.stringify(report, null, 1));
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
