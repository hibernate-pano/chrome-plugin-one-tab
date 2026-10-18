/**
 * 首次配置 WebDAV 后的数据归属决策（2026-10-15）。
 *
 * ── 为什么要单独一个模块 ────────────────────────────────────────────────
 * 切换到「自带存储」时，本地往往**已经有数据**，而新接入的云端可能是：
 *   · 完全空的（最常见：刚申请的坚果云账号 / 新建的目录）
 *   · **已经有过你自己以前的数据**（换了服务、换了目录、换了账号）
 *   · 有别的设备的数据
 *
 * 原实现对这两种情况一视同仁：既不提示、也不上传。实测后果是
 * 「配完 WebDAV 直接走人」⇒ 数据永远出不了本机，换设备即全部丢失；
 * 而「配完顺手保存了一个会话」又因为保存动作会 scheduleUpload
 * （TabManager.ts:157）而**碰巧**把数据推上去 —— 于是这个缺陷
 * 在早期使用里完全看不出来，却一直存在。
 *
 * 这里只放**纯函数决策**，不碰网络与存储，便于把「什么情况该做什么」
 * 这张表钉死成单测（用户数据不该靠 UI 手工保证不丢）。
 */
import type { TabGroup } from '@/types/tab';
import { mergeOpStamped } from '@/core/opStampMerge';
import { compareStampsLoose } from '@/core/opStamp';

/** 用户可选的三种数据归属方式。 */
export type OwnershipChoice = 'merge' | 'local-wins' | 'cloud-wins';

/**
 * 首次推送流程的 UI 状态机（2026-10-16 审查 L5：从 WebDavSettings 内联的
 * useState 联合类型提炼到本模块，让「忙/不忙」的判据可单测、可复用）。
 *
 * `choose` 是唯一「等待用户输入」的稳态：三个入口按钮都可用，
 * 但三个选择按钮被点击后必须立刻转入 `pushing`（选择块随之卸载）。
 */
export type FirstPushKind =
  | 'idle'
  | 'probing'
  | 'pushing'
  | 'pulling'
  | 'done'
  | 'nothing-local'
  | 'choose'
  | 'blocked';

/**
 * 流程是否处于「忙」态（探测 / 推送 / 下载中）——入口按钮的禁用判据。
 *
 * ⚠️ `choose` **不算**忙：它停在「等用户选归属方式」，选之前没有在途任务。
 * 真正要防的竞态是「choose 态连点两个选择」：两个点击都在 React 刷新
 * 禁用态之前触发，会发两次 upload（第二次拿到 already_syncing，报一条
 * 与事实不符的「推送失败」）。那个同步窗口由 WebDavSettings 的
 * pushInFlightRef 关闭；本函数负责的是**刷新后**的禁用态与语义钉住。
 */
export function isFirstPushBusy(kind: FirstPushKind): boolean {
  return kind === 'probing' || kind === 'pushing' || kind === 'pulling';
}

/** 探测结果 → 该走哪条路。 */
export type FirstSyncDecision =
  /** 远端一行都没有：直接全量上传，无需打扰用户。 */
  | { action: 'upload-all' }
  /**
   * 远端**只有墓碑**（2026-10-18 P1#3）。
   *
   * ⚠️ 为什么必须与「远端空」分开：墓碑是「另一台设备删除了这些会话」的意图。
   * 原实现用 `countActive` 统计活跃数，于是「远端只有墓碑」被算成 0 → 直接
   * `upload-all`，本地那些已被删除的旧会话会被**重新上传** ⇒ 跨设备删除被
   * 撤销、用户以为删掉的会话又回来了。而 B3 刚刚在 syncEngine 定下
   * 「只有墓碑 ≠ 云端为空」（空云端闸门正为此而生），B7 却把它合了回去 ——
   * 同一件事在两个模块里得到相反的结论，必须在这里按 B3 的口径改正。
   *
   * 这一态要停下来问，而不是替用户决定。
   */
  | { action: 'tombstones-only'; tombstoneCount: number; localCount: number }
  /** 远端有活跃数据：必须让用户显式选择归属方式。 */
  | { action: 'ask-user'; remoteCount: number; localCount: number }
  /** 本地也没有数据：无事可做，但也不能说「成功」。 */
  | { action: 'nothing-to-do' }
  /** 探测失败：绝不在探测不出来时默认上传（可能覆盖已有数据）。 */
  | { action: 'blocked'; reason: string };

