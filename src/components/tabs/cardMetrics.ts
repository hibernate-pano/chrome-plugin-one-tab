/**
 * 会话卡的**高度**真相源（2026-10-24 审计 PERF-03）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * 1000 个会话 ⇒ 1000 张卡**全部挂载**（每张卡头约 45 个 DOM 节点：
 * 折叠按钮 + favicon + 标题 + 计数徽章 + 时间 + 5 颗带 tooltip 的操作按钮）
 * ⇒ 45,220～47,343 个 DOM 节点、**一条 1.46～1.63 秒的长任务**占住主线程，
 * 期间列表一帧不出、点不动（实测，真 Chrome + HEAD 的 dist）。
 *
 * 修法（结构性的那一条）：**远离视口的卡整张只留一个等高占位**。
 *
 * ── 为什么「等高」是这件事的全部难点 ──────────────────────────────────────
 *
 * 占位高度必须与真卡**逐像素一致**，否则文档总高会随「哪些卡被渲染」变化：
 * 滚动条乱跳、用户滚到的位置会漂走。占位太矮 ⇒ 用户滚到那儿时下面的内容
 * 猛地往上跳；占位太高 ⇒ 滚动条比实际内容长一大截。
 *
 * 卡高 = 上下边框 + 卡头 + 标签行区，三段都有确定的来源：
 *
 *   · 上下边框：`1px + 1px`（`.tab-group-card` 的 border）⇒ 常量；
 *   · 卡头：**运行时量**（它的高度 = 36px 的按钮命中区 + 上下 padding
 *     + 下边框；padding 与主题覆盖都会改它）⇒ 不能写死，只能量；
 *   · 标签行区：`行数 × 行距` ⇒ 行距也必须**量**（见下）。
 *
 * ── 为什么行距不能写死（这是本文件最重要的一条）─────────────────────────
 *
 * 行高是**内容驱动**的：`.tab-item` 的盒高 = 内容（删除键的 36×36 命中区）
 * + 下边框 1px（分隔线）= **37px** ⇒ 行距 37px。
 * （2026-10-24 起：上下 padding 与行间距都撤掉了 —— 垂直节奏只在
 *  global.css 的 `.tab-item` 一处给出，见那里的注释与守卫
 *  tests/guards/tabRowRhythmSingleSource.test.ts。）
 *
 * 但这几个数**都会变**：
 *   · 主题：任何一套主题再给 `.tab-item` 加 padding / margin 就会改掉它
 *     （守卫挡住这种漂移）；
 *   · 浏览器缩放 / 用户最小字号：rem 跟着缩 ⇒ 整条链都变；
 *   · 未来任何一次改 `.tab-item` 样式的提交。
 *
 * ⇒ 历史常量（44px、58px）只对**某一个**版本的样式成立 ⇒ 它们已经过期
 * （58px 那版真实行 54px、占位说 58px ⇒ 每一行占位高 4px）。
 * ⇒ 行距必须**运行时量**，量出来的值才是真的（见 `rowStrideFrom`）。
 *
 * 折叠态的卡没有行区（网格轨道 0fr）⇒ 行区高度为 0。
 *
 * ⚠️ 卡头高度用**小数**（`getBoundingClientRect().height`）而不是
 * `offsetHeight`（取整）：1000 张卡的取整误差会累加成几千像素的滚动漂移。
 * 真卡与占位用的是**同一个**小数 ⇒ 逐像素一致。
 */

/** 卡片自身的上下边框合计（`.tab-group-card` 的 `border: 1px`）。 */
export const CARD_BORDER_PX = 2;

/**
 * 卡头高度的**暂用值**（还没量到时的占位）。
 *
 * 41 = 默认主题宽屏实测（2 padding + 36 内容 + 1 下边框 × 2）。
 * 它只在「第一次布局、还没量到」的那一瞬间被用到 —— 量到之后
 * `reportCardHeaderHeight` 立刻把它换掉（见下）⇒ 它的作用只是
 * 「让首屏不用等一次测量」。
 *
 * ⚠️ 2026-10-24 起卡头的上下 padding 从 8–12px 收到 2px（内容一字不动：
 * 那 5 颗按钮的命中区下限还是 36px）⇒ 53/61px 一起变成 45px，
 * 再按产品口径「卡头只比一行标签高一点点」收到 **41px**。
 */
export const CARD_HEADER_FALLBACK_PX = 41;

/**
 * 行距的**暂用值**（还没量到时的占位）。
 *
 * 37 = 默认主题实测（行盒 37px = 内容 36px + 下边框 1px；行间距已撤掉）。
 * 与卡头暂用值同理：第一次布局用它，之后由运行时测量接管。
 * ⚠️ 它**不是**真值：任何一套主题再给 `.tab-item` 加 padding / margin、
 * 浏览器缩放，都会改掉它 ⇒ 任何依赖「37 恰好对」的推理都是错的。
 */
export const ROW_STRIDE_FALLBACK_PX = 37;

