// 骰子的窄屏形态 —— 2026-10-30。
//
// 要验的是两件事，都是「按了看得见的东西」而不是源码字样：
//   ① 390px 下顶栏那颗骰子是**藏起来的**，且搜索框没有被挤成 0 宽
//      （顶栏多了一颗按钮，正是当年 390px 塞不下的老毛病）。
//   ② ⋯ 菜单里有「随机打开一个标签」，点它真的开出一个标签页（窄屏唯一入口）。
import { mkdirSync } from 'node:fs';
import { launchCtx, readGroupsFromSW, openPopup, startContentSite } from './e2e-helpers.mjs';

const OUT = 'outputs/probe-random-pick';
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);
const tab = (url, title) => ({ id: `t-${rid()}`, url, title, createdAt: now(), lastAccessed: now(), pinned: false });

const site = await startContentSite('窄屏骰子');
const URLS = [`${site.base}/n1`, `${site.base}/n2`, `${site.base}/n3`];

const ctx = await launchCtx('randpick-narrow');
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  const id = sw.url().split('/')[2];
  for (let i = 0; i < 20; i++) {
    const ready = await sw.evaluate(() => new Promise(res => {
      const r = indexedDB.open('tabvaultpro', 1);
      r.onsuccess = () => { const ok = r.result.objectStoreNames.contains('kv'); r.result.close(); res(ok); };
      r.onerror = () => res(false);
      r.onblocked = () => res(false);
    }));
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await sw.evaluate(async urls => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    const n = new Date().toISOString();
    const groups = [{
      id: `seed-${Math.random().toString(36).slice(2, 10)}`,
      name: 'narrow',
      tabs: urls.map((u, i) => ({
        id: `t-${Math.random().toString(36).slice(2, 10)}`,
        url: u, title: `N${i}`, createdAt: n, lastAccessed: n, pinned: false,
      })),
      createdAt: n, updatedAt: n, isLocked: false, version: 1,
    }];
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
  }, URLS);

  const page = await openPopup(ctx, id, { waitMs: 2500 });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/03-narrow-390.png` });

  const dice = page.locator('button[aria-label="随机打开一个标签页"]');
  check((await dice.count()) === 0 || !(await dice.isVisible()), '390px 下顶栏的骰子是藏起来的');

  const searchWidth = await page.evaluate(() => {
    const input = document.querySelector('input[type="search"], input[role="searchbox"], input[aria-label*="搜索"]');
    return input ? Math.round(input.getBoundingClientRect().width) : -1;
  });
  check(searchWidth > 60, '390px 下搜索框没有被挤成 0 宽', `${searchWidth}px`);

  await page.locator('button[aria-label="菜单"]').click();
  await page.waitForTimeout(400);
  const row = page.getByRole('menuitem', { name: '随机打开一个标签' });
  check((await row.count()) > 0, '⋯ 菜单里有「随机打开一个标签」入口');
  await page.screenshot({ path: `${OUT}/04-narrow-menu.png` });

  const before = await readGroupsFromSW(ctx);
  const beforeCount = before.flatMap(g => g.tabs || []).length;
  await row.click();
  let openedUrl = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const extra = ctx.pages().filter(p => p !== page);
    if (extra.length > 0) {
      const u = extra[extra.length - 1].url();
      if (u && u !== 'about:blank') { openedUrl = u; break; }
    }
  }
  const after = await readGroupsFromSW(ctx);
  const afterCount = after.flatMap(g => g.tabs || []).length;
  check(URLS.includes(openedUrl), '点菜单里的入口真的开出了池子里的标签页', String(openedUrl));
  check(afterCount === beforeCount - 1, '窄屏入口同样「点开即消费」', `${beforeCount} → ${afterCount}`);
} finally {
  await ctx.close();
  site.server.close();
}

console.log(failures.length === 0 ? '\n全部断言通过' : `\n${failures.length} 条断言失败：${failures.join(' / ')}`);
process.exit(failures.length === 0 ? 0 : 1);