/** 活跃会话数（墓碑与空壳都不算「用户的数据」）。 */
export function countActive(groups: TabGroup[]): number {
  return groups.filter(g => !g.isDeleted).length;
}

/** 墓碑数（已被删除、但删除意图仍在远端的会话）。 */
export function countTombstones(groups: TabGroup[]): number {
  return groups.filter(g => g.isDeleted).length;
}

/**
 * 远端是什么形态：空 / 只有墓碑 / 有活跃数据（2026-10-18 P1#3）。
 *
 * 为什么要显式建模而不是让调用方数两遍再比较：判据散到调用方就会漂移 ——
 * 这正是原 bug 的成因（`countActive` 在决策里与 UI 里各用一次，
 * B3 又在 syncEngine 用第三种口径）。
 */
export type RemoteShape = 'no-rows' | 'only-tombstones' | 'has-active';

export function classifyRemoteShape(groups: TabGroup[]): RemoteShape {
  if (groups.length === 0) return 'no-rows';
  if (groups.every(g => g.isDeleted)) return 'only-tombstones';
  return 'has-active';
}

/**
 * 探测远端后决定下一步。
 *
 * ⚠️ 关键取舍 1：`unreachable` 一律 `blocked`，**绝不**默认上传。
 * 探测失败时如果默认上传，就会在「用户配了个已有数据的云盘、
 * 但这次网络不通」的情况下，探测失败 → 上传 → 覆盖掉那些数据。
 * 「不知道」必须停下来问，不能当成「空」。
 *
 * ⚠️ 关键取舍 2（2026-10-18 P1#3）：`only-tombstones` **不能**当成空。
 * 墓碑是别的设备发出的删除意图。把它当空 → upload-all → 那些会话被重新
 * 上传 → **跨设备删除被撤销、已删会话复活**。所以这一态必须停下来问。
 */
export function decideFirstSync(input: {
  localGroups: TabGroup[];
  remoteGroups: TabGroup[] | null;
}): FirstSyncDecision {
  const localCount = countActive(input.localGroups);
  const remote = input.remoteGroups;

  if (remote === null) {
    return {
      action: 'blocked',
      reason: '无法读取云端状态，为避免覆盖云端上已有的数据，已中止本次推送。请检查网络后重试。',
    };
  }
  const shape = classifyRemoteShape(remote);

  if (localCount === 0) {
    return { action: 'nothing-to-do' };
  }
  if (shape === 'no-rows') {
    return { action: 'upload-all' };
  }
  if (shape === 'only-tombstones') {
    return {
      action: 'tombstones-only',
      tombstoneCount: remote.length,
      localCount,
    };
  }
  return { action: 'ask-user', remoteCount: countActive(remote), localCount };
}

/**
 * 三种选择各自的**后果预览**（Wave 2A：文案与计数必须等于真实执行）。
 *
 * ── 2026-10-16 修正（旧文案）────────────────────────────────────────
 * 旧文案描述的是 Supabase 时代的「整库替换/删除」语义，而 WebDAV 适配器
 * 从头到尾只做 **upsert**（见 adapter.uploadGroups）：
 *   · merge   只把本机推上去；本机不会收到云端独有的会话；
 *   · local-wins 不是「替换云端」：云端独有会话不删除，同 id 且云端
 *     stamp 更新时走适配器的认输预检、保留云端版本；只有本机更新的
 *     同 id 旧版本会被覆盖（那一步确实不可恢复）；
 *   · cloud-wins 是**先上传再下载**：本机独有的会话先并入云端，
 *     再跟云端内容一起拉回本机 —— 旧文案威胁的「本机数据被替换且
 *     无法恢复」不会发生。
 *
 * 因此每个选项新增 `hint`（按钮下的一句话说明，必须是执行事实）与
 * 修正后的 `warning`（二次确认文案，仍保留不可恢复的**真实**那一部分）。
 * 旧的 `localCount`/`cloudCount` 保留原值以维持既有调用契约，
 * 但事后文案与任何「执行后云端有多少」的表达必须用
 * `projectedCloudCount()`（并集）——三选一都只增不减云端会话。
 */
export interface OwnershipPreview {
  /** 预览口径的数字（保留旧契约；执行后真实云端数用 projectedCloudCount）。 */
  localCount: number;
  cloudCount: number;
  /** 选择按钮下的一句话说明：必须与真实执行一致，UI 直接渲染。 */
  hint: string;
  /** 二次确认的后果说明（含真实不可恢复项）；无不可逆后果时为 undefined。 */
  warning?: string;
}

