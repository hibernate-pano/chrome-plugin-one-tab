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
 * 与真实样式的对应关系（改样式要同步改这里，见 src/styles/global.css）：
 *   .tab-item { padding: 10px 16px; border-bottom: 1px; margin-bottom: 4px }
 *   实测行距 **44px**（40px 内容 + 4px 下外边距）。
 *
 * 【为什么占位就是「行数 × 44」这一条简单公式】这里踩过两次坑，都源于对外边距塌陷
 * 的想当然，记下来免得再犯：
 *   - 第一次按「40 内容 + 1 边框 = 41」算 → 每卡矮 3px×行数，文档总高随渲染集合变化；
 *   - 第二次改成 44 后又「减掉最后一行的 4px 塌陷外边距」→ 每卡矮 4px。
 * 实测真实结构（20 行）是：容器（role=list）高 876 = 20×44 − 4，但那 4px 并没有
 * 消失——它作为最后一个行的下外边距塌陷出容器、成为容器自身的下外边距，而外层
 * 折叠容器有 overflow:hidden（BFC），于是这 4px 又被加回来，最终**外层容器高 880
 * = 20×44**，卡片总高 927 = 1(上边框) + 45(卡头) + 880 + 1(下边框)。
 * 结论：占位高度直接用「行数 × 行距」即可，与真实布局逐像素一致；不要再做塌陷修正。
 */
export const TAB_ROW_STRIDE_PX = 44;

/**
 * 决定这张卡的标签行是「真的渲染」还是「用等高占位撑住」。
 *
 * @param totalTabs 该会话的标签总数
 * @param isNear    这张卡是否接近视口（见 useNearViewport）
 *
 * 【为什么用占位而不是「不渲染」】每张卡都必须占住它真实的高度，否则卡片一多，
 * 文档总高会随「哪些卡被渲染」剧烈变化：滚动条乱跳、用户滚到的位置会漂走。
 * 占位高度是**精确值**（行数 × 实测行距），不是估算，因此总高与全量渲染逐像素
 * 一致（这条有单测钉住）。卡片头部始终真实渲染，其高度天然精确。
 */
export function resolveRowWindow(
  totalTabs: number,
  isNear: boolean
): { renderRows: boolean; placeholderHeight: number } {
  if (!Number.isFinite(totalTabs) || totalTabs <= 0) {
    return { renderRows: true, placeholderHeight: 0 };
  }
  if (isNear) return { renderRows: true, placeholderHeight: 0 };
  return { renderRows: false, placeholderHeight: totalTabs * TAB_ROW_STRIDE_PX };
}
