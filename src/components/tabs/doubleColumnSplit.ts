/**
 * 双栏布局：把**已排好序**的会话切成左右两栏（判据层，纯函数）。
 *
 * ── 为什么是「切一刀」而不是「贪心轮流放」 ────────────────────────────────
 * v1.25.1 的实现是贪心：按标签数把下一张卡塞进当前更矮的那一栏。
 * 它把两栏底部对得很齐，但**打乱了顺序**：DOM 序（= 键盘 Tab 序 = 读屏顺序）
 * 变成 `1,4,5 | 2,3,6`，与用户选的排序不符 —— 2026-10-23 审计 R-11 的原始缺陷。
 *
 * 现在改成**连续切一刀**：左栏拿前 k 张、右栏拿后 k+1..n 张
 * ⇒ 两栏从上往下读（先读完左栏再读右栏）**恰好就是排序序**，
 * 而每栏内部又各自是一个独立的纵向堆叠 ⇒ 卡片不会再被两两配成一行，
 * 「一张高一张矮、短的那张下面留一大块空白」的洞也随之消失。
 *
 * ⇒ **顺序**和**没有洞**这两件事，这一次可以同时成立，不必二选一。
 *
 * ── k 怎么选 ─────────────────────────────────────────────────────────────
 * 穷举所有连续切法，取「两栏估计高度差最小」的那个；平手时取更靠前的那刀
 * （结果确定，不依赖遍历顺序）。O(n)，会话数量级下无意义开销。
 *
 * ── 高度怎么估 ───────────────────────────────────────────────────────────
 * `1 + tabs.length`：每张卡固定有一行卡头（≈ 三条标签行里的一条），
 * 每条标签一行。**不用像素、也不用真实渲染高度**，因为它必须：
 *   · 稳定 —— 折叠/展开一张卡不该让卡片在两栏之间跳来跳去，
 *     所以估计值只看标签数，**不看** `collapsed`；
 *   · 可判 —— 守卫能独立算出同一个 k。
 * 这是估计值，不是精确高度：两栏底边齐不齐，取决于卡片里还混着
 * 「已折叠」「标签被过滤掉」等真实高度差。**目标是消除结构性的洞，不是像素级等高。**
 */
import type { TabGroup } from '@/types/tab';

/** 卡头占的「高度单位」：一行卡头 ≈ 一条标签行（实测 53px vs 54px）。 */
const CARD_CHROME_WEIGHT = 1;

/** 一张会话卡的估计高度（单位 = 一条标签行高）。 */
export function estimateCardWeight(group: Pick<TabGroup, 'tabs'>): number {
  return CARD_CHROME_WEIGHT + group.tabs.length;
}

export interface TwoColumns<T> {
  left: readonly T[];
  right: readonly T[];
}

/**
 * 把已排序的会话切成左右两栏（**保序**：左栏在前、右栏在后）。
 * 空列表 ⇒ 两栏都空；只有一张卡 ⇒ 全在左栏。
 */
export function splitIntoTwoColumns<T extends Pick<TabGroup, 'tabs'>>(
  groups: readonly T[]
): TwoColumns<T> {
  if (groups.length <= 1) return { left: groups.slice(), right: [] };

  const weights = groups.map(estimateCardWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let bestSplit = 1;
  let bestDiff = Number.POSITIVE_INFINITY;
  let prefix = weights[0] ?? 0;
  for (let split = 1; split < groups.length; split += 1) {
    if (split > 1) prefix += weights[split - 1] ?? 0;
    const diff = Math.abs(total - 2 * prefix);
    // 严格小于 ⇒ 平手时保留更靠前的那刀（结果与遍历顺序无关）。
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = split;
    }
  }

  return { left: groups.slice(0, bestSplit), right: groups.slice(bestSplit) };
}
