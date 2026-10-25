// 标签行懒渲染的纯逻辑单测（src/components/tabs/lazyTabRows.ts）。
//
// 这里钉的是「占位高度必须与真实布局逐像素一致」这一类不变量。
// 背景：这个功能的两个真实缺陷全都是高度算错，而且症状都不在代码里显而易见——
//   1) 按 41px（漏了 4px 行距）→ 每卡矮 3px×行数，文档总高随渲染集合变化；
//   2) 按 44px 后又「减掉塌陷外边距」→ 每卡矮 4px。
// 两次都是靠真机基准（「滚动前后文档总高一致」断言）才暴露出来的，
// 所以这里把公式与判定顺序显式钉住，避免第三次。
//
// ── 2026-10-24 审计 PERF-03：行距从「写死的常量」改成「量出来的输入」──────
//
// 本文件原来断言 `TAB_ROW_STRIDE_PX === 44`，并在注释里说它对应
// 「global.css 的 .tab-item { padding:10px 16px; border-bottom:1px }」。
// 那条对应关系**早已不成立**：padding 当时由 drag-drop.css 写死 8px 12px，
// 内容（操作条）36px ⇒ 行盒 54px，加 margin-bottom 4px ⇒ **真实行距 58px**。
// ⇒ 每一行占位比真实行矮 14px ⇒ 卡片从「远」变「近」时高度突变 ⇒ 滚动漂。
//
// 而且写死的常量只对**某一个版本的样式**成立（主题覆盖、浏览器缩放都会改它），
// 所以行距现在由运行时测量提供（cardMetrics.rowStrideFrom），
// 本模块只负责「行数 × 行距」这个乘法 ⇒ 下面钉的是**乘法与降级**，
// 行距本身的推导在 tests/cardMetrics.test.ts 里钉。
//
// ── 2026-10-24：标签行的垂直节奏收紧到 37px 一行 ──────────────────────────
//
// 行盒 54px → 37px（上下 padding 与行间距都撤掉；垂直节奏只在 global.css 的
// `.tab-item` 一处给出）⇒ 真实行距 58px → 37px。暂用值随之改成 37。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveRowWindow } from '../src/components/tabs/lazyTabRows.ts';
import { ROW_STRIDE_FALLBACK_PX } from '../src/components/tabs/cardMetrics.ts';