/**
 * 一次上传（merge 或 local-wins）后云端的真实会话数。
 *
 * 两种选择都只做 upsert：stamp 更旧的同 id 条目被本机覆盖，云端独有的
 * 条目不动，云端 stamp 更新的同 id 条目被认输预检跳过 —— 结果都是
 * `mergeOpStamped` 的并集。写成一个导出函数而不是在 UI 里各算一遍，
 * 是为了让「事后计数」只有一个算法（改一处不会漏另一处）。
 */
export function projectedCloudCount(localGroups: TabGroup[], remoteGroups: TabGroup[]): number {
  return mergeOpStamped(localGroups, remoteGroups).filter(g => !g.isDeleted).length;
}

export function previewOutcome(
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  choice: OwnershipChoice
): OwnershipPreview {
  const local = localGroups.filter(g => !g.isDeleted);
  const remote = remoteGroups.filter(g => !g.isDeleted);

  switch (choice) {
    case 'merge': {
      const merged = mergeOpStamped(localGroups, remoteGroups).filter(g => !g.isDeleted);
      const remoteOnly = countRemoteOnly(local, remote);
      return {
        localCount: merged.length,
        cloudCount: merged.length,
        hint:
          `把本机 ${local.length} 个会话上传到云端（共 ${merged.length} 个）；` +
          `云端独有的 ${remoteOnly} 个会话保留在云端，本机暂不会收到`,
      };
    }
    case 'local-wins': {
      const { overlapOlder, remoteOnly } = countLocalWinsEffects(local, remote);
      return {
        localCount: local.length,
        cloudCount: local.length,
        hint:
          `本机 ${local.length} 个会话上传覆盖云端同 id 的旧版本；` +
          `云端独有的 ${remoteOnly} 个会话不会被删除`,
        warning:
          `云端同 id 且版本较旧的 ${overlapOlder} 个会话会被本机版本覆盖，无法恢复；` +
          `云端独有的 ${remoteOnly} 个会话会保留在云端，不会被删除。`,
      };
    }
    case 'cloud-wins': {
      const union = projectedCloudCount(localGroups, remoteGroups);
      const remoteOnly = countRemoteOnly(local, remote);
      return {
        localCount: remote.length,
        cloudCount: remote.length,
        hint:
          `本机 ${local.length} 个会话先并入云端，再与云端独有的 ${remoteOnly} 个会话` +
          `一起拉回本机（不会丢失）`,
        warning:
          `本机现有的 ${local.length} 个会话会先并入云端，再与云端数据一起拉回本机，` +
          `本机独有会话不会丢失；同 id 且云端版本更新的会话按云端版本合并，` +
          `本机旧版本无法恢复。最终两边各 ${union} 个会话。`,
      };
    }
  }
}

/** 云端独有（本机没有同 id 活跃会话）的会话数。 */
function countRemoteOnly(local: TabGroup[], remote: TabGroup[]): number {
  const localIds = new Set(local.map(g => g.id));
  return remote.filter(g => !localIds.has(g.id)).length;
}

/**
 * 「以本机为准」的真实后果分解（必须与 adapter.uploadGroups 的认输预检同口径）：
 *   · overlapOlder：云端同 id 且**本机版本不更旧**的会话 —— 会被本机覆盖，
 *     旧内容不可恢复（这是该选项唯一真实的不可逆部分）；
 *   · remoteOnly：云端独有 —— 不删除，仍留在云端。
 * 用 compareStampsLoose 而非 compareStamps：与 adapter 一样把「无印记」
 * 当作严格最小值（见 core/opStamp.ts 的完整论证）。
 */
function countLocalWinsEffects(
  local: TabGroup[],
  remote: TabGroup[]
): { overlapOlder: number; remoteOnly: number } {
  const localById = new Map(local.map(g => [g.id, g]));
  let overlapOlder = 0;
  let remoteOnly = 0;
  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) {
      remoteOnly += 1;
      continue;
    }
    // 适配器的跳过条件是 compareStamps(remote, local) > 0；
    // 反过来说「不被跳过」= remote <= local = 会被本机覆盖。
    if (compareStampsLoose(r.lastOp, l.lastOp) <= 0) overlapOlder += 1;
  }
  return { overlapOlder, remoteOnly };
}
