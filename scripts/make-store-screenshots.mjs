// 商店截图生成器：加载 dist 扩展 → 注入演示会话 → 截 1280×800 商店图。
//
// ⚠️ 约定（复用 e2e-helpers 的踩坑结论）：
// 1. 引导遮罩必须点「跳过引导」让 React 自己收，绝不 el.remove()（React patch 会炸成错误边界）。
// 2. 数据真相源是 IndexedDB tabvaultpro / kv（keyPath='key'）/ tab_groups，先开一次页面让 app 建
//    schema，再注入，再 reload —— 顺序反了会自己建出缺列的 store。
// 3. 用独立临时 profile，不碰开发者本机的浏览器数据。
//
// 用法：pnpm build 之后跑 `node scripts/make-store-screenshots.mjs`
// 产物：store-assets/screenshot-1-main.png / screenshot-2-search.png（CWS 要求 1280×800）

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets');
const VIEWPORT = { width: 1280, height: 800 };

const now = Date.now();
const iso = ms => new Date(ms).toISOString();

/** 造一组演示标签（favicon 走 Google s2 服务，SafeFavicon 白名单只放行 https，够用） */
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

function group(name, { locked = false, order, ageHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    isLocked: locked,
    tabs: tabs.map(([url, title, age]) => tab(id, url, title, age ?? ageHours)),
    createdAt: iso(now - ageHours * 3600e3),
    updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    isDeleted: false,
    version: 1,
    displayOrder: order,
    lastOp: { d: 'demo-device', s: order },
  };
}

// 演示数据定位：产品目标用户（重度浏览器使用者）的真实一天。
// 1.22.13 起「收藏」与「会话备注」已下线（负责人决定：非核心功能做减法），
// 演示数据里不再注入这两项——否则重拍的商店截图会出现已不存在的 UI。
const groups = [
  group('V2 同步架构评审', {
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
    locked: true,
    order: 4,
    ageHours: 40,
    tabs: [
      ['https://github.com/system-design-primer', 'donnemartin/system-design-primer: Learn how to design large-scale systems'],
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
];

/** 往扩展 IDB 写 tab_groups（schema 由 app 首次打开时建好） */
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

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-shot-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });

  try {
    // SW 是异步注册的，轮询等它出现（冷启动可能要几秒）
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) {
      sw = ctx.serviceWorkers()[0] ?? null;
      if (!sw) await new Promise(r => setTimeout(r, 500));
    }
    if (!sw) throw new Error('15s 内未找到扩展 service worker');
    const id = new URL(sw.url()).host;
    const popupUrl = `chrome-extension://${id}/src/popup/index.html`;

    // 第一开：让 app 建 schema / 弹引导；点「跳过引导」让 React 自己收遮罩
    const page = await ctx.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(popupUrl);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForTimeout(1000);

    // 注入演示数据 → reload → 等组卡片渲染
    await injectGroups(page, groups);
    await page.reload();
    await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
    await page.waitForTimeout(1500); // 等 favicon / 布局稳定

    await page.screenshot({ path: join(OUT_DIR, 'screenshot-1-main.png') });
    console.log('✅ screenshot-1-main.png');

    // 第二张：搜索过滤态 —— 搜「React」让标题/URL 命中高亮
    const search = page.locator('input[type="text"], input[placeholder*="搜索"]').first();
    await search.click();
    await search.fill('React');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT_DIR, 'screenshot-2-search.png') });
    console.log('✅ screenshot-2-search.png');
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
