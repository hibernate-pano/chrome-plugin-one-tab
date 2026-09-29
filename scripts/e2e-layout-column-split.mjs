// 复验双栏左右分栏规则：多次来回切单/双栏，(a) 空壳会话是否累积 (b) 左右是否按次序均分。
//
// v1.22.0 之前的造数据里塞过 isDeleted 墓碑 tab，那是旧模型的做法（已随提交 bdad42d
// 废除）。这里改为塞「老版本遗留的空壳会话」——视图层 toActiveGroupsView 会把它们
// 过滤掉（src/store/slices/tabSliceHelpers.ts），storage 保留原样。
//
// 分栏规则来自 src/components/tabs/TabList.tsx:153 —— 不是 CSS 自动均分，是 JS
// 按次序对分：mid = ceil(n/2)，前半进左栏（含奇数时多出的那一个）、后半进右栏。
// 旧实现用 index % 2 奇偶交替导致读序错乱，这条断言就是钉住修复后的次序。
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
   * 双栏容器下取两栏的会话名；单栏下返回单列。
   * 会话名取 h3.tab-group-title（TabGroup.tsx 的标题节点）：卡片里还有 input（仅改名
   * 态渲染）、一堆按钮，用 textContent 整块截断认不出是哪个会话。
   */
  async function readColumns() {
    return page.evaluate(() => {
      const name = el => (el.querySelector('h3.tab-group-title')?.textContent || '').trim();
      const cols = [...document.querySelectorAll('.md\\:grid-cols-2 > div')];
      if (cols.length === 2) {
        return {
          mode: 'double',
          left: [...cols[0].querySelectorAll('.tab-group-card')].map(name),
          right: [...cols[1].querySelectorAll('.tab-group-card')].map(name),
        };
      }
      return { mode: 'single', single: [...document.querySelectorAll('.tab-group-card')].map(name) };
    });
  }

  // 视图排序 = createdAt 倒序（TabList.tsx:92）→ 正好是 seed 里的 会话1..会话7
  const EXPECTED_ORDER = SEED.filter(s => s.tabs > 0).map(s => s.name);

  const first = await readColumns();
  gate.check('单栏初始：7 个有内容的会话都渲染出来了（空壳被视图过滤）',
    first.mode === 'single' && first.single.length === EXPECTED_ORDER.length,
    `mode=${first.mode}，卡片=${JSON.stringify(first.single)}`);
  gate.check('单栏初始：渲染次序 = createdAt 倒序', first.single.join() === EXPECTED_ORDER.join(),
    `实际 [${first.single.join(' | ')}] 期望 [${EXPECTED_ORDER.join(' | ')}]`);

  let prevCards = first.single.length;
  for (let round = 1; round <= 3; round++) {
    const toDouble = page.locator('button[aria-label*="切换为双栏"]').first();
    if (await toDouble.count()) { await toDouble.click(); await page.waitForTimeout(1800); }
    const d = await readColumns();
    const stored = await readGroupsFromSW(ctx);
    const shells = stored.filter(g => !(g.tabs || []).length).length;
    console.log(`\n第${round}轮 · 双栏: 左栏${d.left?.length ?? 0} 张 [${(d.left || []).join(' | ')}]`);
    console.log(`        右栏${d.right?.length ?? 0} 张 [${(d.right || []).join(' | ')}]`);
    console.log(`        UI 合计=${(d.left?.length ?? 0) + (d.right?.length ?? 0)} | 存储组=${stored.length} | 存储空壳组=${shells}`);

    const total = (d.left?.length ?? 0) + (d.right?.length ?? 0);
    const expectLeft = Math.ceil(prevCards / 2);
    const expectOrder = EXPECTED_ORDER.slice(0, expectLeft).concat(EXPECTED_ORDER.slice(expectLeft));
    gate.check(`第${round}轮：双栏容器真的分成两栏`, d.mode === 'double', `mode=${d.mode}`);
    gate.check(`第${round}轮：左栏 ${expectLeft} 张、右栏 ${prevCards - expectLeft} 张（按次序对分）`,
      d.left?.length === expectLeft && d.right?.length === prevCards - expectLeft,
      `实际左 ${d.left?.length ?? '-'} / 右 ${d.right?.length ?? '-'}`);
    gate.check(`第${round}轮：两栏合起来不多不少（无渲染重复、无丢卡）`, total === prevCards,
      `合计 ${total}，单栏时 ${prevCards}`);
    gate.check(`第${round}轮：左栏是读序的前半段、右栏是后半段（不是奇偶交替）`,
      (d.left || []).join() === expectOrder.slice(0, expectLeft).join() &&
      (d.right || []).join() === expectOrder.slice(expectLeft).join(),
      `左=[${(d.left || []).join(' | ')}] 右=[${(d.right || []).join(' | ')}] 期望=[${expectOrder.join(' | ')}]`);
    gate.check(`第${round}轮：storage 组数不变（切布局不写数据、不长空壳）`,
      stored.length === SEED.length, `${SEED.length} → ${stored.length}`);

    const toSingle = page.locator('button[aria-label*="切换为单栏"]').first();
    if (await toSingle.count()) { await toSingle.click(); await page.waitForTimeout(1800); }
    const s = await readColumns();
    console.log(`        单栏 UI 合计=${s.single?.length ?? 0}`);
    gate.check(`第${round}轮：切回单栏后卡片数不变（空壳不累积）`, s.single?.length === prevCards,
      `${prevCards} → ${s.single?.length ?? '-'}`);
    prevCards = s.single?.length ?? 0;
  }

  gate.report('双栏左右按次序对分（v1.22.0 无墓碑模型）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('双栏左右按次序对分（v1.22.0 无墓碑模型）');
} finally {
  try { await ctx.close(); } catch { /* 关不掉不影响判定 */ }
}
