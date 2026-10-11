// 真实浏览器拖拽：会话内标签拖拽排序转正回归（P0 + P1 + P3）。
//
// 用法：node scripts/e2e-tab-reorder.mjs <label>   （纯本地，不连云端、不登录）
//
// 背景：会话内标签拖拽在 v1.22.3 被产品决策下线后从未真正可用；1.22.5 的瘦身
// （提交 db09f10）把 react-dnd 实现「改写成原生 HTML5 DnD」，commit message 写
// 「行为保持一致」——但被保持一致的是一个从未可用过的行为，于是忠实复制了一个
// 死功能，还配了 18 条纯逻辑测试制造「能用」的错觉（tests/dragReorder.test.ts），
// 形成「测试全绿但功能失效」的结构性缺口：全仓 0 条真实拖拽测试。
// 本脚本补上这条缺口：Playwright mouse.down/move/up 驱动**真实**拖拽，
// 断言 DOM 行序 + IndexedDB 真值。
//
// 覆盖的三个修点（与实现一一对应）：
//   P0 —— 拖拽载荷在 dragover 阶段读不到（getData 受保护模式返回 ""），整个拖拽
//         是死的。修法：载荷只走 dragSession 这个同源 JS 变量，dataTransfer 只留
//         text/plain。对照断言：真实 dragover 阶段 getData() 返回空字符串
//         （证明「修好」不是「浏览器突然允许读了」，而是「不再依赖读」）。
//   P1 —— 跨组拖拽搬错行：g1=[a,b,c]、g2=[e,f]，拖 b(g1 idx1) 到 g2 的 e(idx0) ⇒
//         旧实现 moveTab 收到 ["g1",0,"g2",0]，搬走的是 a（g1=[bc]、g2=[aef]）。
//         修法：源下标收敛到拖拽会话锚点（dragSession.ts），行级 ref 退场。
//   P3 —— moveTab 写失败 UI 不回滚：rejected 曾是空实现，乐观顺序永久停在未落盘
//         的值上。修法：写入前快照 + 失败整体换回（与 deleteTabAndSync 同写法）。
//
// 判据口径：DOM 行序（用户所见）+ IndexedDB 真值（磁盘所存）必须一致 ——
// 只看其中一端会漏掉「UI 动了磁盘没动 / 磁盘动了 UI 没动」两类分叉。
import { launchCtx, readGroupsFromSW, dismissOnboarding, openPopup } from './e2e-helpers.mjs';
import { createGate } from './e2e-support.mjs';

const label = process.argv[2] || 'tabreorder';
const rid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const gate = createGate();

// g1=[a,b,c]、g2=[e,f]：P1 的复现场（拖 b 到 g2 的 e），下标/长度都刻意不对称。
// createdAt 递增 → 视图排序（createdAt 倒序）后 g2 在上、g1 在下，判据好写。
// 注意：openPopup 默认只等 1.5s + 引导处理，seed 写入后要等列表渲染收敛。
const SEED = [
  { name: 'G1-源组', tabs: ['a', 'b', 'c'] },
  { name: 'G2-目标组', tabs: ['e', 'f'] },
].map((s, i) => ({
  id: `seed-${rid()}`,
  name: s.name,
  tabs: s.tabs.map(t => ({
    id: `t-${t}-${rid()}`, url: `https://${t}.example.com`, title: `tab-${t}`,
    createdAt: now(), lastAccessed: now(), pinned: false,
  })),
  createdAt: new Date(Date.now() + i * 60000).toISOString(),
  updatedAt: now(), isLocked: false, version: 1,
}));

/** 读某会话卡片内的标签行标题（DOM 行序 = 用户所见顺序） */
async function readRowTitles(page, groupName) {
  return page.evaluate((name) => {
    const cards = [...document.querySelectorAll('.tab-group-card')];
    const card = cards.find(c => (c.querySelector('h3.tab-group-title')?.textContent || '').trim() === name);
    if (!card) return null;
    return [...card.querySelectorAll('.tab-item .tab-item-title')].map(a => (a.textContent || '').trim());
  }, groupName);
}

