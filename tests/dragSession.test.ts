// 拖拽会话（源下标唯一来源）与 hover 决策的纯逻辑单测。
//
// 【为什么本文件存在】此前 18 条拖拽测试全是「纯逻辑」（键盘决策表、applyMoveTab
// 语义、源码正则守卫），结构性缺口有二：
//   1. 源行下标的解析**从未被测过**：组件把源下标存在行级 ref 上（无条件覆写成
//      落点行下标），测试却只断言了「目标下标越界被夹住」这类与源无关的语义 ——
//      「拖 b 搬走 a」的静默数据损坏在全绿中通过。
//   2. 单元素源组的断言只看剩余结果：搬对行与搬错行的最终数组完全相同
//      （g1 只剩 b vs 只剩 a —— 不对，是 g1=[b,c] 剩 2 个 vs 搬错时 g1=[b,c]
//      同样剩 2 个？不：单元素源组 g1=[x]，搬对搬错都剩 []，剩余数组**完全相同**），
//      必须校验被移动实体的 id 才能区分。
//
// fixture 刻意造脏形状：相邻行、跨组落点在下标 0、单元素源组、非等长组、
// 一次拖拽多次换位、双栏 layoutMode。用 resolveHover 纯函数直测 ——
// 它是源下标的唯一解析点（组件里没有第二份），测它 = 测真实路径。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbHciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const sessionOf = () => import('@/components/dnd/dragSession');

// 每行高 40px 的矩形（hover 中点 = 20）
const ROW = { top: 0, bottom: 40 };
// 落到目标行下半区（clientY=30 > 中点 20，hoverPercentage=+0.5）：同组往下拖换位
const LOWER = 30;
// 落到目标行上半区（clientY=10 < 中点 20，hoverPercentage=-0.5）：同组往上拖换位
const UPPER = 10;

describe('拖拽会话：源下标只有一个来源（会话锚点），不在任何行上', () => {
  it('beginDragSession 记住 dragstart 那一行的下标，不同行读到的是同一份', async () => {
    const { beginDragSession, getDragSession } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 1, tabId: 'b' });
    // 落点行读到的源下标必须是 1（被拖行 b），不是落点自己的下标
    assert.equal(getDragSession()?.anchor.index, 1);
    assert.equal(getDragSession()?.anchor.groupId, 'g1');
    // origin 是 dragstart 当刻的实况（回弹/审计用），换位不改它
    assert.deepEqual(getDragSession()?.origin, { groupId: 'g1', index: 1, tabId: 'b' });
  });

  it('换位后 advanceDragAnchor 回写：被拖行的新位置 = 落点坐标（精确值）', async () => {
    const { beginDragSession, getDragSession, advanceDragAnchor } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 1, tabId: 'b' });
    advanceDragAnchor({ groupId: 'g2', index: 0 });
    assert.deepEqual(getDragSession()?.anchor, { groupId: 'g2', index: 0 });
    // origin 不动：它永远是「从哪出发」，anchor 才是「现在在哪」
    assert.equal(getDragSession()?.origin.index, 1);
  });

  it('endDragSession 无条件关闭：下一次拖拽不能读到上一次的源下标', async () => {
    const { beginDragSession, getDragSession, endDragSession } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 2, tabId: 'c' });
    endDragSession();
    assert.equal(getDragSession(), null);
    // 不在拖拽中时 resolveHover 一律不换位（落点行再 hover 也不该动）
    const { resolveHover } = await sessionOf();
    const d = resolveHover(null, { groupId: 'g1', index: 0 }, {
      rect: ROW, clientY: LOWER,
    });
    assert.equal(d, null);
  });
});

