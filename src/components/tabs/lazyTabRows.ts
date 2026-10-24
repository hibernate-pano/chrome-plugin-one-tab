/**
 * 标签行懒渲染的**纯决策逻辑**（无 DOM、无 React，可直接单测）。
 *
 * 【为什么要把这几行抽出来】「哪些行渲染、占位多高」一旦写错，表现是
 * 「列表高度跳变 / 滚动位置乱飘 / 行凭空消失」——都属于很难在代码评审里看出来的
 * 问题，但作为纯函数可以逐条钉死。
 *
 * 【为什么按「卡片是否接近视口」而不是「卡片有多少行」来判定】
 * 第一版实现按「单卡行数 > 60 才懒渲染」来判，实测**完全没生效**：
 * 出问题的数据集是 400 个会话 × 每会话 20 行 —— 单卡 20 行看起来「很小」，
 * 但 400 张卡加起来是 8000 行 / 10 万个 DOM 元素，开销全在总量上。
 * 教训：判据必须是「这张卡的 DOM 该不该存在于页面上」，而不是「这张卡大不大」。
 * 所以阈值被删掉了：判定只由可见性决定，小列表里所有卡都接近视口，行为与改造前一致。
 *
 * ── 2026-10-24 审计 PERF-03：行距从常量改成**量出来的值** ────────────────
 *
 * 本文件原来导出 `TAB_ROW_STRIDE_PX = 44`，并在注释里断言
 * 「与 global.css 的 .tab-item { padding:10px 16px; border-bottom:1px } 对应」。
 * 那条对应关系**早已不成立**：
 *   · .tab-item 的 padding 现在由 drag-drop.css 写死 8px 12px（它在
 *     global.css **之后**加载），内容（操作条 36px）+ padding + 边框 ⇒ 行盒 54px；
 *   · 再加 margin-bottom: 4px ⇒ **真实行距 58px**，而常量说 44px。
 * ⇒ 每一行占位比真实行矮 14px ⇒ 卡片一旦从「远」变「近」，高度会突变
 *   ⇒ 滚动条跳、内容漂。**这是一个真实存在的缺陷**（不是新引入的）。
 *
 * 而且 44px 这种常量**只对某一个版本的样式成立**：主题覆盖（creamy 的
 * `margin: 2px 8px` ⇒ 行距 56）、浏览器缩放、rem 变化都会改掉它。
 * ⇒ 行距现在**运行时量**（见 cardMetrics.rowStrideFrom），本文件只负责
 *   「行数 × 行距」这个乘法。
 *
 * 与真实样式的对应关系（**不要**在这里写死行高）：
 *   行盒 = 内容（.tab-item-actions 36px）+ padding 8px×2 + 边框 1px×2 = 54px
 *   行距 = 行盒 + margin-bottom(4px) = 58px
 *
 * 【为什么占位就是「行数 × 行距」这一条简单公式】这里踩过两次坑，都源于对外边距塌陷
 * 的想当然，记下来免得再犯：
 *   - 第一次按「40 内容 + 1 边框 = 41」算 → 每卡矮 3px×行数，文档总高随渲染集合变化；
 *   - 第二次改成 44 后又「减掉最后一行的 4px 塌陷外边距」→ 每卡矮 4px。
 * 实测真实结构（5 行）是：行容器高 286 = 5×54 + 4×4（最后一行的 4px 塌陷出去了），
 * 外层折叠容器有 overflow:hidden（BFC），于是这 4px 又被加回来，最终**轨道高 290
 * = 5×58**，卡片总高 345 = 2(上下边框) + 53(卡头) + 290。
 * 结论：占位高度直接用「行数 × 行距」即可，与真实布局逐像素一致；不要再做塌陷修正。
 */
import { ROW_STRIDE_FALLBACK_PX } from './cardMetrics';

/**
 * 决定这张卡的标签行是「真的渲染」还是「用等高占位撑住」。
 *
 * @param totalTabs 该会话的标签总数
 * @param isNear    这张卡是否接近视口（见 useNearViewport）
 * @param rowStride 行距（**量出来的**；见 cardMetrics.rowStrideFrom）。
 *                  传默认值只是兜底 —— 真实的行距由运行时测量提供。
 *
 * 【为什么用占位而不是「不渲染」】每张卡都必须占住它真实的高度，否则卡片一多，
 * 文档总高会随「哪些卡被渲染」剧烈变化：滚动条乱跳、用户滚到的位置会漂走。
 * 占位高度是**精确值**（行数 × 实测行距），不是估算，因此总高与全量渲染逐像素
 * 一致（这条有单测钉住）。卡片头部始终真实渲染，其高度天然精确。
 */
export function resolveRowWindow(
  totalTabs: number,
  isNear: boolean,
  rowStride: number = ROW_STRIDE_FALLBACK_PX
): { renderRows: boolean; placeholderHeight: number } {
  if (!Number.isFinite(totalTabs) || totalTabs <= 0) {
    return { renderRows: true, placeholderHeight: 0 };
  }
  if (isNear) return { renderRows: true, placeholderHeight: 0 };
  const stride = Number.isFinite(rowStride) && rowStride > 0 ? rowStride : ROW_STRIDE_FALLBACK_PX;
  return { renderRows: false, placeholderHeight: totalTabs * stride };
}
