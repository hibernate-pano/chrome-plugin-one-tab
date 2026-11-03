/**
 * 「删除所有会话」在菜单行与确认框里的同一份声明。
 *
 * 删除是核弹级且不可撤销的操作，而**删除意图会传到其他设备**：本地物理移除后，
 * 墓碑经上传队列广播到云端（Supabase 的 `markCloudGroupsAsDeleted` / WebDAV 的
 * `broadcastDeletes`），对端合并时服从墓碑 ⇒ 对端同名会话也消失。
 *
 * 两处声明的判据必须同源。此前确认框只看 `isAuthenticated`，而自带存储（WebDAV）
 * 用户没有 TapStack 账号、`isAuthenticated` 恒为 false —— 于是菜单行写着
 * 「其他登录设备同步删除」、确认框却一个字不提：**用户在更该看清的那一步被误导成
 * 「只删本机」**。反过来，没有同步后端的纯本地用户，菜单行那句又是假话。
 *
 * 判据与 syncEngine / backgroundSync 的门禁同口径：**有没有可用的同步后端**，
 * 而不是「有没有账号」。抽成纯函数是为了让两处调用同一个，边界（登录 / 自带存储 /
 * 纯本地）由单测钉死。
 *
 * ── 2026-10-24 审计 DS-3：跨设备判据与措辞搬去了共享模块 ──────────────────
 * 「删除单个会话」的确认框也要说同一件事（此前它一个字不提），两处必须同源 ⇒
 * 判据（`deleteReachesOtherDevices`）与措辞（`crossDeviceDeleteCaveat`）都搬到了
 * `components/sync/crossDeviceDeleteCopy.ts`，本文件只做组装。
 */
import {
  crossDeviceDeleteCaveat,
  deleteReachesOtherDevices,
  otherDevicesLabel,
} from '@/components/sync/crossDeviceDeleteCopy';
import type { CleanupPlan } from '@/core/cleanupPlan';
import { formatRelativeTime } from '@/utils/sessionPresentation';

export interface DeleteAllDisclosure {
  isAuthenticated: boolean;
  syncBackend: 'supabase' | 'webdav';
}

/**
 * 「删完全部之后，要不要立刻发一次覆盖上传」——**必须与
 * `deleteReachesOtherDevices` 同源**（2026-10-19 修真实缺陷）。
 *
 * 原实现直接读 `isAuthenticated`，而自带存储（WebDAV）用户没有 TapStack 账号、
 * 该值恒为 false ⇒ 确认框里写着「其他设备将同步删除」，实际却走了
 * 「用户未登录，跳过同步到云端」的分支：承诺与行为分裂，且跳过的恰是
 * 最需要这次加固的那个后端。删光本机后云端仍留着全部旧会话，
 * 换台设备登录/连盘就把它们原样拉回来。
 *
 * 判据取「有没有可用的同步后端」而非「有没有账号」，与本文件其余声明、
 * `syncIdentityCanRun`、backgroundSync 的门禁同一口径。
 */
export const deleteAllShouldPushOverwrite = deleteReachesOtherDevices;

/**
 * 「删除所有会话」对**锁定会话**的处理口径 —— 方案 B（全部删除，但必须点名）。
 *
 * ── 为什么是 B（全部删除 + 确认框点名）而不是 A（跳过锁定会话）─────────
 *
 * A（跳过锁定）的致命问题是**残渣无处可去**：v1.22.0 起删除即物理清除，
 * 没有回收站、没有撤销。于是「删除所有会话」点下去之后，锁定的那些还留在
 * 列表里 —— 用户以为清空了，实际没清空；而这些残渣**只能逐个解锁再逐个删**
 * （每一步都要先解锁），等于「一键清空」这个动作被悄悄改成了「清空大部分」，
 * 且界面毫无交代。更糟的是用户的直觉会反着来：「我锁了它，它还在，
 * 是不是锁坏了？」
 *
 * B（全部删除 + 确认框写明「其中包含 N 个已锁定的会话」）的代价是
 * 「锁定的会话也会被删」—— 这个代价**本来就存在**（`applyDeleteAllGroups`
 * 是全量物理移除，是 v1.22.0 起的明确产品决定，见 README），B 只是把它
 * **说清楚**。用户在按「全部删除」之前就知道自己要删掉几个自己保护过的东西，
 * 仍然可以取消；A 则是把一个已经发生的事实藏起来，让用户事后才发现。
 *
 * ⚠️ 本模块**只负责披露**，不改变删除语义：`applyDeleteAllGroups`
 * （src/core/mutationOps.ts）依然全量物理移除锁定会话 —— 那是刻意的产品
 * 决定，不得为了「让文案好看」而改成跳过（那会让文案再次说谎）。
 */
