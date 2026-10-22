// 复验双栏布局：多次来回切单/双栏，(a) 空壳会话是否累积 (b) 顺序对不对。
//
// v1.22.0 之前的造数据里塞过 isDeleted 墓碑 tab，那是旧模型的做法（已随提交 bdad42d
// 废除）。这里改为塞「老版本遗留的空壳会话」——视图层 toActiveGroupsView 会把它们
// 过滤掉（src/store/slices/tabSliceHelpers.ts），storage 保留原样。
//
// ── 2026-10-23 审计 R-11：这条断言的**对象变了** ─────────────────────────────
//
// 旧规则：「两列各一个 div」，JS 按次序对分（mid = ceil(n/2)，前半进左栏）。
//   ⇒ 屏幕顺序与**键盘 Tab 序**（= DOM 序 = 先走完左栏）都**不等于**用户选的排序。
//
// 新规则：**不拆列容器**了。排好序的会话**逐个**成为 `.session-grid` 的直接子项，
//   CSS grid 两列**按行填充**（1,2 / 3,4 / 5,6）⇒ DOM 序 == 逐行视觉序 == 排序序。
//
// ⇒ 本脚本现在钉的是**三个不变量**（而不是「左右各一半」）：
//   ① DOM 序 == 排序序；
//   ② **视觉阅读序**（按行分组、行内按 x）== DOM 序；
//   ③ 第 1、2 张卡**在同一行**（证明是行主序，不是列主序 `grid-auto-flow: column`）。
//
// 用法：node scripts/e2e-layout-column-split.mjs <label>
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'colsplit';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const gate = createGate();

