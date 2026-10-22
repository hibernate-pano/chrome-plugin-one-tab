/**
 * 搜索结果的**分片渲染**决策（纯函数，无 DOM、无 React，可直接单测）。
 *
 * ── 为什么主列表虚拟化了、搜索结果没有（2026-10-20 审计 A-11）──────────
 *
 * 主列表早就有虚拟化（`lazyTabRows.ts` + `useNearViewport`）：
 * 「同一时刻存在于 DOM 里的标签行数」与视口相关，而不是与数据总量相关。
 *
 * 但**搜索结果这条路完全没做**。实测（`scripts/prod-stress.mjs`，400 会话 × 20 标签）：
 *
 *   | 搜索词   | 搜索响应 | 搜索态 DOM 节点 | 滚动最大帧间隔 |
 *   |----------|----------|-----------------|----------------|
 *   | watermark| 447ms    | 91311           | 12ms          |
 *   | https    | **1250ms**| **91311**       | **88ms（≈11fps）**|
 *
 * 而「找回会话」是本产品的**核心动作**，搜索是最高频路径。宽泛关键词
 * （域名片段、协议名、项目代号）非常常见 —— 一用就是 9 万个 DOM 节点、
 * 1.25 秒卡顿、滚动掉到 11fps。这正是「用了一年之后产品垮掉」的典型形态。
 *
 * ── 为什么用「分片」而不是逐行虚拟化 ───────────────────────────────────
 *
 * 搜索结果的结构是「会话分组 → 组内命中标签行」，两层。逐行虚拟化要同时处理
 * 「组头不滚动但组内行滚动」的跨容器高度对齐 —— 复杂且容易出现滚动漂移。
 *
 * 分片（chunking）把整个结果列表按**固定条数**切成片，一次只渲染接近视口的片。
 * 好处：
 *   · 纯函数可判定，不需要测量任何元素；
 *   · 占位高度是「片数 × 估算行高」，与真实高度有偏差，但**偏差按片累加**，
 *     用「只在视口附近渲染 + 滚动条按估算」会漂。
 *
 * ── 那怎么解决高度漂移？ ────────────────────────────────────────────────
 *
 * **不靠估算，靠「超量渲染 + 一次性截断」**：
 *   · 先按**真实** DOM 测量出前 N 个会话分组的实际高度（渲染后的 ref），
 *     用它把后面未渲染的部分按**实测均值**估算；
 *   · 估算误差只影响「未渲染区」的高度，而未渲染区在视口外 ——
 *     用户滚到那里时它会变成已渲染，高度被真实值替换，滚动条随之微调。
 *     这是所有虚拟列表都在做的事（react-window 也是）。
 *
 * 但对本产品来说，更简单也更安全的做法是：**给结果总数设一个上限**。
 * 搜索命中 5000 条时，用户其实只想看最相关的 50 条 —— 而 `AdvancedSearch`
 * 已经按**相关度**（score）排过序了。截断不是损失，是**排序的兑现**：
 * 最相关的在最前面，剩下的告诉用户「还有 N 条，请细化关键词」。
 *
 * 所以本模块做两件事：
 *   1. `selectVisibleResults` —— 按**分片**决定渲染哪些会话分组（视口感知）；
 *   2. `buildResultWindow` —— 决定「显示前 K 条 + 还有多少」的截断。
 *
 * ── ⚠️ 2026-10-22 架构审计 D1：分片**还没接线** ───────────────────────────
 *
 * 本文件里 `computeVisibleChunks` / `chunkResults` / `SEARCH_CHUNK_SIZE`
 * 三个导出**零生产调用点** —— 只有 `tests/searchWindowing.test.ts` 在测它们。
 * **生产里真正生效的只有 `buildResultWindow`**（命中 200 条上限那道防线）。
 *
 * 为什么必须写清楚：搜索结果这条路的「渲染上限」曾被注释与单测描述成
 * 「两道防线」，而第二道（分片）根本不存在 —— 200 条截断只管住**标签条数**，
 * **管不住卡头数**（400 组各命中 1 个标签时，200 组全部渲染）。
 *
 * ⇒ 接线前不许在别处声称「搜索路径已做分片」。
 *   接线的前置条件是给 `useNearViewport` 加「当前第几片」的序号接口
 *   （它现在是**按元素**判定的，没有序号概念）。
 *   守卫见 tests/guards/noPhantomMechanisms.test.ts。
 */

