// 主题收敛决策辅助截图：8 套主题 × 亮/暗 全量实拍主列表。
// 前置：pnpm build（dist 为最新）。
// 用法：node scripts/theme-tour-screenshots.mjs
// 产物：store-assets/ui-audit/themes/<style>-<mode>.png（1280×800 @2x）
// 注入方式复用 ui-audit-screenshots.mjs 的踩坑结论（先开页面建 schema 再注入、独立临时 profile）。

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'store-assets/ui-audit/themes');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

// 2026-09-28 主题收敛（8 → 4）后的保留清单
const THEMES = ['legacy', 'aurora', 'creamy', 'prism', 'apple', 'chrome', 'claude'];
const MODES = ['light', 'dark'];

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

// 与 ui-audit 同一套样例数据（收藏/备注/锁定/多龄期都在）
const groups = [
  group('V2 同步架构评审', {
    notes: 'P1 对账观察期结论周五同步；重点看墓碑 sweep 接线方案',
    favorite: true,
    order: 1,
    ageHours: 2,
    tabs: [
      ['https://github.com/hibernate-panbo/chrome-plugin-one-tab/pulls', 'Pull requests · hibernate-panbo/chrome-plugin-one-tab'],
      ['https://docs.google.com/document/d/1v2-plan-review/edit', 'V2 执行计划评审 — Google 文档'],
      ['https://news.ycombinator.com/item?id=39011223', 'CRDTs and the cost of consistency | Hacker News', 8],
    ],
  }),
  group('React 19 升级 PR', {
    order: 2,
    ageHours: 6,
    tabs: [
      ['https://github.com/facebook/react/releases', 'React Releases · facebook/react'],
      ['https://react.dev/reference/react/useActionState', 'useActionState – React'],
      ['https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Frameworks_libraries/React_getting_started', 'Getting started with React - Learn web development | MDN', 20],
    ],
  }),
  group('面试准备（进行中）', {
    notes: '周五下午 3 点，二面。系统设计 + 同步协议',
    locked: true,
    order: 3,
    ageHours: 40,
    tabs: [
      ['https://github.com/donnemartin/system-design-primer', 'donnemartin/system-design-primer: Learn how to design large-scale systems'],
      ['https://martinfowler.com/articles/patterns-of-distributed-systems/', 'Patterns of Distributed Systems', 60],
    ],
  }),
];

async function inject(page, { rows, settings }) {
  await page.evaluate(async ({ rows, settings }) => {
    await new Promise((res, rej) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onerror = () => rej(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: rows });
        tx.objectStore('kv').put({ key: 'user_settings', value: settings });
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      };
    });
  }, { rows, settings });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-theme-tour-'));
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

    for (const style of THEMES) {
      for (const mode of MODES) {
        // 每个组合独立页面 + 独立注入，避免前序状态残留
        const page = await ctx.newPage();
        await page.setViewportSize({ width: 1280, height: 800, deviceScaleFactor: 2 });
        await page.goto(`chrome-extension://${id}/src/popup/index.html`);
        const skip = page.locator('button[aria-label="跳过引导"]');
        await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
        await inject(page, {
          rows: groups,
          settings: { themeStyle: style, themeMode: mode },
        });
        await page.reload();
        await page.waitForSelector('text=V2 同步架构评审', { timeout: 15000 });
        await page.waitForTimeout(1200); // 主题过渡 250ms + 字体/favicon 稳定

        // 防串味：确认 DOM 上确实是我们拍的主题
        const applied = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          dark: document.documentElement.classList.contains('dark'),
        }));
        if (applied.theme !== style || (applied.dark !== (mode === 'dark'))) {
          throw new Error(`主题应用不符: 期望 ${style}/${mode} 实际 ${applied.theme}/${applied.dark ? 'dark' : 'light'}`);
        }

        await page.screenshot({ path: join(OUT_DIR, `${style}-${mode}.png`) });
        console.log(`✅ ${style}-${mode}`);
        await page.close();
      }
    }
  } finally {
    await ctx.close();
  }
  console.log(`\n完成：${THEMES.length * MODES.length} 张 → ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
