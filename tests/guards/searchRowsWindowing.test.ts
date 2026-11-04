/**
 * 搜索结果卡里的命中行必须**按结果卡懒渲染**（2026-11-03；2026-11-04 校正命名）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 搜索结果的「条数上限」（`buildResultWindow`）按**整个会话组**保留：
 * 一个会话命中 800 条时，第一次 `used >= visible` 要等这一组**整组**计入
 * 之后才成立 ⇒ 那 800 行仍会一次全部进 DOM。数据结构一旦是「少数会话、
 * 每个会话命中很多条」，上限就管不住渲染量。
 *
 * 修法：每张结果卡的命中行接到与主列表**同一个**懒渲染机制
 * （`useNearViewport` + `resolveRowWindow` + 运行时量出来的行距）——
 * 远端卡只留等高占位，滚进视口附近才挂载真行。
 *
 * ⚠️ 这是**卡级**，不是行级：近端卡会挂载该组全部命中行（见文件末尾的
 * 「已知边界」用例）。标题与注释不许再声称「单组行数有上界」。
 *
 * ── 为什么在 SSR 里断言，而不是读源码 ────────────────────────────────────
 *
 * 「源码里出现了 resolveRowWindow」不等于「渲染出来的 DOM 真的少了」——
 * 本仓的接线守卫吃过这个亏（见 tabListHarness.ts 的开头）。
 * SSR 不跑 effect ⇒ `useNearViewport` 的初值就是可见性取值：
 *   · 装了 IntersectionObserver ⇒ 初值 false ⇒ **远端卡**分支 ⇒ 只该剩占位；
 *   · 没装 ⇒ 初值 true ⇒ **降级**分支 ⇒ 必须渲染真行（列表不能是空的）。
 * 两个分支都能从渲染产物上直接读出来。
 *
 * 变异自证见 tests/guards/searchRowsWindowingMutation.test.ts。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { findAll, type HtmlElement } from '../_helpers/htmlTree.ts';
import { makeGroups, renderTabList } from '../_helpers/tabListHarness.ts';
import { ROW_STRIDE_FALLBACK_PX } from '@/components/tabs/cardMetrics';

const ORIGINAL_IO = (globalThis as Record<string, unknown>)['IntersectionObserver'];

/** 装一个假的 IntersectionObserver：只为了让「是否存在」这个判断为真。 */
function installFakeIntersectionObserver(): void {
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  }
  (globalThis as Record<string, unknown>)['IntersectionObserver'] = FakeIntersectionObserver;
}

function removeIntersectionObserver(): void {
  delete (globalThis as Record<string, unknown>)['IntersectionObserver'];
}

afterEach(() => {
  if (ORIGINAL_IO === undefined) removeIntersectionObserver();
  else (globalThis as Record<string, unknown>)['IntersectionObserver'] = ORIGINAL_IO;
});

/**
 * 渲染搜索结果，吞掉 React 的 SSR 告警。
 *
 * `useNearViewport` 里是 `useLayoutEffect` ⇒ SSR 会为每个卡片实例打一条
 * 「useLayoutEffect does nothing on the server」。几百张卡会让 stdout 爆掉，
 * 变异沙箱的 execFileSync 撞上 1MB maxBuffer ⇒ 子进程被杀 ⇒ 假红。
 * 只吞这一条，其它一律透传。
 */
async function renderSearch(groups: ReturnType<typeof makeGroups>) {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(a => String(a)).join(' ');
    if (text.includes('useLayoutEffect does nothing on the server')) return;
    original(...args);
  };
  try {
    return await renderTabList({ groups, searchQuery: 'page' });
  } finally {
    console.error = original;
  }
}

/** 真的标签行（类名**精确**含 `tab-item`；`tab-item-body` 之类不算）。 */
const readRows = (tree: HtmlElement) =>
  findAll(tree, el => (el.attrs['class'] ?? '').split(/\s+/).includes('tab-item'));

/** 组内行占位（与主列表同一个约定 `data-lazy-placeholder`）。 */
const readRowPlaceholders = (tree: HtmlElement) =>
  findAll(tree, el => el.attrs['data-lazy-placeholder'] === 'true');

/** 结果卡身份：恢复按钮的 data-testid（每张卡恰好一个）。 */
const readCards = (tree: HtmlElement) =>
  findAll(tree, el => (el.attrs['data-testid'] ?? '').startsWith('search-restore-session-'));

function readHeight(el: HtmlElement): number {
  const style = el.attrs['style'] ?? '';
  const m = /height:\s*([0-9.]+)px/.exec(style);
  assert.ok(m, `占位必须有显式高度，实际 style="${style}"`);
  return Number(m![1]);
}

