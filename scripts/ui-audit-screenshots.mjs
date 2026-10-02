// UI 审计截图：覆盖扩展管理页的所有主要界面状态，供设计审查用。
// 复用 make-store-screenshots.mjs 的注入方式（e2e-helpers 踩坑结论：跳过引导走 React、
// 先开页面建 schema 再注入、独立临时 profile）。
//
// 用法：pnpm build 之后跑 `node scripts/ui-audit-screenshots.mjs`
// 产物：store-assets/ui-audit/*.png（1280×800 @2x）

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets/ui-audit');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

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

function group(name, { notes, favorite = false, locked = false, order, ageHours, tabs, isDeleted = false }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    notes,
    isFavorite: favorite,
    isLocked: locked,
    isDeleted,
    deletedAt: isDeleted ? iso(now - 3600e3) : undefined,
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
      ['https://react.dev/blog/react-19-upgrade-guide', 'Upgrading to React 19 – React Blog', 12],
      ['https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Frameworks_libraries/React_getting_started', 'Getting started with React - Learn web development | MDN', 20],
    ],
  }),
  group('Go 官方文档深潜', {
    order: 3,
    ageHours: 26,
    tabs: [
      ['https://go.dev/ref/mem', 'The Go Memory Model - The Go Programming Language'],
      ['https://pkg.go.dev/runtime', 'runtime package - runtime - pkg.go.dev'],
      ['https://go.dev/blog/race-detector', 'Introducing the Go Race Detector - The Go Blog', 30],
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
      ['https://juejin.cn/post/2026-react-ecosystem', '2026 前端年度报告：React 生态盘点 - 掘金', 90],
    ],
  }),
  // 墓碑组：验证回收站视图
  group('过期的旧调研', {
    isDeleted: true,
    order: 6,
    ageHours: 200,
    tabs: [
      ['https://example.com/old-research', '过期的调研资料'],
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

async function newPopupPage(ctx, id) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  const skip = page.locator('button[aria-label="跳过引导"]');
  await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
  await page.waitForTimeout(800);
  return page;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-ui-audit-'));
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
    if (!sw) throw new Error('15s 内未找到扩展 service worker');
    const id = new URL(sw.url()).host;

    // ── 带数据的页面 ──
    const page = await newPopupPage(ctx, id);
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page.waitForTimeout(1500);

    // 01 主界面
    await page.screenshot({ path: join(OUT_DIR, '01-main-light.png') });
    console.log('✅ 01-main-light');

    // 02 右上角菜单展开（用户点名的痛点）
    await page.click('button[aria-label="菜单"]');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT_DIR, '02-header-dropdown.png') });
    console.log('✅ 02-header-dropdown');

    // 03 菜单内滚动到底（如果内容溢出）
    const menuBox = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.fixed, [class*="dropdown"], [class*="menu"]')];
      const visible = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 100 && r.height > 100; });
      return visible.map(e => ({ cls: e.className.slice(0, 60), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, scrollH: e.scrollHeight }));
    });
    console.log('菜单容器探测:', JSON.stringify(menuBox));

    // ── 换新页面避免菜单残留 ──
    const page2 = await newPopupPage(ctx, id);
    await page2.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });

    // 04 搜索态
    const search = page2.locator('input[type="text"], input[placeholder*="搜索"]').first();
    await search.click();
    await search.fill('React');
    await page2.waitForTimeout(1000);
    await page2.screenshot({ path: join(OUT_DIR, '04-search.png') });
    console.log('✅ 04-search');

    // 05 确认弹窗（清理重复标签，点 header 垃圾桶按钮触发）
    await page2.keyboard.press('Escape');
    await page2.locator('input[type="text"], input[placeholder*="搜索"]').first().fill('');
    await page2.waitForTimeout(500);
    await page2.click('button[aria-label="清理重复标签页"]');
    await page2.waitForTimeout(600);
    await page2.screenshot({ path: join(OUT_DIR, '05-confirm-dialog.png') });
    console.log('✅ 05-confirm-dialog');

    // ── 空状态（清空本 profile 已注入的数据，拍真实空态）──
    // 旧写法直接新开一页拍：profile 里已经注入过演示数据，「空状态」截图其实是
    // 满列表，脚本还打印 ✅（假绿）。现在先写空存储，再等空态文案出现才拍；
    // 等不到就抛错，不留会说谎的截图。
    await page2.evaluate(async () => {
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
    const page3 = await newPopupPage(ctx, id);
    await page3.waitForSelector('text=先保存一个工作会话', { timeout: 15000 });
    await page3.screenshot({ path: join(OUT_DIR, '07-empty.png') });
    console.log('✅ 07-empty');
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
