/**
 * 双栏布局必须**按用户选的排序**摆（2026-10-23 审计 R-11）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 修复前双栏是「两列各一个 div」，按**标签数**贪心均衡分栏：
 *
 *   const columns = [[], []];        // 按标签数塞进更空的那一栏
 *
 * ⇒ 屏幕上的阅读顺序、**键盘 Tab 序**（= DOM 序 = 先走完左栏再走右栏）
 *   都**不等于**用户选的排序。
 * 审计穷举：6 个会话 × 标签数 {1,2,3,4} 共 4096 种组合，
 *   DOM 序与排序序 **100% 不一致**（4096/4096），逐行视觉序约 2/3 不一致。
 * 键盘用户与读屏用户拿到的顺序，和眼睛看到的**不一样** —— 比「视觉顺序错」更糟。
 *
 * ── 这条守卫钉的是三条性质 ───────────────────────────────────────────────
 *
 * ① **DOM 序 == 排序序**
 *   DOM 序 = 键盘 Tab 序 = 读屏顺序。排序是用户**显式**做的选择，
 *   它必须在**每一种**顺序通道里都成立。
 *
 * ② **两栏是「连续切一刀」，不是「轮流分」**
 *   网格的直接子项必须是**恰好两个** `.session-grid-column`，
 *   卡片住在栏里（不许直接当网格子项 —— 那样会被两两配成一行、撕出空白）。
 *   左栏在前、右栏在后 ⇒ 先读完左栏再读右栏 == 排序序。
 *   ⚠️ 这一条 2026-10-24 改过判据：原判据要求「卡片是网格的**直接**子项」，
 *   那是 1.26.0–1.28.0 那版行主序实现的形状；产品负责人判「每行留一大块空白」
 *   是缺陷 ⇒ 回到两栏堆叠。**顺序那条性质（①）一条没松**，
 *   变的是「靠什么布局来保住它」。
 *
 * ③ **网格是两列、行主序**
 *   两个栏道并排。列主序（`grid-auto-flow: column`）会让网格的自动放置
 *   与栏内堆叠打架，且视觉序与 DOM 序分家。
 *
 * ── 为什么必须渲染一遍 ────────────────────────────────────────────────────
 * 「排序算对了」与「列表按它摆了」是两件事（本仓 L-10 栽过一次）。
 * 旧实现的分栏函数在组件内部，源码里看着挺合理 —— 只有把渲染产物摊开，
 * 才知道 DOM 序到底是什么。
 *
 * ── fixture 的形状是**故意的** ────────────────────────────────────────────
 * 标签数按 3,1,3,1,3,1 排（名字序），这正是旧实现「按标签数均衡」会打乱顺序的形状：
 * 贪心分栏会把 [Charlie, Echo, Bravo] 塞进左栏、[Foxtrot, Alpha, Delta] 塞进右栏，
 * DOM 序变成 `Charlie → Echo → Bravo → Foxtrot → Alpha → Delta` —— 与排序序完全不同。
 * 而 store 里的数组顺序也**故意**不等于任何一种排序序 ⇒ 「忘了排序」也会被抓住。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGroups, renderTabList } from '../_helpers/tabListHarness.ts';
import { commonAncestor, findAll, classList, type HtmlElement } from '../_helpers/htmlTree.ts';
import { countGridTracks, parseCssRules } from '../_helpers/cssRules.ts';
import { SESSION_SORT_OPTIONS, sortSessions } from '@/core/sessionSort';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CSS_FILE = resolve(ROOT, 'src/styles/global.css');

/**
 * 判据用的会话。
 *
 * 名字按字母序、创建时间也按字母序 ⇒ 「按名称」与「按最近保存」给出不同顺序。
 * store 里的数组顺序（Charlie, Foxtrot, Alpha, Echo, Bravo, Delta）
 * **故意**不等于任何一种排序序 ⇒ 「根本没排」也会被抓住。
 */