describe('resolveHover：P1 现场 —— 跨组落到下标 0，必须搬走被拖的那行', () => {
  it('g1=[a,b,c]、g2=[e,f]，拖 b(g1 idx1) 到 g2 的 e(idx0)：moveTab 第一个参数是 1 不是 0', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 1, tabId: 'b' });
    const d = resolveHover(getDragSession(), { groupId: 'g2', index: 0 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.ok(d, '跨组落到下标 0 必须换位');
    assert.equal(d.sourceIndex, 1, 'P1 回归：源下标必须是被拖行 b 的 1，不是落点行 e 的 0');
    assert.equal(d.sourceGroupId, 'g1');
    assert.equal(d.targetGroupId, 'g2');
    assert.equal(d.targetIndex, 0);
  });

  it('相邻行：sourceIndex 必须 ≠ targetIndex（落点行自己的下标不能当源用）', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    // 拖 a(idx0) 到 b(idx1)：落点行 b 的下标是 1，源必须是 0
    beginDragSession({ groupId: 'g1', index: 0, tabId: 'a' });
    const d = resolveHover(getDragSession(), { groupId: 'g1', index: 1 }, {
      rect: ROW, clientY: LOWER,
    });
    assert.ok(d, '相邻下移必须换位');
    assert.equal(d.sourceIndex, 0);
    assert.notEqual(d.sourceIndex, d.targetIndex, '源与目标不能是同一行');
  });

  it('单元素源组 g1=[x] → g2：必须校验被移动实体的身份（只断剩余数组抓不住搬错行）', async () => {
    // 旧测试 :118-127 只断言 groups.length===1：单元素源组下搬错行与搬对行的
    // 最终数组完全相同（源组都是 [] 被移除，目标组都多一项）—— 断言恒真。
    // 这里钉住「被移动实体」的身份：源下标 + applyMoveTab 落盘结果一起验。
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    const { applyMoveTab } = await import('@/core/mutationOps');
    beginDragSession({ groupId: 'g1', index: 0, tabId: 'x' });
    const d = resolveHover(getDragSession(), { groupId: 'g2', index: 0 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.ok(d);
    assert.equal(d.sourceIndex, 0);
    // 用决策参数真实走一遍 applyMoveTab：被搬走的必须是 x
    const g = (id: string, tabIds: string[]) => ({
      id, name: id, tabs: tabIds.map(t => ({ id: t, title: t, url: `https://${t}.x/`, favicon: '' })),
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      isLocked: false, version: 1,
    });
    const r = applyMoveTab(
      [g('g1', ['x']), g('g2', ['c'])] as never,
      { sourceGroupId: d.sourceGroupId, sourceIndex: d.sourceIndex, targetGroupId: d.targetGroupId, targetIndex: d.targetIndex },
      '2026-06-01T00:00:00.000Z',
      { s: 1, d: 'device-1' }
    );
    const moved = r.groups.find(x => x.id === 'g2')!.tabs.map(t => t.id);
    assert.ok(moved.includes('x'), `被移动实体必须是 x，实际 g2=${JSON.stringify(moved)}`);
  });

  it('非等长组 g1=[a,b,c,d,e]、g2=[x]：源下标不受目标组长度影响', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 4, tabId: 'e' });
    const d = resolveHover(getDragSession(), { groupId: 'g2', index: 0 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.ok(d);
    assert.equal(d.sourceIndex, 4, '源下标是被拖行的位置，与目标组只有 1 行无关');
  });

  it('一次拖拽多次换位：锚点跟随被拖行，序列是 [(0→2),(2→1)] 而非只看末态', async () => {
    // P1 的第二现场：同一次拖拽 hover 回原组时无第二条 move、状态卡死。
    // 根因是源下标没跟上第一次换位。这里模拟「换位→回写→再换位」的完整序列，
    // 每一步的源下标都必须等于上一步的落点。
    const { beginDragSession, getDragSession, advanceDragAnchor, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 0, tabId: 'a' });
    const calls: Array<[number, number]> = [];
    // 第一次：a(0) → idx2
    const d1 = resolveHover(getDragSession(), { groupId: 'g1', index: 2 }, {
      rect: ROW, clientY: LOWER,
    });
    assert.ok(d1, '第一次换位必须发生');
    calls.push([d1.sourceIndex, d1.targetIndex]);
    advanceDragAnchor({ groupId: 'g1', index: 2 });
    // 第二次：a 现在在 idx2，hover 回 idx1
    const d2 = resolveHover(getDragSession(), { groupId: 'g1', index: 1 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.ok(d2, '第二次换位必须发生（旧实现在这里卡死：无第二条 move）');
    calls.push([d2.sourceIndex, d2.targetIndex]);
    assert.deepEqual(calls, [[0, 2], [2, 1]], '源下标必须跟随被拖行，不能停在最初的 0');
  });

  it('双栏 layoutMode=double：取的是组内下标，不是列内序号', async () => {
    // 双栏只是把组切成左右两列渲染（TabList.tsx:157 的 md:grid-cols-2 是刻意的，
    // 不要动），行的 groupId/index 语义不变。这里钉住：即使落点行在右栏第 0 位，
    // 决策用的 targetIndex 仍是它在组内的下标。
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 1, tabId: 'b' });
    // g2 组内有 3 行，右栏第 0 位 = 组内 idx2
    const d = resolveHover(getDragSession(), { groupId: 'g2', index: 2 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.ok(d);
    assert.equal(d.sourceIndex, 1, '源仍是被拖行 b');
    assert.equal(d.targetIndex, 2, '目标是组内下标 2，不是列内序号 0');
  });
});

describe('resolveHover：不换位的边界（抖动守卫与自环）', () => {
  it('就在自己身上：同组同下标不换位', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 1, tabId: 'b' });
    const d = resolveHover(getDragSession(), { groupId: 'g1', index: 1 }, {
      rect: ROW, clientY: LOWER,
    });
    assert.equal(d, null);
  });

  it('同组往下拖、落在目标行上半区：不换位（防抖动，与原实现同阈值）', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 0, tabId: 'a' });
    // hoverPercentage = (10-20)/20 = -0.5 < -0.2 ⇒ 挡住
    const d = resolveHover(getDragSession(), { groupId: 'g1', index: 1 }, {
      rect: ROW, clientY: UPPER,
    });
    assert.equal(d, null);
  });

  it('同组往上拖、落在目标行下半区：不换位', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 2, tabId: 'c' });
    // hoverPercentage = (30-20)/20 = +0.5 > +0.2 ⇒ 挡住
    const d = resolveHover(getDragSession(), { groupId: 'g1', index: 1 }, {
      rect: ROW, clientY: LOWER,
    });
    assert.equal(d, null);
  });

  it('落点行未挂载（rect=null）：不换位', async () => {
    const { beginDragSession, getDragSession, resolveHover } = await sessionOf();
    beginDragSession({ groupId: 'g1', index: 0, tabId: 'a' });
    const d = resolveHover(getDragSession(), { groupId: 'g2', index: 0 }, {
      rect: null, clientY: UPPER,
    });
    assert.equal(d, null);
  });
});

