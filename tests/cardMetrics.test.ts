// 会话卡高度真相源的单测（src/components/tabs/cardMetrics.ts）。
//
// ── 这条防的具体事故 ────────────────────────────────────────────────────
//
// 1000 个会话 ⇒ 1000 张卡全部挂载 ⇒ 4.5 万个 DOM 节点 + 一条 1.46～1.63 秒的
// 长任务。修法是「远离视口的卡只留等高占位」，而**等高**的全部难点在于：
// 占位高度必须与真卡逐像素一致，否则文档总高随「哪些卡被渲染」变化 ⇒
// 滚动条乱跳、用户滚到的位置漂走。
//
// ── 为什么这些数字不是「随手写的常量」────────────────────────────────────
//
// 下面用到的每一组数都来自**真机实测**（真 Chrome + 真实产物，
// 采样脚本：scripts/perf03-card-window-probe.mjs，采样时间 2026-10-24，
// 默认主题、视口 1280×800、每会话 5 个标签）：
//
//   · 一行（.tab-item）的盒高 = 54px（内容 36 + padding 8×2 + 边框 1×2）
//   · 一行的 margin-bottom = 4px
//   · 行容器（.tab-group-tabs-container，5 行）高 = 286px
//     （= 5×54 + 4×4：**最后一行的 4px 塌陷出去了**）
//   · 轨道（grid 1fr）高 = 290px（BFC 包装层把那 4px 加了回来）
//   · 卡头高 = 53px
//   · 真卡高 = 345px（= 2 边框 + 53 卡头 + 290 轨道）
//
// ⇒ 这些数是**独立于代码**量出来的 ⇒ 公式必须能复现它们。
// 这比「断言常量等于 44」强得多：后者只是在复述代码自己的选择。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_BORDER_PX,
  CARD_HEADER_FALLBACK_PX,
  ROW_STRIDE_FALLBACK_PX,
  __resetCardMetricsForTests,
  cardHeightFor,
  getCardHeaderHeight,
  getRowStride,
  reportCardHeaderHeight,
  reportRowStride,
  rowStrideFrom,
  subscribeRowStride,
} from '../src/components/tabs/cardMetrics.ts';

/** 真机实测样本（见文件头）。 */
const REAL = {
  rowBox: 54,
  rowMarginBottom: 4,
  rowsContainerHeight5: 286,
  trackHeight5: 290,
  headerHeight: 53,
  realCardHeight5: 345,
};

describe('卡高：行距的推导（rowStrideFrom）', () => {
  it('用真机实测的容器高推出真机实测的行距（58px）', () => {
    assert.equal(
      rowStrideFrom(REAL.rowsContainerHeight5, REAL.rowMarginBottom, 5),
      58
    );
  });

  it('推出来的行距能复现真机实测的轨道高与卡高', () => {
    const stride = rowStrideFrom(REAL.rowsContainerHeight5, REAL.rowMarginBottom, 5)!;
    assert.equal(5 * stride, REAL.trackHeight5, '轨道高 = 行数 × 行距');
    assert.equal(
      cardHeightFor(5, REAL.headerHeight, stride, false),
      REAL.realCardHeight5,
      '卡高 = 边框 + 卡头 + 轨道'
    );
  });

  it('把「塌陷出去的最后一行外边距」加回来（不做减法修正）', () => {
    // 历史上在这里栽过两次：先按「40 内容 + 1 边框」算（漏了行距），
    // 后来又「减掉最后一行塌陷的外边距」⇒ 每卡矮 4px ⇒ 文档总高随
    // 渲染集合变化 ⇒ 滚动漂。
    // 正确形状：容器高不含最后一行的外边距 ⇒ 必须**加回**它。
    const stride = rowStrideFrom(REAL.rowsContainerHeight5, REAL.rowMarginBottom, 5)!;
    const wrong = (REAL.rowsContainerHeight5 - REAL.rowMarginBottom) / 5;
    assert.notEqual(stride, wrong);
    assert.ok(stride > wrong, '加回来的行距必须大于减掉的行距');
  });

  it('只有一行时也成立（容器高 = 行盒高，最后一行的外边距同样要加回）', () => {
    assert.equal(rowStrideFrom(REAL.rowBox, REAL.rowMarginBottom, 1), 58);
  });

  it('量不出来时返回 null（调用方保持旧值，不许瞎猜）', () => {
    assert.equal(rowStrideFrom(Number.NaN, 4, 5), null);
    assert.equal(rowStrideFrom(286, Number.NaN, 5), null);
    assert.equal(rowStrideFrom(286, 4, 0), null);
    assert.equal(rowStrideFrom(286, 4, -1), null);
    assert.equal(rowStrideFrom(0, 0, 5), null);
    assert.equal(rowStrideFrom(286, 4, Number.NaN), null);
  });
});

