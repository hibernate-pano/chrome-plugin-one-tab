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
 * ② **会话卡是网格的直接子项**
 *   卡片一旦被塞进「列容器」里，网格就会先摆列容器 ⇒ 顺序被列的边界重排。
 *   （旧实现正是这样：网格的两个直接子项是那两个列容器。）
 *
 * ③ **网格是两列、行主序**
 *   两列行主序 ⇒ 视觉逐行序 == DOM 序。列主序（`grid-auto-flow: column`）
 *   会让视觉序变成「先走完第一列」⇒ 与 DOM 序分道扬镳。
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

  it('会话卡必须是网格容器的**直接子项**（不能被塞进列容器）', async () => {
    const rendered = await renderTabList({
      groups: GROUPS,
      layoutMode: 'double',
      sessionSort: 'name',
    });
    const titles = findAll(rendered.tree, isGroupTitle);
    assert.ok(titles.length > 0, '前置：双栏视图必须真的渲染出会话卡');
    const container = commonAncestor(titles);
    assert.ok(container, '会话卡必须有一个共同的容器（网格）');
    assert.equal(
      container.children.length,
      titles.length,
      `网格容器的直接子元素必须**恰好**是这些会话卡（实际 ${container.children.length} 个 / ` +
        `${titles.length} 张卡）——\n` +
        '  卡片一旦被包进「列容器」，网格就先摆列容器 ⇒ 顺序被列的边界重排，\n' +
        '  于是 DOM 序（= 键盘序）不再等于排序序。'
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
