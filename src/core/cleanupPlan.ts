/**
 * 「清理旧会话」的**判据层**（纯函数，2026-10-26）。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────────────
 *
 * 菜单里有六个档位（一个月 / 三个月 / 六个月 / 一年 / 「保留锁定」/「含锁定」），
 * 每一档都要回答同一组问题：**要删哪些会话、共多少标签页、其中多少条保存时间
 * 未知、多少条因锁定被跳过、要删的名字是什么**。
 *
 * 这五个数字必须**出自同一次判定**：菜单行写着「三个月前的会话（12）」、
 * 确认框却只删 11 个，就是一句**当场就能戳破**的谎。所以它们全部由
 * `planCleanup` 一次算完（调用方负责用同一次磁盘读喂进来），而不是让界面层
 * 各自 `filter` 一遍 —— 判据抄两遍，迟早漂成两个说法。
 *
 * 本模块**不读存储、不改 Redux**：只吃一个 `TabGroup[]` 与一个 `now`。
 * 好处是「三月的最后一天」这类边界能在单测里把日期钉死（见 `monthsBefore`）。
 *
 * ── 一条会话「有多旧」的参考时间 ──────────────────────────────────────────
 *
 *   `ref = 保存时间已知 ? createdAt : importedAt`
 *
 * 「保存时间未知」这件事**只从** `@/core/sessionSaveTime` 的
 * `hasUnknownSaveTime` 出 —— 本文件**不内联** `!!g.importedAt`（那一句会把
 * 「JSON 备份导入的会话」也误判成未知，见该模块文件头）。未知时间件用
 * `importedAt`（进本机的时刻）参与年龄计算：真实保存时间只可能**早于或等于**
 * 导入时间 ⇒「导入于三个月前」⇒「保存于三个月前」必然成立，用它截断不会误伤；
 * 反过来（一律排除未知时间）会让去年导入的几百条旧收藏**永远清不掉**。
 *
 * 时间戳解析不出来（`Date.parse` 得 `NaN`）⇒ **不删**：破坏性路径宁可少删，
 * 也不能把「时间读不出来」当成「很旧」。
 *
 * ── 锁定的三档口径 ────────────────────────────────────────────────────────
 *
 * · 时间档：锁定会话**不清理**，且只有「本来够旧」的锁定会话才计入
 *   `lockedSkippedCount`（新品本来就不会被删，说它「被跳过」是另一个谎）。
 * · `'all-keep-locked'`：「保留锁定」**就是这一档的名字** ⇒ 跳过全部锁定、
 *   计入 `lockedSkippedCount`。
 * · `'all'`：语义是「全删」⇒ 不跳过锁定，`lockedSkippedCount` 恒为 0
 *   （确认框会另行点名锁定条数，走既有的 `deleteAll*` 文案）。
 *
 * 两档「全部」都**不看时间**，`unknownTimeCount` 恒为 0（这一档没有年龄筛选，
 * 「按导入时间计算」那句话在这里没有意义，说它等于多一句噪声）。
 *
 * ── 名字预览为什么在这里排序 ──────────────────────────────────────────────
 *
 * 确认框要列「将删的名字」，而且**最新的在前**（用户更容易认出近期保存的会话，
 * 也更容易发现「这条我明明还在用」）。排序用与年龄判定**同一个**参考时间，
 * 避免「按 A 时间选、按 B 时间排」这种两套口径。只截取前几条由调用方决定
 * （本仓确认框最多列 6 个），判据层不替它定。
 */
import { hasUnknownSaveTime } from './sessionSaveTime';
import type { TabGroup } from '../types/tab';

/** 六个档位。⚠️ 菜单行永远叫「删除所有会话」，不引入「删除全部会话」这个第二叫法。 */
export type CleanupTier = '1m' | '3m' | '6m' | '12m' | 'all-keep-locked' | 'all';

/** 时间档的窄类型（从联合里派生，避免另抄一份清单）。 */
type TimeTier = Extract<CleanupTier, '1m' | '3m' | '6m' | '12m'>;

