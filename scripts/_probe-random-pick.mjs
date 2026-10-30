// 骰子（随机打开一个标签）真机探针 —— 2026-10-30。
//
// 断言的是**目标状态**，不是「脚本跑完了」：
//   ① 顶栏那颗按钮真的画出来了（可见 + 无障碍名），且截图留证；
//   ② 点下去之后浏览器里**真的多了一个标签页**，URL 来自池子（http/https）；
//   ③ 会话里**恰好少了一条**（点开即消费），且少的正是被打开的那条；
//   ④ 锁定会话的标签与 file:// 这条**一次都没被抽中**（多轮抽样）。
//
// 运行：node scripts/_probe-random-pick.mjs
import { mkdirSync } from 'node:fs';
import { launchCtx, readGroupsFromSW, openPopup, startContentSite } from './e2e-helpers.mjs';

const OUT = 'outputs/probe-random-pick';
mkdirSync(OUT, { recursive: true });

const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);
const tab = (url, title) => ({
  id: `t-${rid()}`, url, title, createdAt: now(), lastAccessed: now(), pinned: false,
});

// 用**真能打开**的本地站点：假域名的页面会停在 chrome-error://，
// 于是探针读到的 URL 与真实打开的那条对不上（假服务器 / 假域名自证式盲区）。
const site = await startContentSite('骰子');
const A1 = `${site.base}/alpha-one`;
const A2 = `${site.base}/alpha-two`;
const B3 = `${site.base}/beta-three`;
const B4 = `${site.base}/beta-four`;
const LOCKED_URL = `${site.base}/locked-x`;

const SEED = [
  { name: 'g1-普通A', tabs: [tab(A1, 'Alpha One'), tab(A2, 'Alpha Two')] },
  { name: 'g2-锁定', isLocked: true, tabs: [tab(LOCKED_URL, 'Locked X')] },
  {
    name: 'g3-普通B',
    tabs: [tab('file:///Users/me/paper.pdf', 'Local PDF'), tab(B3, 'Beta Three'), tab(B4, 'Beta Four')],
  },
];

const POOL_URLS = new Set([A1, A2, B3, B4]);
const FORBIDDEN_URLS = new Set([LOCKED_URL, 'file:///Users/me/paper.pdf']);

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const ctx = await launchCtx('randpick');
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  const id = sw.url().split('/')[2];

  // 等扩展建库，再写种子
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
  await sw.evaluate(async seed => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    const n = new Date().toISOString();
    const groups = seed.map(s => ({
      id: `seed-${Math.random().toString(36).slice(2, 10)}`,
      name: s.name,
      tabs: s.tabs,
      createdAt: n, updatedAt: n, isLocked: Boolean(s.isLocked), version: 1,
    }));
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
  }, SEED);

  const page = await openPopup(ctx, id, { waitMs: 2500 });

  const dice = page.locator('button[aria-label="随机打开一个标签页"]');
  const visible = await dice.isVisible().catch(() => false);
  check(visible, '顶栏的骰子按钮可见', await dice.count() ? '找到按钮' : '找不到按钮');
  await page.locator('.app-header-actions').screenshot({ path: `${OUT}/01-header.png` }).catch(() => {});

  const before = await readGroupsFromSW(ctx);
  const initialTabCount = before.flatMap(g => g.tabs || []).length;
  const beforeRows = await page.locator('.tab-item').count();
  console.log(`初始：会话 ${before.length} 个，标签 ${initialTabCount} 条，UI 行 ${beforeRows} 条`);

  const opened = [];
  for (let round = 1; round <= 4; round++) {
    // 每轮重新数一遍池子（每轮都会消费一条）
    const groupsNow = await readGroupsFromSW(ctx);
    const tabsNow = groupsNow.flatMap(g => g.tabs || []);
    const poolNow = groupsNow
      .filter(g => !g.isLocked)
      .flatMap(g => g.tabs || [])
      .filter(t => POOL_URLS.has(t.url));
    if (poolNow.length === 0) break;

    const pagesBefore = ctx.pages().length;
    await dice.click({ timeout: 5000 });
    // 等浏览器真开出一个标签页（popup 可能因此失焦，但 SW 与 storage 仍可读）
    let newUrl = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(300);
      const extra = ctx.pages().filter(p => p !== page);
      if (extra.length > pagesBefore - 1 && extra.length > 0) {
        newUrl = extra[extra.length - 1].url();
        if (newUrl && newUrl !== 'about:blank') break;
      }
    }

    const after = await readGroupsFromSW(ctx);
    const afterTabs = after.flatMap(g => g.tabs || []);
    const openedTab = tabsNow.find(t => !afterTabs.some(a => a.id === t.id));
    opened.push(openedTab?.url ?? newUrl);

    check(!!newUrl && newUrl !== 'about:blank', `第 ${round} 轮：浏览器里真的开出了标签页`, String(newUrl));
    check(POOL_URLS.has(newUrl), `第 ${round} 轮：打开的 URL 来自抽签池`, String(newUrl));
    check(!FORBIDDEN_URLS.has(newUrl), `第 ${round} 轮：没有抽中锁定会话 / file://`, String(newUrl));
    check(afterTabs.length === tabsNow.length - 1, `第 ${round} 轮：会话里恰好少一条`,
      `${tabsNow.length} → ${afterTabs.length}`);
    check(openedTab?.url === newUrl, `第 ${round} 轮：消费掉的正是被打开的那条`,
      `打开=${newUrl} 消费=${openedTab?.url}`);

    // 关掉刚开出的标签页，免得页面越积越多影响下一轮
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }

  // 锁定会话必须原封不动
  const finalGroups = await readGroupsFromSW(ctx);
  const locked = finalGroups.find(g => g.isLocked);
  check((locked?.tabs || []).length === 1, '锁定会话的标签一条都没被消费',
    JSON.stringify((locked?.tabs || []).map(t => t.url)));
  const fileStill = finalGroups.flatMap(g => g.tabs || []).some(t => String(t.url).startsWith('file:'));
  check(fileStill, 'file:// 那条仍在会话里（不可打开 ≠ 该被抽走）');

  console.log(`\n抽中记录：${JSON.stringify(opened)}`);
  await page.screenshot({ path: `${OUT}/02-after.png` }).catch(() => {});
} finally {
  await ctx.close();
  site.server.close();
}

console.log(failures.length === 0 ? '\n全部断言通过' : `\n${failures.length} 条断言失败：${failures.join(' / ')}`);
process.exit(failures.length === 0 ? 0 : 1);
