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

/** 确认框需要的文案与那个数字。 */
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
    title: `${bulkActionTitle(mode, '删除')}${count} 个标签页？`,
    message:
      `将从所属会话中永久移除这 ${count} 个标签页（锁定会话除外），` +
      '删除后无法恢复。确认继续吗？',
  };
};

/**
 * 真正执行批量删除。
 *
 * 删哪些由 `planBulkDelete` 决定 ⇒ 与确认框里的数字**同一个集合**。
 * 单条失败会向上抛（调用方统一处理），语义与原先的循环一致。
 *
 * @returns 真正删掉的条数（= 确认框里的那个数字）。
 */
export const runBulkDelete = async <T extends BulkDeleteMatch>(
  matches: T[],
  deleteOne: (match: T) => Promise<void>
): Promise<number> => {
  const { deletable } = planBulkDelete(matches);
  for (const match of deletable) {
    await deleteOne(match);
  }
  return deletable.length;
};