/**
 * 从**量到的数字**推出行距（纯函数，可直接单测）。
 *
 * @param rowsHeight  行容器（`.tab-group-tabs-container`）的高度
 * @param lastRowMarginBottom 最后一行的下外边距（**塌陷出容器的那一份**）
 * @param rowCount    行数
 * @returns 行距（px）；量不出来时返回 null（调用方应保持旧值，不要瞎猜）
 *
 * ── 为什么要把「最后一行那一份外边距」加回来 ──────────────────────────────
 *
 * 行容器是普通 block：最后一行的 `margin-bottom` 会**塌陷出容器**
 * （容器的盒高里没有它）。但外层那个 `overflow:hidden` 的包装层
 * 建立了 BFC ⇒ 容器的下外边距被它**含住**（BFC 不让子元素的外边距塌陷出去）
 * ⇒ 轨道总高 = 行容器高 + 最后一行那一份外边距。
 *
 * 净效果：轨道总高 = 行数 × 行距（这正是占位要复刻的那个数）。
 *
 * ⚠️ 2026-10-24 起标签行没有下外边距了（垂直节奏收紧到 37px 一行），
 *    这一项现在是 0 —— 但公式必须对**任意**外边距都成立（换主题、
 *    改样式都可能让它再非零），所以「加回来」这条逻辑不许改成减法。
 *
 * ⚠️ 这里**不做**「减掉塌陷外边距」的修正 —— 那正是历史上算错两次的地方
 * （见 lazyTabRows.ts 顶部的记录）。
 */
export function rowStrideFrom(
  rowsHeight: number,
  lastRowMarginBottom: number,
  rowCount: number
): number | null {
  if (!Number.isFinite(rowsHeight) || !Number.isFinite(lastRowMarginBottom)) return null;
  if (!Number.isFinite(rowCount) || rowCount <= 0) return null;
  const total = rowsHeight + lastRowMarginBottom;
  if (total <= 0) return null;
  return total / rowCount;
}

/**
 * 一张卡占住多高。
 *
 * @param tabCount  会话里的标签数
 * @param headerHeight 卡头高度（量出来的，小数）
 * @param rowStride 行距（量出来的；未量到时用暂用值）
 * @param collapsed 折叠态（没有行区）
 */
export function cardHeightFor(
  tabCount: number,
  headerHeight: number,
  rowStride: number,
  collapsed: boolean
): number {
  const rows = collapsed ? 0 : Math.max(0, tabCount) * rowStride;
  return CARD_BORDER_PX + headerHeight + rows;
}

// ── 高度真相源：进程内共享的两个真值 ─────────────────────────────────────
//
// 为什么是**共享**而不是「每个卡各量各的」：
//   · 1000 张卡各量各的 ⇒ 1000 个 ResizeObserver + 1000 份状态；
//   · 而卡头高度与行距**整份列表各只有一个值**（所有卡的卡头结构一样、
//     所有行同构）。
//
// 为什么不用 React Context：这两个值是**测出来的事实**，不是「谁传下来的意图」；
// 而且它们会随窗口宽度/主题变（断点、padding 覆盖）⇒ 用一个小的订阅式存储
// （`useSyncExternalStore`）更贴切 —— 变化的次数极少（首次测量 + 改宽度/
// 换主题），每次变化让所有占位重算高度。

type Listener = () => void;

let cardHeaderHeight = CARD_HEADER_FALLBACK_PX;
let rowStride = ROW_STRIDE_FALLBACK_PX;
const listeners = new Set<Listener>();

/** 当前卡头高度（`useSyncExternalStore` 的 snapshot）。 */
export function getCardHeaderHeight(): number {
  return cardHeaderHeight;
}

/** 当前行距（`useSyncExternalStore` 的 snapshot）。 */
export function getRowStride(): number {
  return rowStride;
}

/** 订阅高度真值的变化（卡头高度与行距共用一套订阅）。 */
export function subscribeCardHeaderHeight(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅行距的变化（与卡头共用一套订阅：两个值总是一起变）。 */
export function subscribeRowStride(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 报告量到的卡头高度。
 *
 * 只有**真的变了**才通知（否则每次 ResizeObserver 回调都会惊动 1000 个占位）。
 */
export function reportCardHeaderHeight(height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  if (Math.abs(height - cardHeaderHeight) < 0.01) return;
  cardHeaderHeight = height;
  notify();
}

/**
 * 报告量到的行距。
 *
 * 同上：只有真变了才通知。量不出来（null）时**保持旧值** ——
 * 「不知道」不等于「换一个数」。
 */
export function reportRowStride(stride: number | null): void {
  if (stride === null) return;
  if (!Number.isFinite(stride) || stride <= 0) return;
  if (Math.abs(stride - rowStride) < 0.01) return;
  rowStride = stride;
  notify();
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** 只给测试用：把高度真值复位。 */
export function __resetCardMetricsForTests(): void {
  cardHeaderHeight = CARD_HEADER_FALLBACK_PX;
  rowStride = ROW_STRIDE_FALLBACK_PX;
  listeners.clear();
}
