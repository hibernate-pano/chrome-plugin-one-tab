/**
 * PERF-03：会话卡的**窗口化**（2026-10-24 审计）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * 1000 个会话 ⇒ 1000 张卡**全部挂载**（每张卡头约 45 个 DOM 节点）
 * ⇒ 45,220～47,343 个 DOM 节点、**一条 1.46～1.63 秒的长任务**占住主线程，
 * 期间列表一帧不出、点不动（实测，真 Chrome + 真实产物）。
 *
 * 修法：**远离视口的卡整张只留一个等高占位**（内容不挂载）。
 *
 * ── 为什么这个守卫要在 SSR 里做 ──────────────────────────────────────────
 *
 * 本仓没有 jsdom / happy-dom（见 package.json），只有 `react-dom/server`。
 * SSR 的一个硬限制：**不跑 effect** ⇒ IntersectionObserver 的回调不会来 ⇒
 * `useNearViewport` 的初值（`typeof IntersectionObserver === 'undefined'`）
 * 就是「是否接近视口」的取值。
 *
 * ⇒ 这正好让本守卫能把两条分支分别钉住：
 *   · 装了 IntersectionObserver ⇒ 初值 false ⇒ **远卡**分支 ⇒ 只剩占位；
 *   · 没装 ⇒ 初值 true ⇒ **近卡/降级**分支 ⇒ 渲染真卡。
 *
 * ⚠️ 这条守卫**不**声称「生产环境里真实卡片数是 0」：真浏览器里
 * `useLayoutEffect` 会在绘制前同步量一次，首屏的卡是**真卡**。
 * 这里的判据是「分支对不对」，「真卡有多少张」由另外两处保证：
 *   · ① `measureNear` 的提前量有界（下面第三条）⇒ 真卡数有上界；
 *   · ② 真机基线（scripts/perf03-card-window-probe.mjs）：
 *      1000 会话 ⇒ DOM 节点 45,220 → 1,073、真卡 4 张、长任务 1.46s → 0。
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { findAll } from '../_helpers/htmlTree.ts';
import { makeGroups, renderTabList, type GroupSpec } from '../_helpers/tabListHarness.ts';
import { measureNear } from '@/hooks/useNearViewport';
import { cardHeightFor } from '@/components/tabs/cardMetrics';

/** 真机实测：默认主题、视口 1280×800（scripts/perf03-card-window-probe.mjs）。 */
const MEASURED_HEADER_PX = 53;
const MEASURED_STRIDE_PX = 58;

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

/** 造一批会话：标签数各不相同（这样高度才可区分）。 */
function specs(count: number, tabCounts: number[]): GroupSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    name: `会话 ${i}`,
    tabCount: tabCounts[i % tabCounts.length],
    createdAt: new Date(1700000000000 + i * 1000).toISOString(),
  }));
}

/** 从 SSR 产物里读出卡片占位（`data-card-skeleton="true"`）。 */
function readSkeletons(tree: ReturnType<typeof import('../_helpers/htmlTree.ts')['parseHtml']>) {
  return findAll(tree, el => el.attrs['data-card-skeleton'] === 'true');
}

/** 从 SSR 产物里读出「真卡」（有 .tab-group-card 类、但不是占位）。 */
function readRealCards(tree: ReturnType<typeof import('../_helpers/htmlTree.ts')['parseHtml']>) {
  return findAll(
    tree,
    el =>
      (el.attrs['class'] ?? '').split(/\s+/).includes('tab-group-card') &&
      el.attrs['data-card-skeleton'] !== 'true'
  );
}

/** 读占位 div 上的 `height: Npx`。 */
function readHeight(el: { attrs: Record<string, string> }): number {
  const style = el.attrs['style'] ?? '';
  const m = /height:\s*([0-9.]+)px/.exec(style);
  assert.ok(m, `占位必须有显式高度，实际 style="${style}"`);
  return Number(m![1]);
}

/**
 * 渲染，但**吞掉 React 的 SSR 警告**。
 *
 * 为什么：React 在服务端渲染时会为**每一个** `useLayoutEffect` 组件实例打一条
 * 「useLayoutEffect does nothing on the server」警告（本列表里每张卡都有好几个）
 * ⇒ 1000 张卡 ⇒ 几 MB 的 stdout ⇒ 变异沙箱的 `execFileSync` 撞上 1MB 的
 * maxBuffer ⇒ 子进程被杀 ⇒ **对照组假红**（看起来像守卫坏了，其实是输出爆了）。
 *
 * 只吞这一条；其它 console.error 一律原样透传（真错误不许被吞）。
 */