/** 时间档 → 向前回溯的月数。 */
const TIER_MONTHS: Readonly<Record<TimeTier, number>> = {
  '1m': 1,
  '3m': 3,
  '6m': 6,
  '12m': 12,
};

const isTimeTier = (tier: CleanupTier): tier is TimeTier =>
  tier === '1m' || tier === '3m' || tier === '6m' || tier === '12m';

/**
 * `now` 往前 `months` 个**日历月**。
 *
 * ── 为什么必须把「日」钳到目标月的最后一天 ────────────────────────────────
 *
 * `Date.prototype.setMonth` 对超出的日会**溢出到下一个自然月**：
 * 3 月 31 日 `setMonth(1)`（2 月）得到 **3 月 3 日**（31 − 28 = 3）。
 *
 * 而清理判据是「参考时间 **<** 截止点」。截止点从「2 月 28 日」被推到
 * 「3 月 3 日」= **截止点变晚** ⇒ 2 月 28 日到 3 月 3 日之间保存的会话
 * 也被判成「够旧」⇒ **多删**。多删是不可撤销的（没有回收站），
 * 所以这里宁可用一个稍早的边界，也不让日期溢出。
 *
 * 闰年由 `new Date(year, month + 1, 0)` 自己处理（2024 年 2 月是 29 天），
 * 不写「二月 = 28」这种会在闰年出错的特判。
 */
export function monthsBefore(now: Date, months: number): Date {
  const result = new Date(now.getTime());
  // 先把日归 1，避免 setMonth 时先发生溢出（否则 31 日在 30 天的月份上
  // 会先滚到下个月 1 号，再钳制就钳不回来了）。
  result.setDate(1);
  result.setMonth(result.getMonth() - months);
  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(now.getDate(), daysInTargetMonth));
  return result;
}

/**
 * 这一条会话的**参考时间**（ISO 字符串）。
 *
 * 判据只有 `hasUnknownSaveTime` 一处（见文件头）；`??` 的兜底分支在
 * 判据为真时不可达，只是为了让类型收窄，不构成第二套判据。
 */
function referenceTime(group: TabGroup): string {
  if (!hasUnknownSaveTime(group)) return group.createdAt;
  return group.importedAt ?? group.createdAt;
}

