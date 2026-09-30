// 「切双栏多出空标签组」到底来自渲染重复还是既有数据 —— v1.22.0 无墓碑模型下钉死判据。
//
// 原脚本的造数据方式属于旧世界：g4/g5 直接 seed isDeleted: true 的墓碑 tab。
// 1.22.0（提交 bdad42d）后本地写路径永不产墓碑，读路径改为**剥离**老版本
// （商店 1.21.4）写入的墓碑形状：purgeTombstones 迁移在首启把它们从 storage 里
// 物理清除（src/utils/migrationUtils.ts），toActiveGroupsView 再挡一层视图
// （src/store/slices/tabSliceHelpers.ts）。
//
// 保留「老版本数据」这条造数据方式是**故意的**：它正是新版必须扛住的输入。
// 现在检验的不变量：
//   ① 首启后 storage 里不再有任何 isDeleted 墓碑 tab（老版本形状已被物理剥离）
//   ② storage 里不再有组级 isDeleted 组（旧回收站内容已随迁移清除）
//   ③ UI 卡片数 == 存储中「有内容且 id 唯一」的组数 —— 多出来的空组只能来自数据，
//      不能来自渲染；重复 id 必须收敛（否则 React 重复 key 会在双栏把卡片数放大）
//   ④ 单栏↔双栏来回切 3 轮，UI 卡片数与 storage 组数都不变（切布局不写数据、不长空壳）
//
// ── 2026-09-30 补登：g8/g9/g10 是真实故障的种子 ──
// 上一版种子只有 isLocked:false 的空组、且没有重复 id，于是 15/15 全绿却漏掉了
// 真实用户的故障：两条**逐字段相同的锁定空组 + 同 id**，本地躺了 7 个月。
// 双栏把数组重切成两半后撞上 key={group.id} 撞车，33 张卡渲染成 39 张。
// g8 = 锁定 + 零标签（空壳判据必须熄掉，不管锁定）
// g9/g10 = 同 id 两条且都有内容（去重必须保留 1 张；dedupe 后写入者胜）
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'layoutbug2';
const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);

const gate = createGate();

function tab(url, title, extra = {}) {
  return { id: `t-${rid()}`, url, title, createdAt: now(), lastAccessed: now(), pinned: false, ...extra };
}

// 重复 id 用的固定 id（2026-09-30 真实故障：F0pMPuUTxt45Ky0XB_fok 出现两次）
const DUP_ID = 'seed-dup-id-001';