// 7 个正常会话（奇数，正好压到「左栏多一个」的分支）+ 1 个空壳会话，贴近真实脏数据
const SEED = [
  { name: '会话1', tabs: 2 }, { name: '会话2', tabs: 1 }, { name: '会话3', tabs: 3 },
  { name: '会话4', tabs: 1 }, { name: '会话5', tabs: 2 }, { name: '会话6', tabs: 1 },
  { name: '会话7', tabs: 2 }, { name: '空壳A', tabs: 0 },
].map((s, i) => ({
  id: `seed-${rid()}`,
  name: s.name,
  tabs: Array.from({ length: s.tabs }, (_, j) => ({
    id: `t-${rid()}`, url: `https://s${i}p${j}.com`, title: `${s.name}-${j}`,
    createdAt: now(), lastAccessed: now(), pinned: false,
  })),
  // createdAt 递减 → 视图排序（createdAt 倒序）后正好是 seed 顺序，判据好写
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

  /**
   * 取网格里的会话卡：**DOM 序** + 每张卡的**视觉位置**（x/y）。
   * 单栏/双栏是同一个容器（`.session-grid`），轨道数由 computed style 读出来。
   *
   * 为什么连位置一起读：R-11 的核心不变量是「DOM 序 == 视觉阅读序」——
   * 只看名字序列，看不出用户眼睛扫到的顺序对不对。
   */
  async function readGrid() {
    return page.evaluate(() => {
      const name = el => (el.querySelector('h3.tab-group-title')?.textContent || '').trim();
      const grid = document.querySelector('.session-grid');
      const cols = grid
        ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0;
      const cards = [...document.querySelectorAll('.session-grid > .tab-group-card')].map(el => {
        const r = el.getBoundingClientRect();
        return { name: name(el), x: Math.round(r.x), y: Math.round(r.y) };
      });
      return { cols, cards };
    });
  }

  /**
   * **视觉阅读序**：按 y 分行（同一行 = y 相同），行内按 x 从左到右。
   *
   * CSS grid 按行填充时，同一行的卡片 y 完全相同（align-items: start），
   * 不同行的 y 严格递增 ⇒ 这个算法还原的就是人眼扫到的顺序。
   */
  function visualOrder(cards) {
    const rows = [];
    for (const card of cards) {
      const row = rows.find(r => Math.abs(r.y - card.y) <= 4);
      if (row) row.items.push(card);
      else rows.push({ y: card.y, items: [card] });
    }
    return rows
      .sort((a, b) => a.y - b.y)
      .flatMap(r => r.items.sort((a, b) => a.x - b.x))
      .map(c => c.name);
  }

  // 视图排序 = createdAt 倒序（TabList.tsx:92）→ 正好是 seed 里的 会话1..会话7
  // SEED 里的 tabs 已经是数组（map 时已展开），判「有内容」必须看 length：
  // 旧写法 `s.tabs > 0` 对数组恒为 false → 期望列表恒为空 → 4 条次序判据假红。
  const EXPECTED_ORDER = SEED.filter(s => s.tabs.length > 0).map(s => s.name);

  const first = await readGrid();
  const domOrder = cards => cards.map(c => c.name);
  gate.check('单栏初始：7 个有内容的会话都渲染出来了（空壳被视图过滤）',
    first.cards.length === EXPECTED_ORDER.length,
    `卡片=${JSON.stringify(domOrder(first.cards))}`);
  gate.check('单栏初始：渲染次序 = createdAt 倒序', domOrder(first.cards).join() === EXPECTED_ORDER.join(),
    `实际 [${domOrder(first.cards).join(' | ')}] 期望 [${EXPECTED_ORDER.join(' | ')}]`);

  let prevCards = first.cards.length;
  for (let round = 1; round <= 3; round++) {
    const toDouble = page.locator('button[aria-label*="切换为双栏"]').first();
    if (await toDouble.count()) { await toDouble.click(); await page.waitForTimeout(1800); }
    const d = await readGrid();
    const stored = await readGroupsFromSW(ctx);
    const shells = stored.filter(g => !(g.tabs || []).length).length;
    console.log(`\n第${round}轮 · 双栏: 轨道数=${d.cols}，卡片 ${d.cards.length} 张 [${domOrder(d.cards).join(' | ')}]`);
    console.log(`        视觉阅读序 [${visualOrder(d.cards).join(' | ')}]`);
    console.log(`        UI 合计=${d.cards.length} | 存储组=${stored.length} | 存储空壳组=${shells}`);

    gate.check(`第${round}轮：网格真的是两列`, d.cols === 2, `轨道数=${d.cols}`);
    gate.check(`第${round}轮：卡片不多不少（无渲染重复、无丢卡）`, d.cards.length === prevCards,
      `合计 ${d.cards.length}，单栏时 ${prevCards}`);
    gate.check(`第${round}轮：DOM 序 = 排序序（会话1..会话7）`,
      domOrder(d.cards).join() === EXPECTED_ORDER.join(),
      `实际 [${domOrder(d.cards).join(' | ')}] 期望 [${EXPECTED_ORDER.join(' | ')}]`);
    gate.check(`第${round}轮：视觉阅读序 = DOM 序（眼睛扫到的顺序就是排好的顺序）`,
      visualOrder(d.cards).join() === domOrder(d.cards).join(),
      `视觉 [${visualOrder(d.cards).join(' | ')}] DOM [${domOrder(d.cards).join(' | ')}]`);
    // 行主序的指纹：第 1、2 张在同一行（列主序 grid-auto-flow: column 时它们不同行）。
    gate.check(`第${round}轮：第 1、2 张卡在同一行（行主序，不是列主序）`,
      d.cards.length >= 2 && Math.abs(d.cards[0].y - d.cards[1].y) <= 4 && d.cards[0].x < d.cards[1].x,
      d.cards.length >= 2
        ? `card0=(x=${d.cards[0].x},y=${d.cards[0].y}) card1=(x=${d.cards[1].x},y=${d.cards[1].y})`
        : '卡片不足 2 张');
    gate.check(`第${round}轮：storage 组数不变（切布局不写数据、不长空壳）`,
      stored.length === SEED.length, `${SEED.length} → ${stored.length}`);

    const toSingle = page.locator('button[aria-label*="切换为单栏"]').first();
    if (await toSingle.count()) { await toSingle.click(); await page.waitForTimeout(1800); }
    const s = await readGrid();
    console.log(`        单栏 UI 合计=${s.cards.length}`);
    gate.check(`第${round}轮：切回单栏后卡片数不变（空壳不累积）`, s.cards.length === prevCards,
      `${prevCards} → ${s.cards.length}`);
    gate.check(`第${round}轮：切回单栏后次序仍是排序序`,
      domOrder(s.cards).join() === EXPECTED_ORDER.join(),
      `实际 [${domOrder(s.cards).join(' | ')}]`);
    prevCards = s.cards.length;
  }

  gate.report('双栏顺序（行主序）与 DOM 序一致（R-11）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('双栏顺序（行主序）与 DOM 序一致（R-11）');
} finally {
  try { await ctx.close(); } catch { /* 关不掉不影响判定 */ }
}
