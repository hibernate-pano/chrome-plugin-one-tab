// 复验：多次来回切单/双栏，观察 (a) 空壳会话是否累积 (b) 双栏左右分布是否按次序均分。
//
// 用法：node scripts/e2e-layout-column-split.mjs <label>
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';

const label = process.argv[2] || 'colsplit';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

// 6 个正常会话（奇偶混合）+ 2 个空壳会话，贴近真实脏数据
const SEED = [
  { name: '会话1', tabs: 2 }, { name: '会话2', tabs: 1 }, { name: '会话3', tabs: 3 },
  { name: '会话4', tabs: 1 }, { name: '会话5', tabs: 2 }, { name: '会话6', tabs: 1 },
  { name: '空壳A', tabs: 0 }, { name: '空壳B', tabs: 0 },
].map((s, i) => ({
  id: `seed-${rid()}`,
  name: s.name,
  tabs: Array.from({ length: s.tabs }, (_, j) => ({
    id: `t-${rid()}`, url: `https://s${i}p${j}.com`, title: `${s.name}-${j}`,
    createdAt: now(), lastAccessed: now(), pinned: false,
  })),
  createdAt: new Date(Date.now() - i * 60000).toISOString(),
  updatedAt: now(), isLocked: false, version: 1,
}));

const ctx = await launchCtx(label);
try {
  if (!ctx.serviceWorkers()[0]) await new Promise(r => setTimeout(r, 3000));
  const sw = ctx.serviceWorkers()[0];
  const id = sw.url().split('/')[2];
  await sw.evaluate(async (groups) => {
    const r = indexedDB.open('tabvaultpro', 1);
    await new Promise((res, rej) => { r.onsuccess = res; r.onerror = () => rej(new Error('open')); });
    const db = r.result;
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
  }, SEED);

  const page = await openPopup(ctx, id);
  await dismissOnboarding(page);
  await page.waitForTimeout(2000);

  async function readColumns() {
    // 双栏容器下取两栏的卡片名；单栏下返回单列
    return page.evaluate(() => {
      const cards = [...document.querySelectorAll('.tab-group-card')];
      const name = el => (el.querySelector('input')?.value || el.textContent || '').slice(0, 8);
      const cols = [...document.querySelectorAll('.md\\:grid-cols-2 > div')];
      if (cols.length === 2) {
        return {
          mode: 'double',
          left: [...cols[0].querySelectorAll('.tab-group-card')].map(name),
          right: [...cols[1].querySelectorAll('.tab-group-card')].map(name),
        };
      }
      return { mode: 'single', single: cards.map(name) };
    });
  }

  for (let round = 1; round <= 3; round++) {
    // 切到双栏
    const toDouble = page.locator('button[aria-label*="切换为双栏"]').first();
    if (await toDouble.count()) { await toDouble.click(); await page.waitForTimeout(1800); }
    const d = await readColumns();
    const stored = await readGroupsFromSW(ctx);
    const shells = stored.filter(g => !(g.tabs || []).some(t => !t.isDeleted)).length;
    console.log(`\n第${round}轮 · 双栏: 左栏${d.left?.length ?? 0} 张 [${(d.left || []).join(' | ')}]`);
    console.log(`        右栏${d.right?.length ?? 0} 张 [${(d.right || []).join(' | ')}]`);
    console.log(`        UI 合计=${(d.left?.length ?? 0) + (d.right?.length ?? 0)} | 存储组=${stored.length} | 存储空壳组=${shells}`);

    // 切回单栏
    const toSingle = page.locator('button[aria-label*="切换为单栏"]').first();
    if (await toSingle.count()) { await toSingle.click(); await page.waitForTimeout(1800); }
    const s = await readColumns();
    console.log(`        单栏 UI 合计=${s.single?.length ?? 0}`);
  }
} finally {
  await ctx.close();
}