export interface DeleteAllLockedDisclosure {
  /** 当前会话里被锁定的个数（0 表示没有锁定会话）。 */
  lockedCount: number;
}

/** 确认框里那句「其中 N 个已锁定的会话，也会被删除」。 */
export const deleteAllLockedWarning = (input: DeleteAllLockedDisclosure): string =>
  input.lockedCount > 0
    ? `，其中包含 ${input.lockedCount} 个已锁定的会话，也会被删除`
    : '';

/**
 * 「删除会传到其他设备」这句话**还差一档**（数据安全审计 DS-3，2026-10-23）。
 *
 * 旧版这里写的是「（另一台设备若在离线时改过它，删除可能不生效）」—— 那句话
 * 当时是**真的**（胜负由操作印记决定 ⇒ 删除可能被撤销），但它已经被修掉了：
 * 2026-10-24 审计 DS-3 把判据改成「**云端墓碑一律赢**」
 * （`core/opStampMerge.ts` / `core/remoteAdjudication.ts` /
 * `utils/supabase/upload.ts` 三处同口径）⇒ 对方离线期间改过也一样会被删除。
 *
 * ⇒ 继续留着「可能不生效」= 对着「让用户低估后果」的方向说假话；
 *   而删掉它又不补上「对方那份也没了」= 说另一半假话（用户会以为对方那份还在）。
 * ⇒ 现在这句说的是**真实后果**：删除会同步过去，对方那份离线编辑也一起没。
 * 措辞在 `components/sync/crossDeviceDeleteCopy.ts`（与「删除单个会话」同源）。
 */

// ── 2026-10-23 数据安全审计 DS-43-15：确认框的数字必须取**磁盘真值** ────────
//
// 修复前：确认框里的 N 取自 **Redux 快照**，而 SW 执行时按**磁盘真值**删
// （`mutationHandlers` → `d.getGroups()`），回传的 `{count}` **从头到尾没被展示过**
// （payload 只用来取 `broadcastWarn`）⇒
//   ① 确认框可能说「删除 8 个」而实际删了 7 个（另一台设备刚同步进来一条、
//      本机写入还没回环 Redux）；
//   ② 删完**零成功提示** —— 用户点完「全部删除」只看到列表空了，
//      不知道到底删了几个、有没有同步出去。
//
// 修法两条，都落在这份纯函数里（判据抽纯函数，IO 留在 IO 层）：
//   · 确认前读一次磁盘真值，读不到就**中止**（fail closed，绝不退回快照）——
//     与 `Header.tsx` 的「清理重复标签」同纪律；
//   · 执行后把 SW 回传的**实际条数**说出来；与确认时的数不等时必须说明差在哪。

/** 一次「删除所有会话」在**确认之前**的判据结果（全部取自同一次磁盘读）。 */
export interface DeleteAllPlan {
  /** 要删多少个会话（磁盘真值）。 */
  groupCount: number;
  /** 其中被锁定的个数（**同一次读** —— 与总数必须出自同一份快照）。 */
  lockedCount: number;
  /** 磁盘上已经没有会话 ⇒ 不该弹确认框。 */
  nothingToDelete: boolean;
}

/**
 * 判据：一次磁盘真值 → 确认框要用的那份数字。
 *
 * ⚠️ 入参必须是**刚读出来的磁盘真值**，不是 Redux 快照 —— 两者可能不同，
 * 而执行侧（SW）读的是磁盘。
 */
export const planDeleteAll = (groups: { isLocked?: boolean }[]): DeleteAllPlan => {
  const groupCount = groups.length;
  const lockedCount = groups.reduce((acc, g) => (g.isLocked ? acc + 1 : acc), 0);
  return { groupCount, lockedCount, nothingToDelete: groupCount === 0 };
};

/**
 * 读不到磁盘真值时的中止提示。
 *
 * fail closed：破坏性路径上的读失败**必须中止**，不能退回快照继续删 ——
 * 拿一个可能偏大的数字去承诺「删除 N 个」，比不删更糟。
 */
export const DELETE_ALL_READ_FAILED_MESSAGE =
  '暂时读不到真实会话，已取消删除，请稍后重试';

/** 磁盘上已经没有会话：不用弹确认框，直接说清（与「点了没反应」不同）。 */
export const DELETE_ALL_NOTHING_MESSAGE = '没有可删除的会话';