// 直接构造最终的存储形状（跳过 SW 内部逻辑，只测读路径 + 渲染）
const SEED_GROUPS = [
  { name: 'g1-正常', tabs: [tab('https://a.com', 'A'), tab('https://b.com', 'B')] },
  { name: 'g2-空组', tabs: [] },                                              // 遗留空壳
  { name: 'g3-重复URL', tabs: [tab('https://dup.com', 'D1'), tab('https://dup.com', 'D2')] },
  { name: 'g4-老版本墓碑tab', tabs: [tab('https://c.com', 'C1', { isDeleted: true }), tab('https://c.com', 'C2')] },
  { name: 'g5-老版本全墓碑', tabs: [tab('https://e.com', 'E1', { isDeleted: true })] },
  { name: 'g6-单页', tabs: [tab('https://f.com', 'F')] },
  { name: 'g7-正常2', tabs: [tab('https://g.com', 'G'), tab('https://h.com', 'H')] },
  { name: 'g8-锁定空组', tabs: [], isLocked: true },                           // 零标签 + 锁定 = 空壳
  { name: 'g9-重复id-A', tabs: [tab('https://k.com', 'K1')], id: DUP_ID },
  { name: 'g10-重复id-B', tabs: [tab('https://l.com', 'L1')], id: DUP_ID },
];
/** 视图层的存活判据：非组级墓碑、且至少一个非墓碑 tab（= toActiveGroupsView） */
const visibleInView = g => !g.isDeleted && (g.tabs || []).some(t => !t.isDeleted);

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
      id: s.id || `seed-${Math.random().toString(36).slice(2, 10)}`,
      name: s.name,
      tabs: s.tabs.map(t => ({ ...t, id: `t-${Math.random().toString(36).slice(2, 10)}` })),
      createdAt: n, updatedAt: n, isLocked: Boolean(s.isLocked), version: 1,
    }));
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
      tx.oncomplete = res; tx.onerror = () => rej(new Error('write'));
    });
    db.close();
    return groups.length;
  }, SEED_GROUPS);
  console.log(`已写入存储: ${written} 组（含老版本墓碑形状与 1 个真空组）`);

  const page = await openPopup(ctx, id);
  await dismissOnboarding(page);

  // 迁移在 popup 挂载时异步跑，轮询等它落盘，不用固定 sleep（见 e2e-helpers 约定）
  let groups = [];
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    groups = await readGroupsFromSW(ctx);
    if (!groups.flatMap(g => g.tabs || []).some(t => t.isDeleted === true)) break;
  }

  const tabTombs = groups.flatMap(g => g.tabs || []).filter(t => t.isDeleted === true);
  const groupTombs = groups.filter(g => g.isDeleted);
  const expectedVisible = groups.filter(visibleInView).length;
  console.log(`首启迁移后: 存储组=${groups.length}，其中视图可见=${expectedVisible}` +
    `，墓碑组=${groupTombs.length}，墓碑 tab=${tabTombs.length}`);

  gate.check('老版本标签级墓碑已从 storage 物理剥离（purgeTombstones）', tabTombs.length === 0,
    `仍残留 ${tabTombs.length} 个：${tabTombs.map(t => t.title).join(', ')}`);
  gate.check('老版本组级墓碑已从 storage 物理剥离', groupTombs.length === 0,
    `仍残留 ${groupTombs.length} 个`);

  async function probe(tag) {
    const cards = await page.locator('.tab-group-card').count();
    const stored = await readGroupsFromSW(ctx);
    // 按 id 去重后再数：UI 卡片数必须等于「有内容且 id 唯一」的组数。
    // 不去重的话这条断言会把「重复 id 正常渲染出 2 张」误判为通过，而那正是
    // React 重复 key 在双栏放大卡片数的起点（2026-09-30 真实故障）。
    const byId = new Map();
    for (const g of stored) if (visibleInView(g)) byId.set(g.id, g);
    const visible = byId.size;
    const names = await page.locator('.tab-group-card').evaluateAll(
      els => els.map(e => (e.querySelector('h3.tab-group-title')?.textContent || '').trim())
    );
    console.log(`\n[${tag}] UI 卡片=${cards} | 存储组=${stored.length} | 视图可见组(按 id 去重)=${visible}`);
    console.log(`  UI 卡片: ${JSON.stringify(names)}`);
    return { cards, stored, visible };
  }

  const first = await probe('初始(单栏)');
  const dupCount = first.stored.length - new Set(first.stored.map(g => g.id)).size;
  gate.check('种子里的重复 id 确实写进了存储（否则本轮不构成回归验证）', dupCount === 1,
    `期望 1 组重复 id，实际 ${dupCount}`);
  gate.check('UI 卡片数 == 视图可见组数（无渲染重复、无重复 id 放大）', first.cards === first.visible,
    `UI ${first.cards} 张 vs 去重后可见 ${first.visible} 组`);

  const toDouble = page.locator('button[aria-label*="切换为双栏"]').first();
  const toSingle = page.locator('button[aria-label*="切换为单栏"]').first();
  let prev = first;
  for (let round = 1; round <= 3; round++) {
    if (await toDouble.count()) { await toDouble.click(); await page.waitForTimeout(1800); }
    const d = await probe(`第${round}轮 双栏`);
    gate.check(`第${round}轮：切双栏后 UI 卡片数不变（不凭空多出空组卡）`,
      d.cards === prev.cards, `${prev.cards} → ${d.cards}`);
    gate.check(`第${round}轮：切双栏后 storage 组数不变（渲染不写数据）`,
      d.stored.length === prev.stored.length, `${prev.stored.length} → ${d.stored.length}`);

    if (await toSingle.count()) { await toSingle.click(); await page.waitForTimeout(1800); }
    const s = await probe(`第${round}轮 单栏`);
    gate.check(`第${round}轮：切回单栏后 UI 卡片数不变`, s.cards === d.cards, `${d.cards} → ${s.cards}`);
    gate.check(`第${round}轮：切回单栏后 storage 组数不变`, s.stored.length === d.stored.length,
      `${d.stored.length} → ${s.stored.length}`);
    prev = s;
  }

  gate.report('布局切换不产生空壳会话（v1.22.0 无墓碑模型）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('布局切换不产生空壳会话（v1.22.0 无墓碑模型）');
} finally {
  try { await ctx.close(); } catch { /* 关不掉不影响判定 */ }
}
