/**
 * 量一量双栏会话列表的**真实顺序**：
 *  · 默认键「最近保存」下，一个 90 天前的老会话排在第几？
 *  · 改成「最近活动」后，同一个老会话（但昨天被改过）排到第几？
 *  · 双栏的 DOM 序是不是就是排序序（左栏读完再读右栏）。
 *
 * 用法：pnpm build 之后 node scripts/_probe-sort-order.mjs
 */
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT = '/tmp/_probe-sort-order';
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const days = n => n * 86400e3;

/** 造一个会话：createdAt 决定「保存时间」，updatedAt 决定「最近活动」。 */
function group(name, createdDaysAgo, updatedDaysAgo, tabCount) {
  const id = crypto.randomUUID();
  return {
    id, name, notes: '', isFavorite: false, isLocked: false, isDeleted: false,
    tabs: Array.from({ length: tabCount }, (_, i) => ({
      id: crypto.randomUUID(),
      url: `https://example.com/${i}`,
      title: `tab ${i}`,
      favicon: '',
      createdAt: iso(now - days(createdDaysAgo)),
      lastAccessed: iso(now - days(updatedDaysAgo)),
      group_id: id, pinned: false,
    })),
    createdAt: iso(now - days(createdDaysAgo)),
    updatedAt: iso(now - days(updatedDaysAgo)),
    version: 1, displayOrder: 1, lastOp: { probe: 'probe', s: 1 },
  };
}

const groups = [
  group('A 刚存的', 0.02, 0.02, 2),
  group('B 昨天存的', 1, 1, 2),
  group('C 三天前存的', 3, 3, 2),
  group('D 十天前存的', 10, 10, 2),
  group('E 三十天前存的', 30, 30, 2),
  group('F 九十天前存的（但昨天被改过）', 90, 1, 2),
];

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-sort-'));
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
    await seed.evaluate(async ({ rows, settings }) => {
      const put = (key, value) => new Promise((res, rej) => {
        const req = indexedDB.open('tabvaultpro', 1);
        req.onerror = () => rej(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key, value });
          tx.oncomplete = () => { db.close(); res(); };
          tx.onerror = () => { db.close(); rej(req.error); };
        };
      });
      await put('tab_groups', rows);
      await put('user_settings', settings);
    }, { rows: groups, settings: { layoutMode: 'double', sessionSort: 'saved' } });
    await seed.close();

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await page.waitForSelector('text=刚存的', { timeout: 15000 });
    await page.mouse.move(2, 2);
    await page.waitForTimeout(800);

    const readOrder = async () => page.evaluate(() => {
      const cols = [...document.querySelectorAll('.session-grid-column')];
      return {
        columns: cols.length,
        // DOM 序（= 键盘 Tab 序 = 读屏顺序）
        dom: cols.flatMap(c => [...c.querySelectorAll('.tab-group-header')].map(h => {
          const t = h.querySelector('h3, .tab-group-title, [class*="title"]');
          return (t?.textContent || '').trim();
        })),
        // 视觉左栏 / 右栏
        left: (cols[0] ? [...cols[0].querySelectorAll('.tab-group-header')] : []).map(h => {
          const t = h.querySelector('h3, .tab-group-title, [class*="title"]');
          return (t?.textContent || '').trim();
        }),
        right: (cols[1] ? [...cols[1].querySelectorAll('.tab-group-header')] : []).map(h => {
          const t = h.querySelector('h3, .tab-group-title, [class*="title"]');
          return (t?.textContent || '').trim();
        }),
      };
    });

    const sortSelect = page.locator('select').first();
    const readSort = async () => {
      const value = await sortSelect.inputValue().catch(() => '(读不到)');
      const label = await sortSelect.locator('option:checked').textContent().catch(() => '');
      return { value, label: (label || '').trim() };
    };

    console.log('当前排序下拉：', JSON.stringify(await readSort()));
    const def = await readOrder();
    console.log('\n[默认键] 左栏：', JSON.stringify(def.left, null, 0));
    console.log('[默认键] 右栏：', JSON.stringify(def.right, null, 0));
    console.log('[默认键] DOM 序：', JSON.stringify(def.dom, null, 0));
    await page.screenshot({ path: `${OUT}-saved.png` });

    // 切到「最近活动」
    const options = await sortSelect.locator('option').allTextContents();
    console.log('\n排序下拉的选项：', JSON.stringify(options));
    const idx = options.findIndex(o => o.includes('最近活动'));
    if (idx >= 0) {
      await sortSelect.selectOption({ index: idx });
      await page.waitForTimeout(900);
      console.log('切到：', JSON.stringify(await readSort()));
      const acc = await readOrder();
      console.log('\n[最近活动] 左栏：', JSON.stringify(acc.left, null, 0));
      console.log('[最近活动] 右栏：', JSON.stringify(acc.right, null, 0));
      await page.screenshot({ path: `${OUT}-accessed.png` });
    }

    await page.close();
  } finally {
    await ctx.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
