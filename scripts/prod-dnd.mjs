// 拖拽实测 —— 「整理工作现场」是产品的一半，拖拽是整理的唯一手段。
// 用法：pnpm build 之后 `node scripts/prod-dnd.mjs`

import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'dist');
const OUT_DIR = resolve(process.cwd(), 'outputs/prod-dnd');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

function mkGroup(name, { order, ageHours, tabs }) {
  const id = crypto.randomUUID();
  return {
    id, name, notes: '', isFavorite: false, isLocked: false, isDeleted: false,
    tabs: tabs.map(([url, title]) => ({
      id: crypto.randomUUID(), url, title,
      favicon: '', createdAt: iso(now - ageHours * 3600e3), lastAccessed: iso(now - ageHours * 3600e3),
      group_id: id, pinned: false,
    })),
    createdAt: iso(now - ageHours * 3600e3), updatedAt: iso(now - (ageHours - 0.5) * 3600e3),
    version: 1, displayOrder: order, lastOp: { d: 'demo', s: order },
  };
}

const groups = [
  mkGroup('A 会话', { order: 1, ageHours: 2, tabs: [
    ['https://a.com/1', 'A1 页面'], ['https://a.com/2', 'A2 页面'], ['https://a.com/3', 'A3 页面'],
  ]}),
  mkGroup('B 会话', { order: 2, ageHours: 6, tabs: [
    ['https://b.com/1', 'B1 页面'], ['https://b.com/2', 'B2 页面'],
  ]}),
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

const readGroups = page => page.evaluate(async () => new Promise((resolve, reject) => {
  const r = indexedDB.open('tabvaultpro', 1);
  r.onerror = () => reject(new Error('open'));
  r.onsuccess = () => {
    const db = r.result;
    const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
    all.onsuccess = () => {
      db.close();
      const e = (all.result || []).find(v => v?.key === 'tab_groups');
      resolve(e ? (e.value || []) : []);
    };
  };
}));

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'tapstack-dnd-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--lang=zh-CN'],
  });
  try {
    let sw = null;
    for (let i = 0; i < 30 && !sw; i++) { sw = ctx.serviceWorkers()[0] ?? null; if (!sw) await new Promise(r => setTimeout(r, 500)); }
    const id = new URL(sw.url()).host;

    const page = await ctx.newPage();
    await page.setViewportSize({ width: 400, height: 600 });
    await page.goto(`chrome-extension://${id}/src/popup/index.html`);
    const skip = page.locator('button[aria-label="跳过引导"]');
    await skip.waitFor({ state: 'visible', timeout: 8000 }).then(() => skip.click()).catch(() => {});
    await inject(page, groups);
    await page.reload();
    await page.waitForSelector('text=A 会话', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // 拖拽元素的属性
    const dragInfo = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[draggable="true"]')];
      return els.slice(0, 5).map(e => {
        const r = e.getBoundingClientRect();
        return {
          tag: e.tagName.toLowerCase(),
          cls: (e.className||'').toString().slice(0, 60),
          text: (e.textContent||'').trim().slice(0, 30),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        };
      });
    });
    console.log('可拖拽元素:', JSON.stringify(dragInfo, null, 1));

    const rowA1 = page.locator('[draggable="true"]').first();
    const boxA1 = await rowA1.boundingBox();
    const rowB1 = page.locator('[draggable="true"]').nth(3); // B1
    const boxB1 = await rowB1.boundingBox();
    console.log('拖拽源 A1:', JSON.stringify(boxA1));
    console.log('拖拽目标 B1:', JSON.stringify(boxB1));

    if (boxA1 && boxB1) {
      // 真实 mouse 拖拽
      await page.mouse.move(boxA1.x + boxA1.width / 2, boxA1.y + boxA1.height / 2);
      await page.mouse.down();
      // 分步移动，触发 dragover
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(
          boxA1.x + boxA1.width / 2 + (boxB1.x - boxA1.x) * i / 10,
          boxA1.y + boxA1.height / 2 + (boxB1.y - boxA1.y) * i / 10
        );
        await page.waitForTimeout(60);
      }
      await page.screenshot({ path: join(OUT_DIR, '01-during-drag.png') });
      const during = await page.evaluate(() => ({
        dragging: !!document.querySelector('[class*="dragging"], [data-dragging="true"]'),
        dropTarget: document.querySelector('[class*="drop-target"], [data-drop-target]')?.className?.slice(0,50) || null,
        bodyCursor: getComputedStyle(document.body).cursor,
      }));
      console.log('拖拽中状态:', JSON.stringify(during));
      await page.mouse.up();
      await page.waitForTimeout(2000);

      const after = await readGroups(page);
      const a = after.find(g => g.name === 'A 会话');
      const b = after.find(g => g.name === 'B 会话');
      console.log('拖后 A 会话标签:', a?.tabs.map(t => t.title));
      console.log('拖后 B 会话标签:', b?.tabs.map(t => t.title));
      await page.screenshot({ path: join(OUT_DIR, '02-after-drag.png') });
    }

    // 键盘重排：焦点到标签行后按上下键
    console.log('\n── 键盘重排 ──');
    await page.locator('a[aria-label*="打开标签页"]').first().focus();
    const beforeKb = (await readGroups(page)).find(g => g.name === 'A 会话')?.tabs.map(t => t.title);
    console.log('键盘重排前 A:', beforeKb);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(1500);
    const afterKb = (await readGroups(page)).find(g => g.name === 'A 会话')?.tabs.map(t => t.title);
    console.log('键盘重排后 A:', afterKb);
    await page.screenshot({ path: join(OUT_DIR, '03-after-keyboard.png') });
  } finally {
    await ctx.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