/** 确认框标题（数字同样取磁盘真值，与正文同源）。 */
export const deleteAllConfirmTitle = (groupCount: number): string =>
  `删除全部 ${groupCount} 个会话`;

/**
 * 删除完成后的那句话（此前**完全没有**成功提示）。
 *
 * `deletedCount` = SW 按磁盘真值回传的实际条数；
 * `confirmedCount` = 用户在确认框里看到的那个数。
 *
 * 两者不等 ⇒ 确认与执行之间会话数变了（另一台设备同步进来 / 本机被清空）。
 * 这种情况**必须说出来** —— 否则用户会以为「删了 7 个，可我明明确认了 8 个」。
 */
export const deleteAllSuccessMessage = (input: {
  deletedCount: number;
  confirmedCount: number;
}): string => {
  const { deletedCount, confirmedCount } = input;
  if (deletedCount === 0) {
    return confirmedCount > 0
      ? '没有会话被删除（它们在你确认之前就已被移除）'
      : DELETE_ALL_NOTHING_MESSAGE;
  }
  if (deletedCount === confirmedCount) return `已删除 ${deletedCount} 个会话`;
  if (deletedCount < confirmedCount) {
    return `已删除 ${deletedCount} 个会话（确认时是 ${confirmedCount} 个，其余已被移除）`;
  }
  return `已删除 ${deletedCount} 个会话（确认时是 ${confirmedCount} 个，期间有新的会话同步进来）`;
};

/**
 * 从删除回执里取**实际删除条数**（SW 按磁盘真值回传的 `{count}`）。
 *
 * 为什么要单独抽一个函数：回执的形状是 `unknown`（thunk 载荷），而
 * `count` 缺失时**不能猜** —— 猜出来的数字会被当成「删了 N 个」说出来，
 * 那就是在编数字。缺失一律按 0 处理，由 `deleteAllSuccessMessage` 去说
 * 「没有会话被删除」。
 */
export const deletedCountFromResult = (payload: unknown): number => {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as { value?: unknown }).value;
  if (!value || typeof value !== 'object') return 0;
  const count = (value as { count?: unknown }).count;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0;
};

/**
 * 实际删的数与用户确认的数一致吗？一致 ⇒ 列表空了就是回执，不必再说。
 *
 * ── 为什么要有这个判据（2026-10-25「安静的成功」）────────────────────────
 *
 * `deleteAllSuccessMessage` 有四种说法（删了 0 个 / 与确认的一致 / 比确认的少 /
 * 比确认的多）。其中**只有「与确认的一致」这一种是界面自明的** ——
 * 列表空了、数量与用户确认时看到的那个数一样 ⇒ 界面已经把结果说完了。
 * 其余三种都是**界面永远表达不了的事实**（列表空着，用户无从知道少了几个、
 * 或者多出来的那些是哪来的）⇒ 必须说出来。
 *
 * ⇒ 判据独立成纯函数：调用点只问「一致吗」，文案仍由
 * `deleteAllSuccessMessage` 产出（同一份文案只有一个版本）。
 */
export const deleteAllCountMatches = (input: {
  deletedCount: number;
  confirmedCount: number;
}): boolean => input.deletedCount === input.confirmedCount;

/** 确认框正文（破坏性操作的最后一道说明）。 */
export const deleteAllConfirmMessage = (
  input: DeleteAllDisclosure & { groupCount: number } & DeleteAllLockedDisclosure
): string =>
  `将删除本地全部 ${input.groupCount} 个会话，删除后无法恢复` +
  deleteAllLockedWarning(input) +
  (deleteReachesOtherDevices(input)
    ? `，${otherDevicesLabel(input)}将同步删除${crossDeviceDeleteCaveat}`
    : '') +
  '。确认继续吗？';

/** 菜单行副标题（点开菜单就能看到的那句）。 */
export const deleteAllMenuWarning = (
  input: DeleteAllDisclosure & DeleteAllLockedDisclosure
): string =>
  '将清空本地全部会话，删除后无法恢复' +
  deleteAllLockedWarning(input) +
  (deleteReachesOtherDevices(input)
    ? `（${otherDevicesLabel(input)}同步删除${crossDeviceDeleteCaveat}）`
    : '') +
  '。';