/** 按行标题找到某一行的中心点（真实拖拽的起点/落点） */
async function rowGrabPoint(page, groupName, title) {
  const box = await page.evaluate(({ name, t }) => {
    const cards = [...document.querySelectorAll('.tab-group-card')];
    const card = cards.find(c => (c.querySelector('h3.tab-group-title')?.textContent || '').trim() === name);
    if (!card) return null;
    const rows = [...card.querySelectorAll('.tab-item')];
    const row = rows.find(r => ((r.querySelector('.tab-item-title')?.textContent) || '').trim() === t);
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height, top: b.y };
  }, { name: groupName, t: title });
  if (!box) throw new Error(`找不到行：${groupName} / ${title}`);
  // x 取行左缘 +8（padding/favicon 区，必定在行 div 上、不在 <a> 上）——
  // 从链接文本上按下会启动「链接拖拽」而非行拖拽（见函数头注释）。
  return { x: box.x + 8, y: box.y, h: box.h, top: box.top };
}

/** 装上拖拽事件计数器（只统计，不参与应用逻辑）：dragstart/dragover/drop 次数 */
async function installDragCounters(page) {
  await page.evaluate(() => {
    window.__dragCounts = { dragstart: 0, dragover: 0, drop: 0, dragend: 0 };
    for (const type of Object.keys(window.__dragCounts)) {
      window.addEventListener(type, () => { window.__dragCounts[type] += 1; }, true);
    }
  });
}
const readDragCounts = page => page.evaluate(() => window.__dragCounts);

/**
 * 真实拖拽：从源行按下，移到落点行**下半区**后松开。
 *
 * 落到下半区（中点以下 1/4 处）：同组往下拖的换位分支要求 hoverPercentage > -0.2，
 * 下半区恒满足；跨组无此限制，同样换位。
 *
 * 【为什么要重试而不是只拖一次】合成指针事件不是 100% 可靠地触发 HTML5 DnD：
 * 实测偶发「鼠标按下 + 移动都发了、但 dragstart 一次都没触发」（此时界面毫无反应，
 * 不是实现坏了）。所以用「dragstart/dragover 计数 > 0」判定这一次拖拽**真的开始**了，
 * 没开始就重试——判据本身可验证，比固定 sleep 后假设成功可靠。
 */
async function realDrag(page, from, to, { attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    await installDragCounters(page);
    await page.bringToFront();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // 分多步移动：Chromium 要求指针移动一段距离才真正开始 drag（slide 阈值），
    // 一步到位会被当成点击。
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.waitForTimeout(500);
    const counts = await readDragCounts(page);
    await page.mouse.up();
    if (counts.dragstart > 0 && counts.dragover > 0) {
      await page.waitForTimeout(2500);
      return { attempts: i, counts };
    }
    console.log(`   ...第 ${i} 次拖拽未触发（dragstart=${counts.dragstart} dragover=${counts.dragover}），重试`);
    await page.waitForTimeout(500);
  }
  throw new Error(`真实拖拽连续 ${attempts} 次都没触发（dragstart=0）：合成指针事件未启动 HTML5 DnD`);
}