describe('搜索结果：结果卡按视口懒渲染（卡级，不是行级）', () => {
  it('远端结果卡只留等高占位（卡头有上限，行不随数据量进 DOM）', async () => {
    installFakeIntersectionObserver();
    // 600 组各命中 1 条 ⇒ 上限保留 200 组；如果上限失效，这里会是 600 张卡。
    const { tree, text, html } = await renderSearch(makeGroups(Array.from({ length: 600 }, (_, i) => ({
      id: `g${i}`,
      name: `会话 ${i}`,
      tabCount: 1,
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    }))));

    assert.equal(
      readCards(tree).length,
      200,
      '结果卡数量必须被上限截断（不能随匹配组数增长）'
    );
    assert.ok(
      !html.includes('contain-intrinsic-size'),
      '搜索结果卡不得用固定值的 contain-intrinsic-size 估计高度 —— ' +
        '它会让卡滚进视口时高度突变（占位必须由「行数 × 行距」决定）'
    );
    assert.equal(
      readRows(tree).length,
      0,
      '远端结果卡不许挂载标签行（应只留等高占位）'
    );
    assert.equal(
      readRowPlaceholders(tree).length,
      200,
      '每一个被保留的结果卡都必须有占位撑住高度'
    );
    for (const el of readRowPlaceholders(tree)) {
      assert.ok(readHeight(el) > 0, '占位高度必须为正（0 = 内容凭空消失）');
    }
    // 截断必须说清「还有多少」—— 与条数上限同一条诚实约束。
    assert.match(text, /还有 400 条匹配结果未显示/, '截断时必须说清还有多少条没显示');
  });

  it('占位高度必须是「命中行数 × 行距」', async () => {
    installFakeIntersectionObserver();
    const { tree } = await renderSearch(
      makeGroups([
        { id: 'a', name: 'A', tabCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', name: 'B', tabCount: 2, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c', name: 'C', tabCount: 5, createdAt: '2026-01-01T00:00:00.000Z' },
      ])
    );

    const heights = readRowPlaceholders(tree).map(readHeight).sort((x, y) => x - y);
    // 期望值用**共享的行距真值源**算（而不是在这里写死 44/37）：
    // 它钉的是「占位 = 行数 × 行距」这条关系，不是某个版本的样式数值。
    const stride = ROW_STRIDE_FALLBACK_PX;
    assert.deepEqual(
      heights,
      [1 * stride, 2 * stride, 5 * stride],
      '占位高度必须是「命中行数 × 行距」（与主列表同一份真值源）'
    );
  });

  it('降级路径：没有 IntersectionObserver 时必须渲染真行（结果不能是空的）', async () => {
    removeIntersectionObserver();
    const { tree } = await renderSearch(makeGroups(Array.from({ length: 250 }, (_, i) => ({
      id: `d${i}`,
      name: `会话 ${i}`,
      tabCount: 1,
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    }))));

    assert.equal(
      readCards(tree).length,
      200,
      '降级路径下卡数仍必须受上限约束'
    );
    assert.equal(
      readRows(tree).length,
      200,
      '降级路径失效：量不到可见性时必须渲染真行（最多慢一点，不能空白）'
    );
    assert.equal(readRowPlaceholders(tree).length, 0, '降级路径下不应有占位');
  });

  it('已知边界：近端单组仍渲染该组全部命中行（卡级，不是行级窗口化）', async () => {
    // 没有 IntersectionObserver ⇒ useNearViewport 的初值是 true（降级=全量渲染），
    // 等价于「这张卡就在视口附近」。一个组 300 条命中时：
    //   · 条数上限按整组保留 ⇒ 这一组全部留下；
    //   · 卡在近端 ⇒ 它的全部命中行都要挂载。
    // 这条**故意**钉住当前边界，防止有人把「远端卡不挂载」误读成「单组行数有上界」。
    removeIntersectionObserver();
    const { tree } = await renderSearch(makeGroups([
      { id: 'huge', name: 'Huge', tabCount: 300, createdAt: '2026-01-01T00:00:00.000Z' },
    ]));

    assert.equal(readCards(tree).length, 1, '这一组必须被保留');
    assert.equal(
      readRows(tree).length,
      300,
      '近端单组必须渲染全部命中行（当前边界；做行级窗口化时再改这条判据）'
    );
    assert.equal(readRowPlaceholders(tree).length, 0, '近端卡不应有占位');
  });
});