const READ = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('懒渲染：占位高度', () => {
  it('占位高度 = 行数 × **给定的**行距（行距是输入，不是内部常量）', () => {
    // 37 = 默认主题实测行距（2026-10-24 收紧后：行盒 37px，无行间距）。
    assert.equal(resolveRowWindow(20, false, 37).placeholderHeight, 740);
    assert.equal(resolveRowWindow(1, false, 37).placeholderHeight, 37);
    assert.equal(resolveRowWindow(7, false, 37).placeholderHeight, 259);
    assert.equal(resolveRowWindow(150, false, 37).placeholderHeight, 5550);
  });

  it('行距换一个值，占位高度就跟着换（证明行距真的参与了计算）', () => {
    // 这条是防「参数被忽略」的：若实现里写死了 37，改这里就不会变红。
    assert.equal(resolveRowWindow(10, false, 44).placeholderHeight, 440);
    assert.equal(resolveRowWindow(10, false, 58).placeholderHeight, 580);
    assert.notEqual(
      resolveRowWindow(10, false, 37).placeholderHeight,
      resolveRowWindow(10, false, 44).placeholderHeight
    );
  });

  it('行距不可用时退回到暂用值（占位绝不能变成 0 —— 那会把内容藏起来）', () => {
    for (const bad of [Number.NaN, 0, -10, Infinity]) {
      const r = resolveRowWindow(10, false, bad);
      assert.equal(r.renderRows, false);
      assert.equal(
        r.placeholderHeight,
        10 * ROW_STRIDE_FALLBACK_PX,
        `行距=${bad} 必须退回暂用值 ${ROW_STRIDE_FALLBACK_PX}`
      );
      assert.ok(r.placeholderHeight > 0, '占位高度必须为正');
    }
  });

  it('暂用值本身是 37px（默认主题实测：行盒 37px = 内容 36 + 下边框 1）', () => {
    // ⚠️ 这个数只是**第一次布局、还没量到**时用的暂用值：
    // 运行时量到的真值会立刻接管（cardMetrics.reportRowStride）。
    // 它**不是**真值 —— 主题覆盖、浏览器缩放都会再改一遍。
    assert.equal(ROW_STRIDE_FALLBACK_PX, 37);
  });

  it('接近视口时渲染真实行，且不带占位高度', () => {
    const r = resolveRowWindow(150, true, 37);
    assert.equal(r.renderRows, true);
    assert.equal(r.placeholderHeight, 0);
  });

  it('渲染与占位互斥：不可能既渲染行又留占位', () => {
    for (const n of [0, 1, 20, 500]) {
      for (const near of [true, false]) {
        const r = resolveRowWindow(n, near, 37);
        assert.ok(
          (r.renderRows && r.placeholderHeight === 0) ||
            (!r.renderRows && r.placeholderHeight > 0),
          `n=${n} near=${near} 得到 renderRows=${r.renderRows} height=${r.placeholderHeight}`
        );
      }
    }
  });

  it('畸形输入一律退化成「渲染真实行」，绝不留下不可见的空占位', () => {
    // 降级方向很重要：算不出高度时必须渲染真内容（最多慢一点），
    // 而不是留一个占位把内容藏起来——后者对用户就是「标签凭空消失」。
    for (const bad of [Number.NaN, Infinity, -1, -100]) {
      const r = resolveRowWindow(bad, false, 37);
      assert.equal(r.renderRows, true, `totalTabs=${bad} 必须退化为渲染`);
      assert.equal(r.placeholderHeight, 0);
    }
  });

  it('0 个标签的会话：渲染（得到空列表），不留占位', () => {
    const r = resolveRowWindow(0, false, 37);
    assert.equal(r.renderRows, true);
    assert.equal(r.placeholderHeight, 0);
  });

  it('占位高度随行数单调递增（不会出现越少越高）', () => {
    let prev = -1;
    for (let n = 1; n <= 200; n++) {
      const h = resolveRowWindow(n, false, 37).placeholderHeight;
      assert.ok(h > prev, `n=${n} 高度未递增`);
      prev = h;
    }
  });
});

describe('懒渲染：与源码结构的契约', () => {
  const TAB_GROUP = READ('../src/components/tabs/TabGroup.tsx');

  it('观测挂在卡片根节点上（折叠容器高度为 0，不能拿来当可见性依据）', () => {
    assert.ok(
      /ref=\{cardRef\}/.test(TAB_GROUP),
      'cardRef 必须挂在卡片根节点上'
    );
    assert.ok(
      !/ref=\{tabsWrapperRef\}/.test(TAB_GROUP),
      '不应把观测挂在折叠容器上'
    );
  });

  it('占位节点带 role="presentation"（否则读屏会在 list 里念到非 listitem 的空节点）', () => {
    assert.ok(
      /role="presentation"[\s\S]{0,120}data-lazy-placeholder/.test(TAB_GROUP),
      '占位节点缺 role="presentation"'
    );
  });

  it('占位高度来自纯函数，不允许在组件里另写一份算式', () => {
    assert.ok(
      /resolveRowWindow\(\s*group\.tabs\.length,\s*isNearViewport,\s*rowStride\s*\)/.test(
        TAB_GROUP
      ),
      '组件应把**量出来的**行距传给 resolveRowWindow'
    );
    assert.ok(
      !/\*\s*ROW_STRIDE_FALLBACK_PX/.test(TAB_GROUP),
      '组件里不应出现自己的行高乘法（会与纯函数漂移）'
    );
  });

  it('组件必须把行距**量出来**并上报（写死的常量只对某个版本的样式成立）', () => {
    assert.ok(
      /reportRowStride\(/.test(TAB_GROUP),
      '组件必须上报量到的行距，否则占位高度会随主题/缩放失准'
    );
    assert.ok(
      /rowStrideFrom\(/.test(TAB_GROUP),
      '组件必须用 cardMetrics.rowStrideFrom 推导行距（推导规则只有一处）'
    );
  });
});