// ────────────────────────────────────────────────────────────────────────────
// 「清理旧会话」的确认框与回执（2026-11-03 上线，判据层见 core/cleanupPlan.ts）
// ────────────────────────────────────────────────────────────────────────────
//
// ── 为什么这三套文案**不共用一个模板** ─────────────────────────────────────
//
// 三档的语义本来就不同（设计稿 §7.5 R1）：
//   · 时间档（「三个月前的会话」）—— 按年龄挑出来的一批；
//   · 「删除所有会话（保留 N 个锁定）」—— 全清，但锁定的那批留下；
//   · 「删除所有会话（含 N 个锁定）」—— 全清，锁定也清（**沿用既有 deleteAll* 文案**）。
//
// 硬套一个模板必然有两处说假话：时间档没有「另有锁定的会保留」，
// 「保留锁定」档没有「按导入时间计算」，「含锁定」档则根本不是「清理」而是「全删」。
//
// ── 为什么数字全部来自 `CleanupPlan` ───────────────────────────────────────
//
// 菜单行说「三个月前的会话（12）」、确认框却只删 11 个 ⇒ 那是一句当场就能
// 戳破的谎。判据层一次算完（`planCleanup`），这里**只负责把同一份数字读成话**。

/** 确认框里的名字预览最多列几条（再多就变成一堵墙，用户反而认不出哪几个）。 */
const CLEANUP_PREVIEW_LIMIT = 6;

/**
 * 确认框标题。
 *
 * 「保留锁定」档说的是「删除」而不是「清理」—— 那一档**不看年龄**，
 * 它清的是「除锁定以外的全部」，叫「清理 12 个会话」会让人以为还有别的条件。
 */
export const cleanupConfirmTitle = (plan: CleanupPlan): string =>
  plan.tier === 'all-keep-locked'
    ? `删除 ${plan.groupCount} 个会话`
    : `清理 ${plan.groupCount} 个会话`;

/**
 * 名字预览：「「GitHub 调研」8月3日、「季度报告」7月21日」…
 *
 * 超过 6 条就说「等 N 个」—— **不逐条列**：列 40 个名字的确认框没人读得下去，
 * 而「等 40 个」+ 前 6 个既给了辨认线索，又说清了总数。
 *
 * ⚠️ 名字与日期都来自 `plan.entries`（判据层算好的同一份参考时间），
 * 界面层**不自己**去取 `createdAt` / `importedAt`（两套时间口径 = 两套说法）。
 */
const cleanupNamePreview = (plan: CleanupPlan): string => {
  if (plan.entries.length === 0) return '';
  const shown = plan.entries
    .slice(0, CLEANUP_PREVIEW_LIMIT)
    .map(entry => `「${entry.name}」${formatRelativeTime(entry.referenceTime)}`);
  if (plan.entries.length > CLEANUP_PREVIEW_LIMIT) {
    return `${shown.join('、')} 等 ${plan.groupCount} 个`;
  }
  return shown.join('、');
};

/**
 * 确认框正文（破坏性操作的最后一道说明）。
 *
 * 四段，顺序与设计稿 §4.2 一致：
 *   ① 数量（会话数 + 标签页数）
 *   ② 名字预览（最多 6 个 + 「等 N 个」）
 *   ③ 锁定/未知时间的说明（按档位取舍）
 *   ④ 跨设备 + 不可撤销
 */
export const cleanupConfirmMessage = (
  plan: CleanupPlan,
  disclosure: DeleteAllDisclosure
): string => {
  const lines: string[] = [];

  lines.push(`将删除 ${plan.groupCount} 个会话，共 ${plan.tabCount} 个标签页。`);

  const preview = cleanupNamePreview(plan);
  if (preview) lines.push(preview);

  if (plan.tier === 'all-keep-locked') {
    // 这一档的锁定是**它的名字本身**（「保留 N 个锁定」）⇒ 说「会保留」，
    // 不是「不会被清理」—— 后者听起来像「碰巧没被清到」。
    if (plan.lockedSkippedCount > 0) {
      lines.push(`另有 ${plan.lockedSkippedCount} 个已锁定的会话会保留。`);
    }
  } else {
    // 时间档：锁定的那批本来够旧，却因为锁定留下来 ⇒ 必须点名。
    if (plan.lockedSkippedCount > 0) {
      lines.push(`另有 ${plan.lockedSkippedCount} 个已锁定的会话不会被清理。`);
    }
    // 未知时间的会话按**导入时间**算 ⇒ 说出来，否则用户以为那是保存时间。
    if (plan.unknownTimeCount > 0) {
      lines.push(
        `其中 ${plan.unknownTimeCount} 个保存时间未知（OneTab 导入），按导入时间计算 —— 它们至少有那么旧。`
      );
    }
  }

  if (deleteReachesOtherDevices(disclosure)) {
    // 与「删除所有会话」**同一句**（不另写一份）：同一件事、同一句话。
    lines.push(`${otherDevicesLabel(disclosure)}将同步删除${crossDeviceDeleteCaveat}。`);
  }
  lines.push('删除后彻底清除：没有回收站，也没有撤销。');

  return lines.join('\n');
};

