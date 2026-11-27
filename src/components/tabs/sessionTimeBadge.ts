/**
 * 会话卡片上的**时间位**文案 —— 显示的是「当前排序依据的那个时间」。
 *
 * ── 为什么必须跟着排序键换（v1.33）────────────────────────────────────────
 *
 * 修复前卡片时间位永远显示 `createdAt`（保存时间）。用户在「最近使用」排序下
 * 看到列表按一个**没显示出来**的时间排 —— 顺序看起来像随机的；
 * 更糟的是同一张卡在「最近修改」下也写着保存时间，而它明明是按修改时间浮上来的。
 * ⇒ 时间位必须说「你现在看到的顺序是按哪个时间排的」，并且**带上前缀**，
 * 否则「今天」到底是保存、修改还是使用的今天，用户分不出来。
 *
 * ── 四种显示（与排序键一一对应）─────────────────────────────────────────
 *
 * · 最近保存 / 名称 / 会话大小 → `保存 · 今天`
 *   （导入件沿用既有 `导入 · 今天` —— 它的保存时间未知，见
 *    `@/core/sessionSaveTime`）
 * · 最近修改 → `修改 · 昨天`（数据源与排序同一处：`lastActivityAt`）
 * · 最近使用 + 有记录 → `使用 · 昨天`
 * · 最近使用 + **没有记录** → **不渲染**（`null`）—— 不写「未使用」：
 *   那会把「这台设备上没有记录」说成一种状态，而它并不是会话的属性。
 *
 * ⚠️ 时间戳非法时沿用 `formatRelativeTime` 的「时间未知」，不显示
 *   「Invalid Date」（见 `@/utils/sessionPresentation`）。
 */
import { lastActivityAt, type SessionSortKey, type SortableSession } from '@/core/sessionSort';
import { hasUnknownSaveTime } from '@/core/sessionSaveTime';
import { formatRelativeTime } from '@/utils/sessionPresentation';

/** 时间位需要的最小会话形状（`importedAt` 用于「保存时间未知」的导入件）。 */
export type TimeBadgeSession = SortableSession & { importedAt?: string };

/**
 * @param group      会话（真实 `TabGroup` 直接满足这个形状）
 * @param sort       当前排序键（`settings.sessionSort`）
 * @param lastUsedAt 这个会话在本机的最近使用时间（没有则不传）
 * @returns 时间位文案；`null` = 这一格不渲染
 */
export function formatSessionTimeBadge(
  group: TimeBadgeSession,
  sort: SessionSortKey,
  lastUsedAt?: string
): string | null {
  if (sort === 'recentUsed') {
    if (typeof lastUsedAt !== 'string' || lastUsedAt.length === 0) return null;
    return `使用 · ${formatRelativeTime(lastUsedAt)}`;
  }

  if (sort === 'accessed') {
    const at = lastActivityAt(group);
    // `lastActivityAt` 没有任何合法时间时返回 -Infinity —— 交给
    // formatRelativeTime 的空串分支输出「时间未知」（不要 `new Date(-Infinity)`
    // 再 `toISOString()`，那会抛 RangeError）。
    const stamp = Number.isFinite(at) ? new Date(at).toISOString() : '';
    return `修改 · ${formatRelativeTime(stamp)}`;
  }

  // 最近保存 / 名称 / 会话大小：显示保存时间；导入件（保存时间未知）沿用
  // 既有的「导入 · …」说法，不把它伪装成「保存」。
  if (hasUnknownSaveTime(group) && group.importedAt) {
    return `导入 · ${formatRelativeTime(group.importedAt)}`;
  }
  return `保存 · ${formatRelativeTime(group.createdAt)}`;
}