async function renderQuietly(options: Parameters<typeof renderTabList>[0]) {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(a => String(a)).join(' ');
    if (text.includes('useLayoutEffect does nothing on the server')) return;
    original(...args);
  };
  try {
    return await renderTabList(options);
  } finally {
    console.error = original;
  }
}

describe('PERF-03：远离视口的卡只留等高占位', () => {
  it('1000 个会话时，远卡**不挂载内容**（DOM 里是 1000 个等高占位，0 张真卡）', async () => {
    installFakeIntersectionObserver();
    const groups = makeGroups(specs(1000, [3, 5, 8, 13]));
    const { tree } = await renderQuietly({ groups });

    const skeletons = readSkeletons(tree);
    const realCards = readRealCards(tree);

    assert.equal(
      skeletons.length,
      1000,
      '窗口化失效：远离视口的卡必须只留等高占位（不该挂载卡头与标签行）'
    );
    assert.equal(
      realCards.length,
      0,
      '窗口化失效：远离视口的卡不许渲染真卡（否则 1000 张卡会全部挂载）'
    );
  });

  it('占位高度 = 边框 + 卡头 + 行数 × 行距（不是 0，也不是拍脑袋的数）', async () => {
    installFakeIntersectionObserver();
    const groups = makeGroups(specs(1000, [3, 5, 8, 13]));
    const { tree } = await renderQuietly({ groups });

    const skeletons = readSkeletons(tree);

    // 期望高度用**真机实测的绝对值**算，不用「组件当前用的那个值」——
    // 否则这条断言只是把组件的输出和它自己比（零检测力）。
    //
    // 实测样本（真 Chrome + 真实产物，scripts/perf03-card-window-probe.mjs，
    // 2026-10-24，默认主题、视口 1280×800）：
    //   卡头 53px、真实行距 58px（行盒 54 + 下外边距 4）、边框 2px。
    const expected = new Set(
      groups.map(g => cardHeightFor(g.tabs.length, MEASURED_HEADER_PX, MEASURED_STRIDE_PX, false))
    );
    const actual = new Set(skeletons.map(readHeight));

    assert.deepEqual(
      [...actual].sort((a, b) => a - b),
      [...expected].sort((a, b) => a - b),
      '占位高度必须由「行数 × 量出来的行距」算出来，且每个高度都要有对应的会话'
    );
    for (const el of skeletons) {
      assert.ok(readHeight(el) > 0, '占位高度必须为正（0 = 内容凭空消失）');
    }
  });

  it('降级路径：没有 IntersectionObserver 时必须渲染真卡（列表绝不能是空的）', async () => {
    removeIntersectionObserver();
    const groups = makeGroups(specs(100, [4]));
    const { tree } = await renderQuietly({ groups });

    assert.equal(
      readSkeletons(tree).length,
      0,
      '降级路径失效：量不到可见性时必须渲染真内容（最多慢一点）'
    );
    assert.equal(
      readRealCards(tree).length,
      100,
      '降级路径失效：没有 IntersectionObserver 时必须渲染真卡（列表不能是空的）'
    );
  });

  it('「真卡有多少张」有上界：提前量固定 ⇒ 真卡数不随会话总数增长', () => {
    const globalRef = globalThis as Record<string, unknown>;
    const win = (globalRef['window'] ?? {}) as Record<string, unknown>;
    win['innerHeight'] = 800;

    const cardAt = (top: number) =>
      ({
        getBoundingClientRect: () => ({ top, bottom: top + 345 }),
      }) as unknown as Element;

    // 视口 800 + 提前量 600 ⇒ 1400 以内的卡算「近」。
    assert.equal(measureNear(cardAt(1200), null), true, '视口下方 400px 的卡应当算近');
    assert.equal(measureNear(cardAt(5000), null), false, '视口下方 4200px 的卡应当算远');
    // 提前量是 600：正好在界外一点点的卡不算近。
    assert.equal(measureNear(cardAt(1401), null), false, '提前量之外就是远');
    assert.equal(measureNear(cardAt(1400), null), true, '提前量之内就算近');
  });
});
