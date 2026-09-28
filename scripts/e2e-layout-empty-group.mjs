// 复现 v2：定位「切双栏多出空标签组」是渲染重复还是数据变化。
//
// 关键判据（每种布局都测）：
//   UI 卡片数(.tab-group-card) vs 存储组数 —— 双栏下若 UI > 存储，即渲染重复；
//   双栏下若 UI == 存储但组本身 tabs 为空，即"空组是既有数据被渲染出来"。
//
// 用带真实特征的数据：正常组 / 已空组 / 重复 URL 组 / 墓碑 tab 组 / 奇数个组。
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';

const label = process.argv[2] || 'layoutbug2';
const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);

function tab(url, title, extra = {}) {
  return { id: `t-${rid()}`, url, title, createdAt: now(), lastAccessed: now(), pinned: false, ...extra };
}

// 直接构造最终的存储形状（跳过 SW 内部逻辑，只测渲染）
const SEED_GROUPS = [
  { name: 'g1-正常', tabs: [tab('https://a.com', 'A'), tab('https://b.com', 'B')] },
  { name: 'g2-空组', tabs: [] },
  { name: 'g3-重复URL', tabs: [tab('https://dup.com', 'D1'), tab('https://dup.com', 'D2')] },
  { name: 'g4-墓碑tab', tabs: [tab('https://c.com', 'C1', { isDeleted: true }), tab('https://c.com', 'C2')] },
  { name: 'g5-全墓碑', tabs: [tab('https://e.com', 'E1', { isDeleted: true })] },
  { name: 'g6-单页', tabs: [tab('https://f.com', 'F')] },
  { name: 'g7-正常2', tabs: [tab('https://g.com', 'G'), tab('https://h.com', 'H')] },
];

const ctx = await launchCtx(label);
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  const id = sw.url().split('/')[2];

  const written = await sw.evaluate(async (seed) => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    const n = new Date().toISOString();
    const groups = seed.map(s => ({
      id: `seed-${Math.random().toString(36).slice(2, 10)}`,
      name: s.name,
      tabs: s.tabs.map(t => ({ ...t, id: `t-${Math.random().toString(36).slice(2, 10)}` })),
      createdAt: n, updatedAt: n, isLocked: false, version: 1,
    }));
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
    return groups.length;
  }, SEED_GROUPS);
  console.log(`已写入存储: ${written} 组（含 1 个真空组）`);

  const page = await openPopup(ctx, id);
  await dismissOnboarding(page);
  await page.waitForTimeout(2000);

  async function probe(label) {
    const cards = await page.locator('.tab-group-card').count();
    const groups = await readGroupsFromSW(ctx);
    const emptyStored = groups.filter(g => !(g.tabs || []).some(t => !t.isDeleted)).length;
    const names = await page.locator('.tab-group-card').evaluateAll(
      els => els.map(e => (e.querySelector('input')?.value || e.textContent || '').slice(0, 18))
    );
    console.log(`\n[${label}] UI 卡片=${cards} | 存储组=${groups.length} | 存储中无活跃tab的组=${emptyStored}`);
    console.log(`  UI 卡片: ${JSON.stringify(names)}`);
    if (cards > groups.length) console.log(`  ⚠️ UI 多出 ${cards - groups.length} 张卡 → 渲染重复`);
    if (cards === groups.length && emptyStored > 0) console.log(`  ⚠️ ${emptyStored} 个组本就没有活跃 tab → 空组来自既有数据`);
  }

  await probe('初始(单栏)');
  const t1 = page.locator('button[aria-label*="切换为"]').first();
  await t1.click();
  await page.waitForTimeout(2500);
  await probe('切到双栏');
  const t2 = page.locator('button[aria-label*="切换为"]').first();
  await t2.click();
  await page.waitForTimeout(2500);
  await probe('切回单栏');
} finally {
  await ctx.close();
}
