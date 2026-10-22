/**
 * 搜索页「删除全部匹配结果」的**计数与执行**必须同源（2026-10-23 审计 DS-43-13）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 确认框里的数字用的是「命中的标签总数」（含锁定会话里的），
 * 而真正执行时锁定会话被跳过：
 *
 *   确认框说：删除 5 个标签？/ 永久移除这 5 条标签记录（锁定会话除外）
 *   实际发生：只删了 3 条（另外 2 条在锁定会话里）
 *
 * ⇒ 用户以为删了 5 条、实际少了 3 条 —— 这是**数据安全**层面的谎报，
 *   不是文案洁癖。用户据此判断「我清干净了」，而其实有两条还在。
 *
 * ── 为什么根因是「两处各数各的」 ──────────────────────────────────────────
 * 计数（确认框）与执行（删除循环）各写了一遍「哪些会被删」的判据：
 * 计数用「总数」，执行用「跳过锁定组」。两处一旦漂移，就是本缺陷。
 *
 * ⇒ 判据收成**一处**（`planBulkDelete`），计数与执行都从它派生：
 *   · `bulkDeleteConfirmCopy` —— 确认框的标题与正文（数字 = 真正会删的条数）；
 *   · `runBulkDelete` —— 真正执行删除的那一批（与计数**同一个集合**）。
 *
 * ── 为什么抽成纯函数（.ts 而不是留在 .tsx 里） ────────────────────────────
 * 判据层不该依赖 DOM：本仓没有 jsdom，组件没法在 node 里点按钮。
 * 抽出来之后，「确认框里的数字 == 真正删掉的条数」就是一条**可断言的事实**：
 * 喂一组带锁定组的匹配项，看数字与实际删除次数是不是同一个。
 */
import type { TabGroup } from '@/types/tab';
import { bulkActionTitle } from '@/components/search/searchBrowseMode';

/** 一条匹配（判据只需要知道它属于哪个会话 —— 锁不锁在会话上）。 */
export interface BulkDeleteMatch {
  /**
   * 这条匹配所属的会话。
   *
   * 只取 `isLocked`：这是**判据要用到的全部信息**，也是这条不变量
   * 唯一依赖的会话属性。写成 `Pick` 而不是整个 `TabGroup`，
   * 是为了让「这条判据还依赖哪些会话字段」一眼可见 —— 将来若有人
   * 让它悄悄依赖别的字段，类型会先把这件事说出来。
   */
  group: Pick<TabGroup, 'isLocked'>;
}

/** 批量删除的计划：真正会被删掉的那些 + 被跳过的那些。 */
export interface BulkDeletePlan<T> {
  /** 真正会被删掉的匹配项（**不含**锁定会话里的）。 */
  deletable: T[];
  /** 因为会话被锁定而跳过的条数。 */
  skipped: number;
}

/**
 * 算出「这次批量删除到底会删哪些」。
 *
 * 判据只有一条：**会话被锁定的跳过** —— 锁定承诺「防误删」，
 * 而删除不可撤销（无回收站）。这与逐条删除、批量恢复是同一口径。
 */
export const planBulkDelete = <T extends BulkDeleteMatch>(
  matches: T[]
): BulkDeletePlan<T> => {
  const deletable = matches.filter(match => !match.group.isLocked);
  return { deletable, skipped: matches.length - deletable.length };
};

/**
 * 确认框需要的文案与那个数字。
 */
export interface BulkDeleteConfirmCopy {
  /** 确认框标题。 */
  title: string;
  /** 确认框正文。 */
  message: string;
  /** 真正会被删掉的条数（= 标题与正文里的那个数字）。 */
  count: number;
}

/**
 * 确认框的标题与正文。
 *
 * ⚠️ 数字必须来自 `planBulkDelete`（**不是**匹配总数）——
 *   否则确认框说的 N 恒 ≥ 真正删掉的数（DS-43-13）。
 *
 * 「（锁定会话除外）」那句在计数修正后**仍然成立**：计数已经不含锁定
 * 会话里的那些，括号说的是「锁定会话里的不会被删」。
 */