/**
 * 执行完成后的那句话。
 *
 * - `deletedCount` = SW 按磁盘真值回传的实际条数；
 * - `confirmedCount` = 用户在确认框里看到的那个数；
 * - `skippedLocked` = 执行时刻仍被锁定、因而**被跳过**的条数。
 *
 * ⚠️ **不许**按「请求总数 − count − skippedLocked = 未处理」倒算：
 * 磁盘上已经不存在的 id 两个数都不计 ⇒ 那样算出来的「未处理」是编的。
 *
 * 四种情形：
 *   ① 数量一致 ⇒ **空串**（「安静的成功」：列表里那些会话不见了，界面自明）；
 *   ② 有锁定跳过 ⇒ 说清真实原因，**不许**说「其余已被移除」（对锁定情形是假话）；
 *   ③ 少删（不是锁定）⇒ 沿用既有说法；
 *   ④ 一个都没删 ⇒ 说清「它们在你确认之前就已被移除」。
 */
export const cleanupSuccessMessage = (input: {
  deletedCount: number;
  confirmedCount: number;
  skippedLocked: number;
}): string => {
  const { deletedCount, confirmedCount, skippedLocked } = input;
  if (skippedLocked > 0) {
    return `已删除 ${deletedCount} 个会话（${skippedLocked} 个在你确认后被锁定，已跳过）`;
  }
  if (deletedCount === confirmedCount) return '';
  if (deletedCount === 0) {
    return confirmedCount > 0
      ? '没有会话被删除（它们在你确认之前就已被移除）'
      : DELETE_ALL_NOTHING_MESSAGE;
  }
  if (deletedCount < confirmedCount) {
    return `已删除 ${deletedCount} 个会话（确认时是 ${confirmedCount} 个，其余已被移除）`;
  }
  return `已删除 ${deletedCount} 个会话（确认时是 ${confirmedCount} 个，期间有新的会话同步进来）`;
};

/**
 * 从回执里取清理的实际条数与「因锁定跳过」的条数。
 *
 * 为什么要单独抽一个函数：回执的形状是 `unknown`（thunk 载荷），
 * 而数字缺失时**不能猜** —— 猜出来的数字会被当成「删了 N 个」说出来。
 */
export const cleanupCountsFromResult = (payload: unknown): {
  deletedCount: number;
  skippedLocked: number;
} => {
  const empty = { deletedCount: 0, skippedLocked: 0 };
  if (!payload || typeof payload !== 'object') return empty;
  const value = (payload as { value?: unknown }).value;
  if (!value || typeof value !== 'object') return empty;
  const read = (raw: unknown): number =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  return {
    deletedCount: read((value as { count?: unknown }).count),
    skippedLocked: read((value as { skippedLocked?: unknown }).skippedLocked),
  };
};

/** 读不到磁盘真值时的中止提示（fail closed，与「删除所有会话」同一条纪律）。 */
export const CLEANUP_READ_FAILED_MESSAGE =
  '暂时读不到真实会话，已取消清理，请稍后重试';

/** 这一档算出来是 0 条：不用弹确认框，直接说清（与「点了没反应」不同）。 */
export const CLEANUP_NOTHING_MESSAGE = '没有可清理的会话';

/**
 * 「删除所有会话（保留 N 个锁定）」那一行的副标题。
 *
 * 与「含锁定」那行的副标题（`deleteAllMenuWarning`）**成对**：两行的后果相反，
 * 必须各自说清 —— 一个说「锁定的也会被删」，一个说「锁定的会保留」。
 */
export const deleteAllKeepLockedMenuWarning = (
  input: DeleteAllDisclosure & DeleteAllLockedDisclosure
): string =>
  '将清空本地未锁定的全部会话，删除后无法恢复' +
  (input.lockedCount > 0 ? `（${input.lockedCount} 个已锁定的会保留）` : '') +
  (deleteReachesOtherDevices(input)
    ? `（${otherDevicesLabel(input)}同步删除${crossDeviceDeleteCaveat}）`
    : '') +
  '。';
