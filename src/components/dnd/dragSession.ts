/**
 * 会话内标签拖拽的**会话级**状态与 hover 决策（纯逻辑、可单测、不碰 DOM API）。
 *
 * ── 为什么拖拽状态不能挂在「行」上 ──────────────────────────────────────
 * 一次拖拽会横跨多行：被拖的那行换位后会带着新下标重新渲染，而**落点行的组件
 * 实例从头到尾没变过**。任何挂在落点行 ref 上的「源下标」，在 dragover 里读到的
 * 都是**落点自己**的下标 —— 于是「拖 b 到 g2 的 e」发出的是 moveTab(g1, 0, g2, 0)，
 * 搬走的是 a 而不是 b：经 applyMoveTab 正常落盘并上传云端的静默数据损坏
 * （v1.22.0 起无回收站、无撤销）。原 react-dnd 实现把源下标存在**拖拽会话级**的
 * 可变对象里，并在每次成功换位后回写（item.index = targetIndex），语义天然跨行；
 * 1.22.5 的原生迁移把它降级成了行级 ref，于是会话级语义丢失。
 *
 * ── 两个缺陷根因不同，必须分别治（修好一个不会自动修好另一个）────────────
 * 以下 P0/P1 编号沿用转正过程的命名（见 DraggableTab.tsx 文件头转正记录）：
 *  · P1「输入错误」= 源下标解析分散（行 ref 与闭包 index 各说各话）。
 *    修法：收敛到**一个**来源 —— 本模块的会话锚点（dragstart 记源下标，每次
 *    换位后回写 —— 对应原实现 hover 末尾的 item.index = targetIndex、
 *    item.groupId = targetGroupId），行组件只负责「这次换位有没有真的派发出去」。
 *  · P0「输入不可得」= 载荷靠 dataTransfer.getData 读取。HTML5 DnD 规范规定
 *    dragover 处于**受保护模式**（protected mode），此时 getData 必须返回空串
 *    （暴露数据要等 drop/dragend）。真实 Chromium 实测：dragstart 时 getData 返回
 *    载荷本身，dragover 连续 10 次全部返回 ""，drop 时才恢复。
 *    —— 瘦身前的 react-dnd 实现根本不走这条路：拖拽载荷经 backend 的内存 item
 *    传递（db09f10^ 的 useDrag item / hover(item)），从不在 dragover 里读
 *    dataTransfer。恢复即回到「载荷只走同源 JS 变量」。
 *    dataTransfer 只保留 text/plain（拖出到外部时的可读文本，且 Firefox 需要它
 *    才肯开始拖）。这样 dragover 里不再有"读不到载荷就 return"这条死路。
 */

/** 拖到目标行上、下方超过这个比例不换位——否则行会抖动（与原实现同阈值）。 */
export const EDGE_THRESHOLD = 0.2;

/** 节流间隔：hover 高频触发，限制落盘频率（与原实现一致）。 */
export const MOVE_THROTTLE_MS = 100;

/**
 * 一次拖拽会话的行锚点。
 *
 * `index` 是**被拖行的当前下标**（唯一来源，不是落点行的下标）；
 * `groupId` 会被「换位 + 换组」改写为落点组：跨组换位后源组会少一项甚至被
 * 物理移除，继续拿旧 groupId + 旧 index 组合去算下一次移动会指向别的行。
 */
export interface DragAnchor {
  groupId: string;
  index: number;
}

export interface DragSession {
  /** 拖拽开始那一行的实况（dragstart 当刻的 groupId/index/tabId） */
  origin: { groupId: string; index: number; tabId: string };
  /** 本次拖拽**全程**的「被拖行当前位置」。跨行共享同一份，行只读它、不拥有它。 */
  anchor: DragAnchor;
}

/**
 * 拖拽会话的唯一存放处。
 *
 * 整个文档同一时刻只可能有一次拖拽（浏览器的 dragstart/dragend 就是这么定的），
 * 所以会话级状态必须是**模块级单例**而不是任何一行的 ref —— 这正是原实现
 * 降级丢掉的语义。每次 dragstart 换新对象、每次换位换新对象，
 * 读到的永远是同一份「当前」状态，不存在行级 ref 那种"谁是源"的歧义。
 *
 * 浏览器 API（dragstart/dragover/drop/dragend）只在 DraggableTab.tsx 里出现，
 * 且只经本模块的四个入口触碰会话状态。
 */
let current: DragSession | null = null;

/** 当前拖拽会话；不在拖拽中返回 null。 */
export const getDragSession = (): DragSession | null => current;

/** dragstart：开一个新会话（源 = 发起拖拽的那一行）。 */
export const beginDragSession = (origin: { groupId: string; index: number; tabId: string }): void => {
  current = {
    origin: { ...origin },
    anchor: { groupId: origin.groupId, index: origin.index },
  };
};