export interface SearchResultChunk<T> {
  /** 这一片里的结果。 */
  items: T[];
  /** 这一片的起始下标（用于 key 与「还有 N 条」的计算）。 */
  startIndex: number;
}

/** 一片装多少个会话分组。 */
export const SEARCH_CHUNK_SIZE = 8;

/**
 * 按「接近视口」的分片下标，算出该渲染哪些片。
 *
 * @param totalCount 结果总条数
 * @param activeChunkIndex 当前视口落在第几片
 * @param chunkSize 每片条数
 * @param overscan 视口上下各多渲染几片（提前渲染，滚动时不露白）
 * @returns 需要渲染的片下标集合（升序）
 */
export function computeVisibleChunks(
  totalCount: number,
  activeChunkIndex: number,
  chunkSize: number = SEARCH_CHUNK_SIZE,
  overscan: number = 1
): number[] {
  if (totalCount <= 0 || chunkSize <= 0) return [];
  const chunkCount = Math.ceil(totalCount / chunkSize);
  const center = Math.min(Math.max(activeChunkIndex, 0), chunkCount - 1);
  const from = Math.max(0, center - overscan);
  const to = Math.min(chunkCount - 1, center + overscan);
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * 把结果列表切成片。
 */
export function chunkResults<T>(
  items: T[],
  chunkSize: number = SEARCH_CHUNK_SIZE
): SearchResultChunk<T>[] {
  if (chunkSize <= 0) return [];
  const out: SearchResultChunk<T>[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push({ items: items.slice(i, i + chunkSize), startIndex: i });
  }
  return out;
}

/**
 * 搜索结果的展示上限。
 *
 * 为什么要截断：命中 5000 条时，用户要的不是 5000 行，而是**最相关的那些**。
 * `AdvancedSearch` 已按 score 降序排好，截断即排序的兑现。
 *
 * 上限取 200 条：远超「一次能看完」的上限（一条约 44px，200 条 ≈ 8800px），
 * 又保证 DOM 节点数有界。
 */
export const SEARCH_RESULT_DISPLAY_LIMIT = 200;

export interface ResultWindow {
  /** 要展示的结果。 */
  visible: number;
  /** 被截断掉的条数（0 表示全部展示）。 */
  hidden: number;
  /** 是否发生了截断。 */
  truncated: boolean;
}

/**
 * 决定展示多少条结果。
 */
export function buildResultWindow(
  totalCount: number,
  limit: number = SEARCH_RESULT_DISPLAY_LIMIT
): ResultWindow {
  const capped = Math.max(0, limit);
  const visible = Math.min(totalCount, capped);
  const hidden = Math.max(0, totalCount - visible);
  return { visible, hidden, truncated: hidden > 0 };
}

/**
 * 截断提示的文案。
 *
 * 「还有 N 条没显示」是**必要信息**：不说的话，用户会以为搜索只找到了这么几条
 * （2026-10-19 审计 F-5 的同类问题：用户以为自己的备份坏了，其实是「已存在、
 * 跳过」）。措辞要给出**下一步动作**（细化关键词），而不是只报一个数字。
 */
export const resultTruncationMessage = (hidden: number): string =>
  `还有 ${hidden} 条匹配结果未显示（已按相关度排序，显示最靠前的部分）。` +
  `请补充关键词或使用筛选条件进一步缩小范围。`;