describe('载荷来源单一化：dragover 不再读 dataTransfer（P0 的结构保证）', () => {
  it('DraggableTab 不再调用 getData / setData 私有载荷（只留 text/plain）', async () => {
    // 这是结构断言，不是行为断言 —— 但它钉的是 P0 的根因本身：
    // 只要 dragover 里还有 getData，就还有一条「读不到就 return」的死路。
    // 行为侧由 e2e 对照断言覆盖（真实 dragover 阶段 getData 返回 ""）。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/components/dnd/DraggableTab.tsx'), 'utf8');
    const code = src.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    }).join('\n');
    assert.doesNotMatch(code, /getData\(/, 'dragover/dragenter 不得再读 dataTransfer（受保护模式读不到）');
    assert.doesNotMatch(code, /application\/x-tapstack-tab/, '私有 MIME 已退场：载荷只走 dragSession 这个 JS 变量');
    assert.doesNotMatch(code, /dragIndexRef/, '行级源下标 ref 已退场：源下标只有拖拽会话一个来源');
    assert.match(code, /getDragSession\(\)/, 'dragover 必须从拖拽会话读源下标');
    assert.match(code, /beginDragSession\(/, 'dragstart 必须开启拖拽会话');
    assert.match(code, /endDragSession\(\)/, 'dragend/drop 必须关闭拖拽会话');
  });

  it('HoverProbe 不得再有 sourceGroupId / sourceIndex / targetIndex（P1 的结构保证）', async () => {
    // 2026-10-11 P1：这三个字段曾是「源下标的第二个来源」，而 resolveHover 从不读
    // 它们 —— 是死字段。留着它们有具体的危害，测试必须钉住它们**不再存在**：
    //   · 调用方要为死字段编值，而实测编的是**落点行**的下标（正是 P1 的取值）；
    //   · 将来谁「顺手」让 resolveHover 改读这两个字段，测试照样全绿，
    //     而 P1 以「拖 b 搬走 a」的形态复活 —— 经 applyMoveTab 正常落盘并
    //     上传云端的静默数据损坏（无回收站、无撤销）。
    // 删字段（而不是加注释提醒）是唯一可靠的防线：让第二个来源在类型层面不存在。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath: f2p } = await import('node:url');
    const { dirname: dn, resolve: rs } = await import('node:path');
    const here = dn(f2p(import.meta.url));
    const src = readFileSync(rs(here, '../src/components/dnd/dragSession.ts'), 'utf8');

    // 1) 形状层：HoverProbe 只剩 rect + clientY
    const probeBlock = src.slice(src.indexOf('export interface HoverProbe'));
    const probeBody = probeBlock.slice(0, probeBlock.indexOf('\n}'));
    assert.doesNotMatch(probeBody, /sourceGroupId/, 'HoverProbe 不得再持有 sourceGroupId');
    assert.doesNotMatch(probeBody, /sourceIndex/, 'HoverProbe 不得再持有 sourceIndex');
    assert.doesNotMatch(probeBody, /targetIndex/, 'HoverProbe 不得再持有 targetIndex（与 target.index 重复）');
    assert.match(probeBody, /rect:/, 'HoverProbe 必须保留 rect');
    assert.match(probeBody, /clientY:/, 'HoverProbe 必须保留 clientY');

    // 2) 实现层：resolveHover 不读 probe 上的任何源/目标下标（唯一来源 = session.anchor / target）
    const body = src.slice(src.indexOf('export const resolveHover'));
    assert.doesNotMatch(body, /probe\.source/, 'resolveHover 不得读 probe.source*');
    assert.doesNotMatch(body, /probe\.targetIndex/, 'resolveHover 不得读 probe.targetIndex');
    assert.match(body, /session\.anchor\.groupId/, '源组必须来自会话锚点');
    assert.match(body, /session\.anchor\.index/, '源下标必须来自会话锚点');

    // 3) 调用方层：DraggableTab 构造探针时不得再传这三个字段
    const comp = readFileSync(rs(here, '../src/components/dnd/DraggableTab.tsx'), 'utf8');
    const probeCall = comp.slice(comp.indexOf('resolveHover(session'));
    assert.doesNotMatch(
      probeCall.slice(0, probeCall.indexOf(');')),
      /sourceGroupId|sourceIndex|targetIndex/,
      'DraggableTab 构造探针时不得再传源/目标下标（它们只有会话与 target 一处来源）'
    );
  });
});
