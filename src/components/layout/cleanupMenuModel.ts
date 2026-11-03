/**
 * 「清理旧会话」子菜单的**行模型**（纯函数，2026-11-03）。
 *
 * ── 为什么把「哪些行出现」从 JSX 里抽出来 ──────────────────────────────────
 *
 * 这一组规则不是「样式」，是**判据**：
 *   · 算出来 0 条的档位**不出现**（没有可清理的就不该占一行）；
 *   · 没有锁定的会话时，「保留锁定」那一行**不出现**（保留 0 个 = 与「全删」
 *     同一件事，摆两行只会让人多点一次）；
 *   · 「含锁定」那一行**始终出现**（它是「删除所有会话」这个动作本身）；
 *   · 只有两档「全部」带副标题（256px 的菜单塞不下四段小字，而那两档的后果
 *     最重，必须当场说清）。
 *
 * 规则埋在 JSX 里 ⇒ 只能靠「源码里有没有某段文字」来测，而那种守卫**零检测力**
 * （把整段换成空数组它照样绿）。⇒ 抽成纯函数：规则可以**按行为**测，
 * 而界面只负责把行渲染出来。
 *
 * ── 执行路径也在这一行上 ──────────────────────────────────────────────────
 *
 * `path: 'deleteAll'` 的那一档走**既有**的 `deleteAllGroups` 路径（含覆盖上传），
 * 一个字节都不改 —— 它的语义就是「全删，锁定也删」；其余四档走新的
 * `deleteGroups`（按 id 清单删、执行时刻再判锁定）。
 */
import type { CleanupPlan, CleanupTier } from '@/core/cleanupPlan';
import { cleanupTierLabel } from '@/core/cleanupPlan';
import {
  deleteAllKeepLockedMenuWarning,
  deleteAllMenuWarning,
  type DeleteAllDisclosure,
} from './deleteAllMessages';

/** 子菜单里的一行。 */
export interface CleanupMenuRow {
  /** 这一行对应哪一档。 */
  tier: CleanupTier;
  /** 行文字（判据层给的，界面不自己拼）。 */
  label: string;
  /**
   * 副标题（**只有两档「全部」有**）。
   *
   * 两行的小字说的是同一件事的**反面**：「含锁定」那行说「锁定的也会被删」，
   * 「保留锁定」那行说「锁定的会保留」⇒ 两行必须都带着小字出现。
   */
  warning?: string;
  /** 这一行走哪条执行路径。 */
  path: 'deleteGroups' | 'deleteAll';
}

/** 四个时间档（按菜单里的顺序）。 */
const TIME_TIERS: readonly CleanupTier[] = ['1m', '3m', '6m', '12m'];

/**
 * 六档 → 界面上真正要渲染的行。
 *
 * ⚠️ 入参必须是**同一次判定**的六份计划（`planCleanup` 各算一次，源同一份
 * 磁盘读、now 同一个）⇒ 菜单行与确认框的数字不会对不上。
 */
export const cleanupMenuRows = (
  plans: Readonly<Record<CleanupTier, CleanupPlan>>,
  disclosure: DeleteAllDisclosure
): CleanupMenuRow[] => {
  const rows: CleanupMenuRow[] = [];

  for (const tier of TIME_TIERS) {
    const plan = plans[tier];
    // 0 条 ⇒ 不摆这一行（没有可清理的就不该占一行）。
    if (plan.groupCount === 0) continue;
    rows.push({ tier, label: cleanupTierLabel(plan), path: 'deleteGroups' });
  }

  const keepLocked = plans['all-keep-locked'];
  // 「保留锁定」要同时有两边才成立：有锁定的要保留，且还有未锁定的可清。
  if (keepLocked.groupCount > 0 && keepLocked.lockedSkippedCount > 0) {
    rows.push({
      tier: 'all-keep-locked',
      label: cleanupTierLabel(keepLocked),
      warning: deleteAllKeepLockedMenuWarning({
        lockedCount: keepLocked.lockedSkippedCount,
        ...disclosure,
      }),
      path: 'deleteGroups',
    });
  }

  const all = plans.all;
  rows.push({
    tier: 'all',
    label: cleanupTierLabel(all),
    warning: deleteAllMenuWarning({ lockedCount: all.lockedCount, ...disclosure }),
    path: 'deleteAll',
  });

  return rows;
};