/** 参考时间的毫秒值；解析不出来按**最旧**处理（只影响展示顺序，不影响是否删除）。 */
function referenceSortTime(group: TabGroup): number {
  const at = Date.parse(referenceTime(group));
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** 这一条是否**严格早于**截止点。非法时间戳 ⇒ false ⇒ 不删（fail-safe）。 */
function isOlderThan(group: TabGroup, cutoffMs: number): boolean {
  const at = Date.parse(referenceTime(group));
  return !Number.isNaN(at) && at < cutoffMs;
}

/** 一次清理计划：界面上每一句话的数字都从这里出（同一次判定）。 */
export interface CleanupPlan {
  /** 用户点的哪一档。确认框据此决定措辞（时间档 / 保留锁定 / 含锁定）。 */
  tier: CleanupTier;
  /** 要删的会话 id（按入参顺序；执行层拿它去删）。 */
  ids: string[];
  /** 要删的会话数（= `ids.length`，单独给出是为了读文案时不用再数）。 */
  groupCount: number;
  /** 这些会话里一共多少标签页。 */
  tabCount: number;
  /**
   * 其中多少条**保存时间未知**（OneTab 这类无时间戳导入件）。
   * 时间档才有意义；两档「全部」恒为 0。
   */
  unknownTimeCount: number;
  /**
   * 因为锁定而**没有**进入本次清理的会话数。
   * 时间档只数「本来够旧」的；`'all-keep-locked'` 数全部锁定；`'all'` 恒为 0。
   */
  lockedSkippedCount: number;
  /** 将删会话的名字，**最新在前**（调用方自行截断到前几条）。 */
  names: string[];
}

/**
 * 一次判定 → 一份清理计划。
 *
 * ⚠️ 入参必须是**同一次磁盘读**的结果：界面若拿 Redux 快照算菜单、拿磁盘真值
 * 算确认框，两个数字就会不一致。执行前还要按 id 再读一次磁盘（那是执行层的
 * fail-closed，不归本函数管）。
 */
export function planCleanup(
  groups: TabGroup[],
  tier: CleanupTier,
  now: Date
): CleanupPlan {
  const selected: TabGroup[] = [];
  let unknownTimeCount = 0;
  let lockedSkippedCount = 0;

  if (isTimeTier(tier)) {
    const cutoffMs = monthsBefore(now, TIER_MONTHS[tier]).getTime();
    for (const group of groups) {
      if (!isOlderThan(group, cutoffMs)) continue;
      if (group.isLocked) {
        lockedSkippedCount += 1;
        continue;
      }
      selected.push(group);
      if (hasUnknownSaveTime(group)) unknownTimeCount += 1;
    }
  } else if (tier === 'all-keep-locked') {
    for (const group of groups) {
      if (group.isLocked) {
        lockedSkippedCount += 1;
        continue;
      }
      selected.push(group);
    }
  } else {
    // 'all'：语义就是全删，锁定也删（确认框另行点名，走既有 deleteAll* 文案）。
    selected.push(...groups);
  }

  const names = selected
    .map((group) => ({ name: group.name, at: referenceSortTime(group) }))
    .sort((left, right) => right.at - left.at)
    .map((entry) => entry.name);

  return {
    tier,
    ids: selected.map((group) => group.id),
    groupCount: selected.length,
    tabCount: selected.reduce((sum, group) => sum + group.tabs.length, 0),
    unknownTimeCount,
    lockedSkippedCount,
    names,
  };
}

/**
 * 六个档位的**菜单行文字**。
 *
 * ── 为什么是两个参数，而不是只给一个「要显示的数字」──────────────────────
 *
 * `'all'` 这一档要同时表达两件事：**一共删多少**、**其中多少是锁定的**。
 * 只传一个数时，函数无法区分它传进来的是锁定数还是总数 —— 没有锁定时
 * 「显示总数」与有锁定时「显示含 N 个锁定」就必然撞车。曾经试过让调用方
 * 在没有锁定时自己把总数拼进文案，那正是本模块要防的漂移：**数字由两处
 * 各自拼，菜单与确认框迟早对不上**。
 *
 * 现在两个数都直接来自**同一个** `planCleanup` 结果：
 *   · `count`       = `plan.groupCount`（这一档要删的会话数）；
 *   · `lockedCount` = `plan.lockedSkippedCount`（锁定数，口径随档位，见
 *     `planCleanup` 的注释）。
 * 时间档只用 `count`（它们的锁定数不进菜单行）；`'all-keep-locked'` 只用
 * `lockedCount`（总数不混进文案 —— 那一行的承诺是「保留了几个锁定」）。
 *
 * ⚠️ 叫法纪律：这几个字符串里**不许**出现「删除全部会话」—— 同一个动作全仓
 * 只有一个名字「删除所有会话」（`tests/guards/deleteAllActionNaming.test.ts`
 * 就是从菜单行现场读这个名字的）。
 */
export const CLEANUP_TIER_LABELS: Record<
  CleanupTier,
  (count: number, lockedCount: number) => string
> = {
  // 时间档：count = 这一档将删除的会话数。
  '1m': (count) => `一个月前的会话（${count}）`,
  '3m': (count) => `三个月前的会话（${count}）`,
  '6m': (count) => `六个月前的会话（${count}）`,
  '12m': (count) => `一年前的会话（${count}）`,
  // 保留锁定：lockedCount = 锁定（将被保留）的会话数；count 刻意不进文案。
  'all-keep-locked': (_count, lockedCount) =>
    `删除所有会话（保留 ${lockedCount} 个锁定）`,
  // 含锁定：有锁定就说锁定数；没有锁定（lockedCount === 0）⇒ 说总数，
  // 此时若只说「删除所有会话」，用户就看不到这一行会删多少 ⇒ 总数不许丢。
  all: (count, lockedCount) =>
    lockedCount > 0
      ? `删除所有会话（含 ${lockedCount} 个锁定）`
      : `删除所有会话（${count}）`,
};