const GROUPS = makeGroups([
  { id: 'g1', name: 'Alpha', tabCount: 3, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g2', name: 'Bravo', tabCount: 1, createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 'g3', name: 'Charlie', tabCount: 3, createdAt: '2026-01-03T00:00:00.000Z' },
  { id: 'g4', name: 'Delta', tabCount: 1, createdAt: '2026-01-04T00:00:00.000Z' },
  { id: 'g5', name: 'Echo', tabCount: 3, createdAt: '2026-01-05T00:00:00.000Z' },
  { id: 'g6', name: 'Foxtrot', tabCount: 1, createdAt: '2026-01-06T00:00:00.000Z' },
]);

/** 会话卡标题元素（DOM 事实：仓库里的真机脚本也按它定位）。 */
function isGroupTitle(element: HtmlElement): boolean {
  const id = element.attrs['id'];
  if (!id || !id.startsWith('tab-group-title-')) return false;
  return !id.slice('tab-group-title-'.length).includes('hint');
}

describe('双栏：屏幕顺序与键盘顺序都必须等于用户选的排序', () => {
  for (const option of SESSION_SORT_OPTIONS) {
    it(`按「${option.label}」排时，DOM 顺序必须等于排序后的顺序`, async () => {
      const rendered = await renderTabList({
        groups: GROUPS,
        layoutMode: 'double',
        sessionSort: option.value,
      });
      const expected = sortSessions(GROUPS, option.value).map(group => group.id);
      assert.deepEqual(
        rendered.groupIdOrder,
        expected,
        `按「${option.label}」排时，界面上会话卡的先后顺序必须就是排序结果 ——\n` +
          '  DOM 序 = 键盘 Tab 序 = 读屏顺序；它一旦与排序序分道扬镳，\n' +
          '  键盘用户拿到的顺序就和眼睛看到的、和用户选的都不一样。\n' +
          `  实际：${rendered.groupIdOrder.join(' → ')}\n` +
          `  应为：${expected.join(' → ')}`
      );
    });
  }

  it('会话卡必须住在**两栏各自的堆叠**里（不许直接当网格子项）', async () => {
    const rendered = await renderTabList({
      groups: GROUPS,
      layoutMode: 'double',
      sessionSort: 'name',
    });
    const titles = findAll(rendered.tree, isGroupTitle);
    assert.ok(titles.length > 0, '前置：双栏视图必须真的渲染出会话卡');
    const container = commonAncestor(titles);
    assert.ok(container, '会话卡必须有一个共同的容器（网格）');

    // ① 网格的直接子项恰好是两个栏容器。
    assert.equal(
      container.children.length,
      2,
      `网格容器的直接子元素必须是**恰好两个**栏容器（实际 ${container.children.length} 个）——\n` +
        '  卡片直接当网格子项会按行两两配对：同一行里一高一矮，短的那张下面\n' +
        '  必然空出一大块（实测 174px/行），这就是 2026-10-24 被判缺陷的那个洞。'
    );
    const columns = container.children;
    for (const [index, column] of columns.entries()) {
      assert.ok(
        classList(column).includes('session-grid-column'),
        `第 ${index + 1} 个栏容器必须带 .session-grid-column 类名` +
          `（实际 class="${column.attrs['class'] ?? ''}"）—— 那是给它的纵向堆叠样式挂钩的`
      );
    }

    // ② 每一栏里，一个直接子项 = 一张卡（而不是一张卡里塞好几张、或一张卡都没包）。
    const cardsPerColumn = columns.map(column => column.children.map(card => findAll(card, isGroupTitle)));
    for (const [index, cards] of cardsPerColumn.entries()) {
      for (const [cardIndex, found] of cards.entries()) {
        assert.equal(
          found.length,
          1,
          `第 ${index + 1} 栏的第 ${cardIndex + 1} 个直接子项里必须**恰好**是一张会话卡` +
            `（实际找到 ${found.length} 个标题元素）`
        );
      }
    }

    // ③ 左栏在前、右栏在后 ⇒ 先读完左栏再读右栏 == DOM 序 == 排序序。
    const cardsInColumns = cardsPerColumn.flat(2);
    assert.equal(
      cardsInColumns.length,
      titles.length,
      `两栏里的会话卡总数必须等于渲染出的卡片数（${cardsInColumns.length} vs ${titles.length}）—— ` +
        '少了说明有卡落在栏外，多了说明有卡被渲染了两次'
    );
    const expected = sortSessions(GROUPS, 'name').map(group => group.id);
    assert.deepEqual(
      cardsInColumns.map(title => String(title.attrs['id']).slice('tab-group-title-'.length)),
      expected,
      '按栏拆开再按「先左栏、后右栏」拼回来，顺序必须仍是排序序 —— ' +
        '否则「两栏堆叠」就会像旧版贪心分栏那样把顺序打乱'
    );
  });

  it('网格必须**两列、行主序**（否则视觉逐行序 ≠ DOM 序）', async () => {
    const rendered = await renderTabList({
      groups: GROUPS,
      layoutMode: 'double',
      sessionSort: 'name',
    });
    const titles = findAll(rendered.tree, isGroupTitle);
    const container = commonAncestor(titles);
    assert.ok(container, '前置：会话卡必须有一个共同的容器');
    const classes = classList(container);
    assert.ok(classes.length > 0, '前置：容器必须带类名（否则读不到它的布局规则）');

    const rules = parseCssRules(readFileSync(CSS_FILE, 'utf8'));
    const own = rules.filter(rule =>
      rule.selectors.some(selector =>
        classes.some(name => selector.includes(`.${name}`))
      )
    );
    assert.ok(own.length > 0, `找不到容器（class="${classes.join(' ')}"）的样式规则`);

    assert.ok(
      own.some(rule => rule.declarations['display'] === 'grid'),
      '会话卡的容器必须是 grid 布局（否则「两列」无从谈起）'
    );

    const trackCounts = own
      .map(rule => rule.declarations['grid-template-columns'])
      .filter((value): value is string => typeof value === 'string')
      .map(countGridTracks);
    assert.ok(trackCounts.length > 0, '容器必须声明 grid-template-columns');
    assert.equal(
      Math.max(...trackCounts),
      2,
      `双栏布局必须正好是两列（读到 ${trackCounts.join(' / ')}）—— ` +
        '列数变了，「双栏」这个布局模式就名不副实'
    );

    assert.ok(
      !own.some(rule => (rule.declarations['grid-auto-flow'] ?? '').includes('column')),
      '网格不许按列主序流动（grid-auto-flow: column）—— ' +
        '那样视觉顺序会变成「先走完第一列」，与 DOM 序（= 键盘序）分道扬镳'
    );
  });

  it('单栏布局走的是同一条排序数据流（顺序也必须对）', async () => {
    const rendered = await renderTabList({
      groups: GROUPS,
      layoutMode: 'single',
      sessionSort: 'size',
    });
    const expected = sortSessions(GROUPS, 'size').map(group => group.id);
    assert.deepEqual(
      rendered.groupIdOrder,
      expected,
      '单栏视图也必须按用户选的排序摆（两种布局共用同一条排序数据流）'
    );
  });
});