export const bulkDeleteConfirmCopy = (
  mode: 'search' | 'browse',
  matches: BulkDeleteMatch[]
): BulkDeleteConfirmCopy => {
  const count = planBulkDelete(matches).deletable.length;
  return {
    count,
    title: bulkActionTitle(mode, '删除', count),
    message:
      `将从所属会话中永久移除这 ${count} 个标签页（锁定会话除外），` +
      '删除后无法恢复。确认继续吗？',
  };
};

/**
 * 「一条都删不掉」时的说明（2026-10-23 审计 P1-5）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 全部命中都在锁定会话里时，`deletable` 为空 ⇒ 确认框变成
 * 「删除 0 个标签页？」/「将从所属会话中永久移除这 0 个标签页（锁定会话除外）…」
 * ⇒ 用户点「确认」然后**什么都不会发生**，而且**没有任何提示**。
 *
 * ⇒ 0 条时**不该弹确认框**：该做的是说清「它们都在锁着的会话里，
 *   不会被删」并给出路（先去解锁）。
 */
export interface BulkDeleteBlockedCopy {
  /** 一句话说明（直接给用户看的那句）。 */
  message: string;
}

/**
 * 「这次一条都删不掉」时的说明；**删得掉就返回 null**。
 *
 * @param matches 命中的那些（判据只需要知道它们属于哪个会话）。
 * @returns 该不该拒绝执行 + 拒绝时的那句话；`null` = 可以删。
 */
export const bulkDeleteBlockedCopy = (
  matches: BulkDeleteMatch[]
): BulkDeleteBlockedCopy | null => {
  const plan = planBulkDelete(matches);
  if (plan.deletable.length > 0) return null;
  if (plan.skipped === 0) return null; // 一条都没命中 ⇒ 不是「被锁住了」
  return {
    message:
      `这 ${plan.skipped} 个标签页都在已锁定的会话里，不会被删除。` +
      '请先解锁对应的会话，再删除。',
  };
};

/**
 * 一次批量删除的**结果**。
 *
 * 为什么不再只回一个数字（2026-10-23 审计 DS-43-14）：
 * 删除是**串行**的，第 k 条失败后后面的**根本不执行** ⇒
 * 「删掉了几个」这一个数字不足以说明发生了什么 ——
 * 用户既不知道前面删掉了多少，也不知道后面还剩多少没动。
 */
export interface BulkDeleteRunResult {
  /** 真正删掉的条数（= 失败之前那几条）。 */
  deleted: number;
  /** 失败发生在第几条（1-based，指「真正会删的」那个序列）。undefined = 没失败。 */
  failedAt?: number;
  /** 失败原因（原始异常）。 */
  error?: unknown;
  /** 失败之后还剩几条没动。 */
  remaining: number;
}

/**
 * 真正执行批量删除。
 *
 * 删哪些由 `planBulkDelete` 决定 ⇒ 与确认框里的数字**同一个集合**。
 *
 * 失败语义：**在第一条失败处停下**（后面的不再执行），
 * 并如实回报「第几条失败、前面删了几个、还剩几个没动」。
 */
export const runBulkDelete = async <T extends BulkDeleteMatch>(
  matches: T[],
  deleteOne: (match: T) => Promise<void>
): Promise<BulkDeleteRunResult> => {
  const { deletable } = planBulkDelete(matches);
  for (let index = 0; index < deletable.length; index += 1) {
    try {
      await deleteOne(deletable[index]);
    } catch (error) {
      return {
        deleted: index,
        failedAt: index + 1,
        error,
        remaining: deletable.length - index - 1,
      };
    }
  }
  return { deleted: deletable.length, remaining: 0 };
};

/**
 * 部分失败时的那句话（2026-10-23 审计 DS-43-14）。
 *
 * 三笔账必须都在：第几条失败 / 前面删了几个 / 还剩几个没动。
 * 只说「删除失败，请重试」＝ 用户什么都不知道。
 *
 * @param result  `runBulkDelete` 的结果。
 * @param reason  失败原因（人话，由调用方给出）；省略就不带这句。
 */
export const bulkDeleteFailureMessage = (
  result: BulkDeleteRunResult,
  reason?: string
): string => {
  const head =
    `第 ${result.failedAt ?? 0} 条删除失败：` +
    `前面已删掉 ${result.deleted} 条，剩下 ${result.remaining} 条没有删除`;
  return reason ? `${head}。${reason}` : head;
};
