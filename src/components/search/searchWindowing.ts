/**
 * 搜索结果的**条数上限**决策（纯函数，无 DOM、无 React，可直接单测）。
 *
 * ── 这道上限要防的具体事故 ──────────────────────────────────────────────
 *
 * 2026-10-20 审计 A-11（真机实测，`scripts/prod-stress.mjs`）：
 * 400 会话 × 20 标签 = 8000 个标签，搜一个宽泛词 ⇒ 搜索响应 **1250ms**、
 * 搜索态 DOM **91311** 节点、滚动最大帧间隔 **88ms（≈11fps）**。
 * 而「找回会话」是本产品的核心动作，搜索是最高频路径。
 *
 * ⇒ 命中 5000 条时用户要的不是 5000 行，而是**最相关的那些**。
 * `AdvancedSearch` 已按 score 降序排好 ⇒ 截断是排序的兑现，不是信息损失。
 *
 * ── 这道上限管住了什么、没管住什么（2026-11-03 复核）──────────────────────
 *
 * 管住：
 *   · 保留的结果组数 —— `visibleSessionResults` 按整组保留，每组至少命中 1 条
 *     ⇒ 组数 ≤ 上限（卡头数因此有界）；
 *   · 标签条数通常 ≤ 上限（最后一组会略微超出，见下）。
 * 没管住：
 *   · **单个组内的行数**：一个会话命中 800 条时，`used >= visible` 要等这一组
 *     整组计入之后才成立 ⇒ 那 800 行仍会一次进 DOM。
 *   → 组内行由 `SearchMatchRows.tsx` 按视口窗口化（与主列表共用同一套机制）。
 *
 * ── 曾经计划的「分片渲染」已删除（2026-11-03）──────────────────────────
 *
 * 本文件曾有 `computeVisibleChunks` / `chunkResults` / `SEARCH_CHUNK_SIZE`
 * 三个导出，**零生产调用点**，只有单测在测它们 —— 典型的「守卫全绿、
 * 机制不存在」（2026-10-22 架构审计 D1）。
 *
 * 为什么不把它接上线：2026-11-03 重新实测（400 会话 × 20 标签）——
 * 搜索响应 367ms（其中 300ms 是搜索框的故意防抖）、搜索态 DOM 3,892 节点、
 * 滚动最大帧间隔 15ms。条数上限已经把问题挡住；再挂一套没有真实调用历史的
 * 分片窗口化，只会与组内行窗口化互相冲突。⇒ 代码与单测一并删除。
 *
 * 守卫：
 *   · tests/searchWindowing.test.ts（截断判据 + 接线）
 *   · tests/guards/searchRowsWindowing.test.ts（渲染产物级：远组只留等高占位）
 */

/**
 * 搜索结果的展示上限。
 *
 * 上限取 200 条：远超「一次能看完」的上限（一条约 37px，200 条 ≈ 7400px），
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