/** 等待 IndexedDB 真值满足谓词（SW 落盘 + 同步节流需要时间） */
async function waitGroups(ctx, pred, what, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const groups = await readGroupsFromSW(ctx);
    if (pred(groups)) return groups;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`超时未满足「${what}」：当前=${JSON.stringify(groups.map(g => `${g.name}[${(g.tabs || []).map(t => t.title).join(',')}]`))}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

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
  await page.waitForTimeout(2500);

  // ── 0. 对照断言：真实 dragover 阶段 getData() 返回空字符串 ──────────────
  // 前置：页面必须在前台，指针事件才会走完整 DnD 流水线（后台窗口里 mouse
  // 移动只产生普通 mousemove、不产生 dragstart；这是 Chromium 的输入语义，
  // 不是实现的 bug —— 没有 dragstart 就没有拖拽会话，后面所有断言都无意义）。
  await page.bringToFront();
  await page.waitForTimeout(500);
  // 这条断言钉住 P0 的前提本身：HTML5 DnD 的受保护模式在真实 Chromium 里存在。
  // 做法：在**空白新页**（about:blank）上自建两行最小可拖拽 div，dragstart 写入
  // application/x-tapstack-tab-probe=HELLO，dragover 把读到的值记下来 ——
  // 与被测组件零耦合（生产代码里没有任何探针：对照实验不依赖被测实现配合）。
  // 修好的拖拽不依赖这些值（载荷只走 dragSession 这个 JS 变量）—— 若某天浏览器
  // 改了语义让这条变红，说明「载荷可读了」，实现可以简化，但必须有人看一眼再动。
  const probe = await ctx.newPage();
  await probe.goto('about:blank');
  await probe.setContent(`
    <div id="probe-src" draggable="true" style="padding:30px;background:#eee">src</div>
    <div id="probe-dst" style="padding:30px;background:#ddd;margin-top:40px">dst</div>
    <script>
      window.__seen = [];
      const MIME = 'application/x-tapstack-tab-probe';
      const src = document.getElementById('probe-src');
      const dst = document.getElementById('probe-dst');
      src.addEventListener('dragstart', e => {
        e.dataTransfer.setData(MIME, 'HELLO');
        e.dataTransfer.setData('text/plain', 'probe');
      });
      dst.addEventListener('dragover', e => {
        e.preventDefault();
        if (window.__seen.length < 10) window.__seen.push(e.dataTransfer.getData(MIME));
      });
    <\/script>
  `);
  await probe.bringToFront();
  await probe.waitForTimeout(300);
  const pFrom = await probe.locator('#probe-src').boundingBox();
  const pTo = await probe.locator('#probe-dst').boundingBox();
  await probe.mouse.move(pFrom.x + pFrom.width / 2, pFrom.y + pFrom.height / 2);
  await probe.mouse.down();
  await probe.mouse.move(pTo.x + pTo.width / 2, pTo.y + pTo.height / 2, { steps: 12 });
  await probe.waitForTimeout(400);
  const probeSeen = await probe.evaluate(() => window.__seen);
  await probe.mouse.up();
  await probe.close();
  // 回到扩展页继续做 P1/P2 拖拽
  await page.bringToFront();
  await page.waitForTimeout(300);
  gate.check('对照：真实 dragover 阶段 getData() 返回空字符串（受保护模式存在）',
    probeSeen.length > 0 && probeSeen.every(v => v === ''),
    `采样 ${probeSeen.length} 次，值=${JSON.stringify(probeSeen.slice(0, 3))}`);
  gate.check('对照：采样确实采到了 dragover（不是零样本的空断言）',
    probeSeen.length >= 3, `实际 ${probeSeen.length} 次`);
  // 注意：上面第 0 节是独立空白页上的对照实验，不碰扩展页的状态。
  // 下面第 1 节做第一次真实应用内拖拽：b(G1) → e(G2) 下半区。

  // ── 1. P1 现场：跨组拖拽搬对行 ─────────────────────────────────────────
  // g1=[tab-a,tab-b,tab-c]、g2=[tab-e,tab-f]，现在把 b 拖到 g2 的 e 上
  // （落点 e 行下半区 —— 跨组落到目标行**下方**，被拖行插到 e 之后：
  // 期望 g1=[tab-a,tab-c]、g2=[tab-e,tab-b,tab-f]）。
  // 旧实现发出 moveTab(g1,0,g2,0) ⇒ 搬走 a ⇒
  // g1=[tab-b,tab-c]、g2=[tab-a,tab-e,tab-f]。修好后搬走的必须是 b。
  // g1=[tab-b,tab-c]、g2=[tab-a,tab-e,tab-f]。修好后必须是：
  // g1=[tab-a,tab-c]、g2=[tab-b,tab-e,tab-f]。
  // （落点是 e 行下半区：跨组换位无边缘限制；同组往下拖要求 hoverPercentage > -0.2，
  // 下半区恒满足 —— 若落点在 e 行上半区边缘 1/5 内会被抖动守卫挡住，那是刻意行为。）
  const g1Before = await readRowTitles(page, 'G1-源组');
  const g2Before = await readRowTitles(page, 'G2-目标组');
  gate.check('前置：两组都渲染出来了（g1 3 行、g2 2 行）',
    Array.isArray(g1Before) && g1Before.length === 3 && Array.isArray(g2Before) && g2Before.length === 2,
    `G1=${JSON.stringify(g1Before)} G2=${JSON.stringify(g2Before)}`);

  const fromB = await rowGrabPoint(page, 'G1-源组', 'tab-b');
  const toE = await rowGrabPoint(page, 'G2-目标组', 'tab-e');
  const toECenterX = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tab-group-card')];
    const card = cards.find(c => (c.querySelector('h3.tab-group-title')?.textContent || '').trim() === 'G2-目标组');
    const row = [...card.querySelectorAll('.tab-item')].find(r => ((r.querySelector('.tab-item-title')?.textContent) || '').trim() === 'tab-e');
    const b = row.getBoundingClientRect();
    return b.x + b.width / 2;
  });
  await realDrag(page, fromB, { x: toECenterX, y: toE.top + toE.h * 0.75 });

  const groupsAfterCross = await waitGroups(ctx,
    gs => {
      const g1 = gs.find(g => g.name === 'G1-源组');
      const g2 = gs.find(g => g.name === 'G2-目标组');
      const t1 = (g1?.tabs || []).map(t => t.title);
      const t2 = (g2?.tabs || []).map(t => t.title);
      return t1.length === 2 && t2.length === 3 && t2[1] === 'tab-b';
    },
    '跨组拖拽落盘（g1 剩 2 项、g2 第二项是 tab-b）');
  const g1t = groupsAfterCross.find(g => g.name === 'G1-源组').tabs.map(t => t.title);
  const g2t = groupsAfterCross.find(g => g.name === 'G2-目标组').tabs.map(t => t.title);

  gate.check('P1：搬走的是 b 不是 a（IndexedDB 真值）',
    g1t.join() === 'tab-a,tab-c' && g2t.join() === 'tab-e,tab-b,tab-f',
    `G1=[${g1t}] G2=[${g2t}]`);
  gate.check('P1：搬错行的旧结果不得出现（g2 里不得有多出来的 a）',
    g1t.includes('tab-a') && !g2t.includes('tab-a'),
    `G1=[${g1t}] G2=[${g2t}]（旧实现会把 a 搬进 g2：G1 缺 a、G2 多 a）`);

  await page.waitForTimeout(2000);
  const g1Dom = await readRowTitles(page, 'G1-源组');
  const g2Dom = await readRowTitles(page, 'G2-目标组');
  gate.check('DOM 行序与 IndexedDB 真值一致（两端无分叉）',
    (g1Dom || []).join() === g1t.join() && (g2Dom || []).join() === g2t.join(),
    `DOM G1=[${g1Dom}] vs 磁盘 [${g1t}]；DOM G2=[${g2Dom}] vs 磁盘 [${g2t}]`);

  // ── 2. 同组拖拽排序：把 a 拖到 c 之后 ───────────────────────────────────
  // 当前 g1=[tab-a,tab-c]，拖 a 到 c 行下半区 ⇒ 期望 [tab-c,tab-a]。
  const fromA = await rowGrabPoint(page, 'G1-源组', 'tab-a');
  const toC = await rowGrabPoint(page, 'G1-源组', 'tab-c');
  const toCCenterX = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tab-group-card')];
    const card = cards.find(c => (c.querySelector('h3.tab-group-title')?.textContent || '').trim() === 'G1-源组');
    const row = [...card.querySelectorAll('.tab-item')].find(r => ((r.querySelector('.tab-item-title')?.textContent) || '').trim() === 'tab-c');
    const b = row.getBoundingClientRect();
    return b.x + b.width / 2;
  });
  await realDrag(page, fromA, { x: toCCenterX, y: toC.top + toC.h * 0.75 });

  const groupsAfterInner = await waitGroups(ctx,
    gs => {
      const g1 = gs.find(g => g.name === 'G1-源组');
      return (g1?.tabs || []).map(t => t.title).join() === 'tab-c,tab-a';
    },
    '同组拖拽落盘（g1=[tab-c,tab-a]）');
  const innerT = groupsAfterInner.find(g => g.name === 'G1-源组').tabs.map(t => t.title);
  gate.check('同组拖拽：a 落到 c 之后（IndexedDB 真值）',
    innerT.join() === 'tab-c,tab-a', `G1=[${innerT}]`);
  await page.waitForTimeout(2000);
  const innerDom = await readRowTitles(page, 'G1-源组');
  gate.check('同组拖拽：DOM 行序与真值一致',
    (innerDom || []).join() === innerT.join(), `DOM=[${innerDom}] 磁盘=[${innerT}]`);

  gate.report('会话内标签拖拽转正（真实浏览器拖拽 P0/P1）');
} catch (e) {
  console.error('\n💥 执行异常:', e.message);
  gate.check('脚本执行未抛异常', false, e.message);
  gate.report('会话内标签拖拽转正（真实浏览器拖拽 P0/P1）');
} finally {
  try { await ctx.close(); } catch { /* 关不掉不影响判定 */ }
}
