// 标签行懒渲染的纯逻辑单测（src/components/tabs/lazyTabRows.ts）。
//
// 这里钉的是「占位高度必须与真实布局逐像素一致」这一类不变量。
// 背景：这个功能的两个真实缺陷全都是高度算错，而且症状都不在代码里显而易见——
//   1) 按 41px（漏了 4px 行距）→ 每卡矮 3px×行数，文档总高随渲染集合变化；
//   2) 按 44px 后又「减掉塌陷外边距」→ 每卡矮 4px。
// 两次都是靠真机基准（「滚动前后文档总高一致」断言）才暴露出来的，
// 所以这里把公式与判定顺序显式钉住，避免第三次。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TAB_ROW_STRIDE_PX,
  resolveRowWindow,
} from '../src/components/tabs/lazyTabRows.ts';

const READ = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('懒渲染：占位高度', () => {
  it('行距常量是 44px（40px 行高 + 4px 下外边距）', () => {
    // 与 global.css 的 .tab-item { padding:10px 16px; border-bottom:1px } + 行间距 4px 对应。
    // 若样式改了行高/间距，这条会失败，提醒同步改常量（否则占位高度失准、滚动会漂）。
    assert.equal(TAB_ROW_STRIDE_PX, 44);
  });

  it('远离视口时占位高度 = 行数 × 44（不做任何塌陷修正）', () => {
    // 真实结构实测：卡片 927 = 1 + 45(卡头) + 880 + 1，其中 880 = 20×44。
    // 「最后一行外边距塌陷出容器」那 4px 会被外层 overflow:hidden 的 BFC 加回来，
    // 净效果就是整齐的 n×44 —— 见 lazyTabRows.ts 顶部对两次踩坑的记录。
    assert.equal(resolveRowWindow(20, false).placeholderHeight, 880);
    assert.equal(resolveRowWindow(1, false).placeholderHeight, 44);
    assert.equal(resolveRowWindow(7, false).placeholderHeight, 308);
    assert.equal(resolveRowWindow(150, false).placeholderHeight, 6600);
  });

  it('接近视口时渲染真实行，且不带占位高度', () => {
    const r = resolveRowWindow(150, true);
    assert.equal(r.renderRows, true);
    assert.equal(r.placeholderHeight, 0);
  });

  it('渲染与占位互斥：不可能既渲染行又留占位', () => {
    for (const n of [0, 1, 20, 500]) {
      for (const near of [true, false]) {
        const r = resolveRowWindow(n, near);
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
      const r = resolveRowWindow(bad, false);
      assert.equal(r.renderRows, true, `totalTabs=${bad} 必须退化为渲染`);
      assert.equal(r.placeholderHeight, 0);
    }
  });

  it('0 个标签的会话：渲染（得到空列表），不留占位', () => {
    const r = resolveRowWindow(0, false);
    assert.equal(r.renderRows, true);
    assert.equal(r.placeholderHeight, 0);
  });

  it('占位高度随行数单调递增（不会出现越少越高）', () => {
    let prev = -1;
    for (let n = 1; n <= 200; n++) {
      const h = resolveRowWindow(n, false).placeholderHeight;
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
      /resolveRowWindow\(group\.tabs\.length, isNearViewport\)/.test(TAB_GROUP),
      '组件应调用 resolveRowWindow 取高度'
    );
    assert.ok(
      !/\*\s*TAB_ROW_STRIDE_PX/.test(TAB_GROUP),
      '组件里不应出现自己的行高乘法（会与纯函数漂移）'
    );
  });
});
