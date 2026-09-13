// 用真实扩展产物生成 Chrome Web Store 截图。
// 运行前：pnpm build
// 输出：store-assets/*.png

import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'store-assets');
const NOW = new Date().toISOString();

function tab(id, title, url, index) {
  return {
    id,
    title,
    url,
    favicon: '',
    createdAt: NOW,
    lastAccessed: new Date(Date.now() - index * 60_000).toISOString(),
    pinned: false,
  };
}

const groups = [
  {
    id: 'store-github',
    name: 'GitHub 发布检查',
    notes: '上线前逐项确认：CI、权限、隐私政策和版本包',
    isFavorite: true,
    isLocked: true,
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    updatedAt: NOW,
    lastOp: { d: 'device_store_demo', s: 8 },
    tabs: [
      tab('store-t1', 'chrome-plugin-one-tab · Pull requests', 'https://github.com/hibernate-pano/chrome-plugin-one-tab/pulls', 1),
      tab('store-t2', 'Chrome Web Store Developer Dashboard', 'https://chrome.google.com/webstore/devconsole', 2),
      tab('store-t3', 'Supabase project overview', 'https://supabase.com/dashboard/project/_/editor', 3),
      tab('store-t4', 'Release checklist', 'https://github.com/hibernate-pano/chrome-plugin-one-tab/issues', 4),
    ],
  },
  {
    id: 'store-product',
    name: '产品研究与竞品',
    notes: '整理标签页管理场景和用户反馈',
    isFavorite: false,
    isLocked: false,
    createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    lastOp: { d: 'device_store_demo', s: 7 },
    tabs: [
      tab('store-t5', 'Session management patterns', 'https://www.nngroup.com/articles/', 5),
      tab('store-t6', 'Browser extension UX guidelines', 'https://developer.chrome.com/docs/extensions/', 6),
      tab('store-t7', 'User interviews notes', 'https://notion.so/', 7),
      tab('store-t8', 'Analytics dashboard', 'https://vercel.com/dashboard', 8),
      tab('store-t9', 'Design references', 'https://dribbble.com/', 9),
    ],
  },
  {
    id: 'store-customer',
    name: '客户反馈与迭代',
    notes: '本周优先处理同步失败和导入体验反馈',
    isFavorite: true,
    isLocked: false,
    createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    lastOp: { d: 'device_store_demo', s: 6 },
    tabs: [
      tab('store-t10', '反馈看板', 'https://linear.app/', 10),
      tab('store-t11', '用户邮件', 'https://mail.google.com/', 11),
      tab('store-t12', '版本迭代计划', 'https://www.notion.so/', 12),
    ],
  },
  {
    id: 'store-reading',
    name: '周末阅读',
    notes: '稍后读',
    isFavorite: false,
    isLocked: false,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    lastOp: { d: 'device_store_demo', s: 5 },
    tabs: [
      tab('store-t13', 'The pragmatic engineer', 'https://newsletter.pragmaticengineer.com/', 13),
      tab('store-t14', 'Web platform news', 'https://web.dev/', 14),
    ],
  },
];

async function seedGroups(page) {
  await page.evaluate(async (seed) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('tabvaultpro', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        store.put({ key: 'storage_version', value: 5 });
        store.put({ key: 'tab_groups', value: seed });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    await chrome.storage.local.set({
      onboarding_state: {
        hasCompletedOnboarding: true,
        lastOnboardingVersion: chrome.runtime.getManifest().version,
        completedAt: new Date().toISOString(),
      },
    });
  }, groups);
}

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'tapstack-store-assets-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  await seedGroups(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-group-card', { timeout: 20_000 });
  await page.addStyleTag({ content: '* { animation-duration: 0s !important; transition: none !important; }' });
  await page.screenshot({
    path: join(OUT, 'tapstack-main-1280x800.png'),
    fullPage: false,
  });

  const search = page.locator('input[aria-label="搜索会话、备注或标签页"]').first();
  await search.fill('GitHub');
  await page.waitForTimeout(500);
  await page.screenshot({
    path: join(OUT, 'tapstack-search-1280x800.png'),
    fullPage: false,
  });

  const promo = await context.newPage();
  await promo.setViewportSize({ width: 440, height: 280 });
  const icon = readFileSync(join(ROOT, 'icons/icon128.png')).toString('base64');
  await promo.setContent(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; width: 440px; height: 280px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7ff; color: #172033; }
          main { height: 100%; padding: 30px; display: flex; align-items: center; gap: 24px; }
          .icon { width: 96px; height: 96px; border-radius: 24px; box-shadow: 0 14px 32px rgba(49, 83, 206, .22); }
          h1 { margin: 0 0 8px; font-size: 34px; letter-spacing: 0; }
          p { margin: 0; max-width: 250px; font-size: 17px; line-height: 1.45; color: #4a5878; }
          .accent { margin-top: 16px; display: inline-block; padding: 6px 10px; border-radius: 999px; color: #2446ba; background: #e4eaff; font-size: 13px; font-weight: 700; }
        </style>
      </head>
      <body>
        <main>
          <img class="icon" src="data:image/png;base64,${icon}" alt="">
          <section>
            <h1>TapStack</h1>
            <p>保存工作现场，随时恢复整个浏览器会话。</p>
            <span class="accent">本地优先 · 跨设备找回</span>
          </section>
        </main>
      </body>
    </html>
  `);
  await promo.screenshot({ path: join(OUT, 'tapstack-promo-440x280.png') });
  console.log(`商店素材已生成：${OUT}`);
} finally {
  await context.close();
}