describe('卡高：cardHeightFor', () => {
  it('卡高 = 上下边框 + 卡头 + 行数 × 行距', () => {
    assert.equal(cardHeightFor(5, 53, 58, false), 2 + 53 + 290);
    assert.equal(cardHeightFor(0, 53, 58, false), 2 + 53);
  });

  it('折叠态没有行区（轨道为 0fr）', () => {
    assert.equal(cardHeightFor(5, 53, 58, true), 2 + 53);
    assert.equal(cardHeightFor(0, 53, 58, true), 2 + 53);
  });

  it('边框是 2px（.tab-group-card 的 border: 1px）', () => {
    assert.equal(CARD_BORDER_PX, 2);
  });

  it('标签数是负数时按 0 行算（不许算出负高度）', () => {
    assert.equal(cardHeightFor(-5, 53, 58, false), 2 + 53);
  });

  it('行距变了卡高就变（证明行距真的参与了计算）', () => {
    assert.notEqual(
      cardHeightFor(5, 53, 58, false),
      cardHeightFor(5, 53, 44, false)
    );
  });
});

describe('卡高：共享真值（订阅式存储）', () => {
  beforeEach(() => {
    __resetCardMetricsForTests();
  });

  it('初始值是暂用值（第一次布局还没量到时用）', () => {
    assert.equal(getCardHeaderHeight(), CARD_HEADER_FALLBACK_PX);
    assert.equal(getRowStride(), ROW_STRIDE_FALLBACK_PX);
  });

  it('上报真值后读到的就是真值', () => {
    reportCardHeaderHeight(REAL.headerHeight);
    reportRowStride(rowStrideFrom(REAL.rowsContainerHeight5, REAL.rowMarginBottom, 5));
    assert.equal(getCardHeaderHeight(), REAL.headerHeight);
    assert.equal(getRowStride(), 58);
  });

  it('量不出来（null）时保持旧值 —— 「不知道」不等于「换一个数」', () => {
    reportRowStride(56);
    reportRowStride(null);
    assert.equal(getRowStride(), 56);
  });

  it('非法值一律忽略（0 / 负数 / NaN / 无穷）', () => {
    reportRowStride(56);
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      reportRowStride(bad);
      reportCardHeaderHeight(bad);
    }
    assert.equal(getRowStride(), 56);
    assert.equal(getCardHeaderHeight(), CARD_HEADER_FALLBACK_PX);
  });

  it('只有真变了才通知订阅者（否则每次 ResizeObserver 回调都会惊动 1000 个占位）', () => {
    let notifications = 0;
    const unsubscribe = subscribeRowStride(() => {
      notifications += 1;
    });
    reportRowStride(56);
    assert.equal(notifications, 1);
    reportRowStride(56);
    assert.equal(notifications, 1, '同一个值不该再通知');
    reportRowStride(56.001);
    assert.equal(notifications, 1, '浮点噪声不该通知');
    reportRowStride(58);
    assert.equal(notifications, 2);
    unsubscribe();
    reportRowStride(60);
    assert.equal(notifications, 2, '退订后不该再收到');
  });
});