/** dragend / drop：关闭会话。必须无条件调用，否则会漏到下一次拖拽上。 */
export const endDragSession = (): void => {
  current = null;
};

/**
 * 换位**真的派发出去**之后回写锚点：被移动项的新位置 = 换位目标下标。
 *
 * 为什么是精确值而不是又一次估算：同组换位后，被移动项的下标就是目标下标
 * （moveTab reducer 与 applyMoveTab 都是「取出后插入到目标下标」）；
 * 跨组时被移动项落到目标组的目标下标，源组少一项但不影响这个值。
 * 于是「把锚点写成落点坐标」= 被拖行的真位置，重排干净地停在最后一次换位之后。
 */
export const advanceDragAnchor = (anchor: DragAnchor): void => {
  if (!current) return;
  current.anchor = { groupId: anchor.groupId, index: anchor.index };
};

/** 落点行的可测量信息（真实实现传 getBoundingClientRect 的结果，测试传字面量） */
export interface RowRect {
  top: number;
  bottom: number;
}

/**
 * hover 决策的输入（纯数据）。
 *
 * ── 2026-10-11 P1：删掉 sourceGroupId / sourceIndex 两个死字段 ──────────
 * 这两个字段原本在探针里看起来是「源下标的第二个来源」，但 resolveHover 从头到尾
 * **只读 session.anchor**，从不读它们 —— 它们是死字段。留着比删掉更危险：
 *   · 调用方必须为它们编一个值（实测 DraggableTab 传的是**落点行**的
 *     groupId/index，即落点自己的下标，正是 P1「搬错行」那个 bug 的取值）；
 *   · 测试也照着传，于是 20+ 条用例在喂一组「实现不读、但看起来该对」的值；
 *   · 将来谁让 resolveHover 改读这两个字段（顺手的重构），整套测试**照样全绿**，
 *     而 P1 会以「拖 b 搬走 a」的形态复活——静默数据损坏。
 * 结构上让「第二个来源」不存在，比靠注释提醒「别读它」可靠：删掉之后，
 * 想读源下标只有 session.anchor 一条路，P1 在类型层面无处可藏。
 * （同批删除的还有 targetIndex：它与 target.index 重复，resolveHover 也只用
 * target.index。保留单一来源同样是为了消除「两个真值」的结构性风险。）
 */
export interface HoverProbe {
  /** 落点行的矩形；null = 元素尚未挂载/已被移除，本轮不换位 */
  rect: RowRect | null;
  clientY: number;
}

/** hover 决策的结果。`null` = 本轮不换位。 */
export interface HoverDecision {
  sourceGroupId: string;
  sourceIndex: number;
  targetGroupId: string;
  targetIndex: number;
}

/**
 * 落点 hover 的一次决策：这一轮换不换位、换位的四个参数是什么。
 *
 * 抽成纯函数（而不是留在组件里）有两个不可替代的理由：
 *  1. 它是**源下标的唯一解析点**。组件里再也拿不到第二份源下标（行 ref、
 *     闭包 index 全部退场），「读成落点下标」这种缺陷在结构上无处可藏。
 *  2. 它能被脏形状 fixture 直接测：相邻行、跨组落到下标 0、单元素源组、
 *     非等长组、一次拖拽多次换位、双栏取组内下标 —— 全是旧实现搬错行的现场。
 *
 * @param session 本次拖拽会话；null（不在拖拽中）时一律不换位。
 */
export const resolveHover = (
  session: DragSession | null,
  target: { groupId: string; index: number },
  probe: HoverProbe
): HoverDecision | null => {
  if (!session) return null;
  if (!probe.rect) return null;

  const sourceGroupId = session.anchor.groupId;
  const sourceIndex = session.anchor.index;

  // 就在自己身上：什么都不做（同组否则会原地来回抖动）
  if (sourceGroupId === target.groupId && sourceIndex === target.index) return null;

  const hoverMiddleY = (probe.rect.bottom - probe.rect.top) / 2;
  if (hoverMiddleY <= 0) return null;
  const hoverPercentage = (probe.clientY - probe.rect.top - hoverMiddleY) / hoverMiddleY;

  // 同组内：往下拖时，目标行上半区才换位；往上拖时反之。防止边界抖动。
  if (sourceGroupId === target.groupId && sourceIndex < target.index && hoverPercentage < -EDGE_THRESHOLD) return null;
  if (sourceGroupId === target.groupId && sourceIndex > target.index && hoverPercentage > EDGE_THRESHOLD) return null;

  return {
    sourceGroupId,
    sourceIndex,
    targetGroupId: target.groupId,
    targetIndex: target.index,
  };
};
