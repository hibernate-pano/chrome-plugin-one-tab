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
import { sameLibrary, type LibraryRef } from './libraryIdentity';

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

/* ════════════════════════════════════════════════════════════════════════
 * 归属待决令牌（`FIRST_SYNC_PENDING`）的生命周期（2026-10-18 A 组）
 *
 * 【为什么这几条要放在本模块并导出】令牌的置/清时机决定了「历史会话会
 * 不会被自动上传」：令牌为 true 时，syncEngine 把所有非显式上传降级为“只传本次
 * 改动过的会话”（suppressFullUpload），于是**历史会话被排除在上传之外**。
 * 方向上是 fail-closed（宁可少传），但用户没有任何路径能发现它 ——
 * 那正是本组缺陷的形状：令牌泄漏只需一行错位的 `return`。
 *
 * 把它们做成不碰 DOM、写入器可注入的纯异步函数，才能对“哪个分支该写、
 * 写失败时该怎样”做**行为断言**，而不是只对着源码字符串数行。
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 「保存配置」这一步要不要**重新进入**「归属待决」状态（2026-10-20）。
 *
 * ── 缺陷形状 ──────────────────────────────────────────────────────────────
 * 判据原先是「本机此前有没有配过自带存储」：
 *
 *     const wasConfigured = !!(await loadWebDavConfig())?.baseUrl;
 *     if (!wasConfigured) await storage.setFirstSyncPending(true);
 *
 * 于是「**换云盘**」与「**同一个云盘重设密码**」在判据上**完全一样**
 * （两者都是 `wasConfigured === true` ⇒ 两者都不置位）——
 * 而它们的**后果完全不同**：重设密码还是同一个库，换云盘是**另一个库**。
 * 结果：换到云盘 B 时本机的历史会话被**全量推上 B**，
 * 而用户从来没有被问过「这些会话归 B 吗」（2026-10-18 P1#4 那条
 * 「明令禁止的多传，不可回滚」）。
 *
 * ── 修法 ──────────────────────────────────────────────────────────────────
 * 判据改成「**库的身份**变了没有」：地址 / 账号 / 目录任一变化 ⇒ 另一个库
 * ⇒ 归属是**另一个决定** ⇒ 必须重新置位（让用户做三选一）。
 * 而「同一个库重设密码 / 改加密口令」⇒ 身份没变 ⇒ 不重新置位
 * （拦了会让同步莫名停摆且零提示 —— 那是老用户重设密码的既有行为）。
 *
 * ── 为什么这不是「首次配置」的特例 ────────────────────────────────────────
 * 「首次配置」= 从**没有库**到**有库**；「换云盘」= 从**库 A**到**库 B**。
 * 两者都是「归属待决的对象变了」⇒ 走**同一条**判据，不需要两个分支。
 */
export interface OwnershipGateInput {
  /** 本机**已保存**的配置（null = 从没配过自带存储）。 */
  saved: LibraryRef | null;
  /** 用户这次要保存的配置（表单里的地址 / 账号 / 目录）。 */
  target: LibraryRef;
}

/**
 * 保存配置后，归属待决标志该置成什么。
 *
 * 返回 `true` = 必须进入（或保持在）「归属待决」状态。
 */
export function shouldEnterOwnershipPending(input: OwnershipGateInput): boolean {
  // 从没配过 ⇒ 首次配置 ⇒ 必须置位（2026-10-18 真机实测出来的那条，别动）。
  if (!input.saved) return true;
  // 配过 ⇒ 只有「库的身份变了」（换云盘）才需要重新置位。
  // 同一个库重设密码 / 改加密口令 ⇒ 不置位。
  return !sameLibrary(input.saved, input.target);
}

/**
 * 「为什么现在传不上去」的人话（2026-10-20）。
 *
 * ── 为什么必须有这句 ──────────────────────────────────────────────────────
 * 归属待决期里，自动上传只传「本次改动过的会话」，历史会话被**排除**在外。
 * 于是用户会看到「本机有 N 个会话，但云端只有刚改的那几个」——
 * 若界面只报「同步失败」或干脆不提，用户只会得出「同步坏了」的结论，
 * 而真正缺的是**一个决定**（这些会话归不归这个库）。
 *
 * 纪律：本仓的诚实度要求是「界面说的每一句都必须等于真实行为」。
 * 所以这里必须说清三件事：**发生了什么**、**为什么**、**下一步做什么**。
 *
 * `localCount === null` = **读不到本机会话数** ⇒ 那一半**不报数字**
 * （报一个编出来的数就是撒谎）。机制与下一步照说 —— 那部分不依赖计数。
 */
export function ownershipPendingNotice(input: {
  localCount: number | null;
  scopeLabel: string;
}): string {
  const howMany =
    typeof input.localCount === 'number'
      ? `本机还有 ${input.localCount} 个会话没有传到这个云盘（${input.scopeLabel}）。`
      : `本机有会话还没有传到这个云盘（${input.scopeLabel}）。`;
  return (
    howMany +
    '因为「这些会话归不归这个云盘」需要你来决定，系统不会替你决定 —— ' +
    '请到设置页点「检查并推送到云端」，按提示选择归属方式。'
  );
}

/**
 * 「**读不到**归属待决状态」时的那句话（2026-10-23 审计 DS-4）。
 *
 * ── 为什么这是**第三种**状态，不许塞进前两种里 ───────────────────────────
 * 归属待决这个事实有三种取值：`true`（待决）/ `false`（不待决）/
 * **读不到**。前两种是关于**世界**的断言，第三种是关于**我们没看清**的断言。
 *
 * 存储层现在对读失败**抛错**（fail-closed：读不到 ≠ 没有待决 ⇒ 那一轮
 * 上传中止 ⇒ 历史会话不会被整批推上云）。界面若把读失败当成「不待决」，
 * 就会**沉默**：用户看到「一切正常」，而实际上传已经停摆、
 * 且「为什么停」这件事被藏了起来 —— 那正是本仓最恨的「界面不说的谎」。
 *
 * ⇒ 单独一句：说清**读不到**、**已暂停自动上传**（这是真的：上传那一轮
 * 中止了）、以及**下一步**（刷新重试）。绝不编一个待决/不待决出来。
 */
export function ownershipStatusUnreadableNotice(scopeLabel: string): string {
  return (
    `读不到「这些会话归不归这个云盘」的状态（${scopeLabel}），` +
    '已暂停自动上传以免误传。请刷新页面重试；若反复出现，请检查本机存储是否可用。'
  );
}

/** 令牌写入器（生产为 `storage.setFirstSyncPending`；测试注入假货）。 */
export type FirstSyncPendingWriter = (pending: boolean) => Promise<void>;

/** 一次令牌写入的结果（`attempted:false` = 按规则根本不该写）。 */
export interface PendingWriteOutcome {
  attempted: boolean;
  /** `attempted` 为 false 时无意义（固定 true，避免调用方误读为「写成功」）。 */
  ok: boolean;
}

/**
 * 「保存失败」分支的令牌回滚（2026-10-18 A3）。
 *
 * 【为什么要回滚】`handleSave` 在写入之前会先把令牌置 true（round 30：必须排在
 * 最前面，否则设置保存后的那次自动上传就是无抑制全量）。但若随后保存失败，
 * 令牌就留在了盘上：此后**每一次**自动上传都被降级为增量，历史会话永久不传，
 * 界面上零提示。
 *
 * 【为什么要 `setHere` 这个参数】只退**本次**置的位。用户上一轮就处于待决态、
 * 这一次重设密码又保存失败时，那个位是**真实未完成的归属决策**，退掉它意味着
 * 下一次自动上传把历史会话整批推上云 —— 比令牌泄漏更糟。
 *
 * 【写失败为什么不抛】抛了会把一次「保存失败」变成一条看不出原因的报错，
 * 而且外层 catch 会把两个不相干的失败报成一件事。写失败只是回到了本缺陷
 * 修前的状态，打一条日志让用户能重试即可。
 */
export async function releaseFirstSyncPendingOnSaveFailure(args: {
  /** 本次操作有没有新置待决位（false ⇒ 本函数**一次写入都不做**）。 */
  setHere: boolean;
  write: FirstSyncPendingWriter;
  onError?: (err: unknown) => void;
}): Promise<PendingWriteOutcome> {
  if (!args.setHere) return { attempted: false, ok: true };
  try {
    await args.write(false);
    return { attempted: true, ok: true };
  } catch (err) {
    args.onError?.(err);
    return { attempted: true, ok: false };
  }
}

/**
 * 一次成功的首次归属动作（推送 / 下载）完成后的收尾（2026-10-18 A4）。
 *
 * 【顺序不是风格问题】解除待决是一次 KV 写。原先它排在成功 toast **之后**
 * 且裸 `await` 在外层 try 内，于是写失败时被报成「推送失败：<存储错误>。
 * 本地数据未受影响。」—— 而合并其实**已经成功了**。用户看到一句与事实相反的
 * 话，只能自己去查云端到底传没传。
 *
 * 现在的契约：
 *   1. 先尝试清令牌，无论成败**都**报成功（数据确实已经合了）；
 *   2. 清失败只走 onError（生产里是 logWarn），绝不向外抛。
 * 代价极小：写不进去的后果是「下次自动上传仍按增量」，不丢也不重传。
 */
export async function completeFirstSyncSuccess(args: {
  write: FirstSyncPendingWriter;
  notifySuccess: () => void;
  onError?: (err: unknown) => void;
}): Promise<{ pendingCleared: boolean }> {
  let pendingCleared = false;
  try {
    await args.write(false);
    pendingCleared = true;
  } catch (err) {
    args.onError?.(err);
  }
  // 无论上面成没成，本次数据动作已经成功 —— 这句必须说。
  args.notifySuccess();
  return { pendingCleared };
}

/**
 * 「后端/配置已变」或「本次动作已完成」时的静默清除（2026-10-18 A3/A4）。
 *
 * 与 `releaseFirstSyncPendingOnSaveFailure` 的区别：**不看** `setHere`，
 * 因为切回云端 / 清除配置 / 归属已完成这三条路径上，令牌描述的待决态已经
 * 无对象（后端变了，或决策已经做完了），无条件退掉才是对的。
 * 写失败同样只走 onError。
 */
export async function clearFirstSyncPendingBestEffort(args: {
  write: FirstSyncPendingWriter;
  onError?: (err: unknown) => void;
}): Promise<{ ok: boolean }> {
  try {
    await args.write(false);
    return { ok: true };
  } catch (err) {
    args.onError?.(err);
    return { ok: false };
  }
}

/**
 * 三个选项各自的后果预览。
 *
 * ── 2026-10-19 修：墓碑必须进后果，不能被 filter 静默吞掉 ──────────────
 * 原实现在函数开头就把 `remoteGroups` 过滤成「非墓碑」，于是**远端只有墓碑**
 * 这一态下，三个选项的 hint 全都说「云端独有的 0 个会话」、`merge` 更是
 * **完全没有 warning**。而同一块面板的抬头正在警告
 * 「继续推送会撤销那些删除、让已删的会话重新出现」——按钮紧挨着抬头，
 * 却说着相反的话；标着「推荐」的那一个连二次确认都不弹（UI 只对有 warning
 * 的选项弹）。方向都错：唯一真的不可逆的那一项被描述成零风险。
 *
 * 现在墓碑单独统计：凡是本机会让它「复活」的（有同 id 活跃会话，或本机
 * 带印记 ⇒ stamp 决胜时胜出），都计入 `revived` 并让**所有**选项带上 warning。
 */
export function previewOutcome(
  localGroups: TabGroup[],
  remoteGroups: TabGroup[],
  choice: OwnershipChoice
): OwnershipPreview {
  const local = localGroups.filter(g => !g.isDeleted);
  const remote = remoteGroups.filter(g => !g.isDeleted);
  const tombstones = remoteGroups.filter(g => g.isDeleted);
  /**
   * 这次操作会让多少条「云端已删除」的记录重新变成活跃会话。
   *
   * 判据与 `mergeOpStamped` 的「云端墓碑 vs 本地活跃」分支同口径：
   * 有本机同 id 副本时由 stamp 决胜（本机赢 ⇒ 删除被撤销），
   * 本机没有同 id 副本时上传会把它写回活跃行（同样是复活）。
   * 两种情况用户都要知道，所以这里一律计为「会复活」。
   */
  const revived = countRevivedTombstones(local, tombstones);
  const tombstoneNote = revived > 0
    ? `另有云端 ${revived} 条已删除的会话记录会因本次推送重新出现（撤销了那些删除）`
    : '';

  switch (choice) {
    case 'merge': {
      const merged = mergeOpStamped(localGroups, remoteGroups).filter(g => !g.isDeleted);
      const remoteOnly = countRemoteOnly(local, remote);
      return {
        localCount: merged.length,
        cloudCount: merged.length,
        hint:
          `把本机 ${local.length} 个会话上传到云端（共 ${merged.length} 个）；` +
          `云端独有的 ${remoteOnly} 个会话保留在云端，本机暂不会收到` +
          (tombstoneNote ? `；${tombstoneNote}` : ''),
        // merge 此前恒无 warning，于是 UI 不弹二次确认。墓碑态下这正是
        // 不可逆的那一步，必须与其他选项一样先确认（见 UI 的确认判据）。
        ...(revived > 0
          ? { warning: `${tombstoneNote}，且这一步无法撤销。确认继续吗？` }
          : {}),
      };
    }
    case 'local-wins': {
      const { overlapOlder, remoteOnly } = countLocalWinsEffects(local, remote);
      return {
        localCount: local.length,
        cloudCount: local.length,
        hint:
          `本机 ${local.length} 个会话上传覆盖云端同 id 的旧版本；` +
          `云端独有的 ${remoteOnly} 个会话不会被删除` +
          (tombstoneNote ? `；${tombstoneNote}` : ''),
        warning:
          `云端同 id 且版本较旧的 ${overlapOlder} 个会话会被本机版本覆盖，无法恢复；` +
          `云端独有的 ${remoteOnly} 个会话会保留在云端，不会被删除。` +
          (tombstoneNote ? ` ${tombstoneNote}，也无法撤销。` : ''),
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
          `一起拉回本机（不会丢失）` +
          (tombstoneNote ? `；${tombstoneNote}` : ''),
        warning:
          `本机现有的 ${local.length} 个会话会先并入云端，再与云端数据一起拉回本机，` +
          `本机独有会话不会丢失；同 id 且云端版本更新的会话按云端版本合并，` +
          `本机旧版本无法恢复。最终两边各 ${union} 个会话。` +
          (tombstoneNote ? ` ${tombstoneNote}，也无法撤销。` : ''),
      };
    }
  }
}

/**
 * 本次推送会「复活」多少条云端墓碑。
 *
 * 分两种，都会让已删的会话重新出现：
 *   · 本机有同 id 活跃会话且本机 stamp 不更旧 → mergeOpStamped 让本机赢，墓碑失效；
 *   · 本机没有同 id 副本 → 上传把该行写回活跃形态，墓碑消失。
 * 本机更旧的同 id 副本会服从删除（不算复活），故按 compareStampsLoose 判。
 */
function countRevivedTombstones(local: TabGroup[], tombstones: TabGroup[]): number {
  if (tombstones.length === 0) return 0;
  const localById = new Map(local.map(g => [g.id, g]));
  let revived = 0;
  for (const t of tombstones) {
    const l = localById.get(t.id);
    if (!l) { revived += 1; continue; }
    if (compareStampsLoose(t.lastOp, l.lastOp) <= 0) revived += 1;
  }
  return revived;
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

/* ════════════════════════════════════════════════════════════════════════
 * 「从云端下载到本机」的失败收敛（2026-10-18 A2）
 *
 * 【缺陷形状】原实现是：
 *     setFirstPush({ kind: 'pulling' });
 *     const dl = await sendSyncCommand('download', ...);   // ← 没有 try/catch
 * `sendSyncCommand` 在 MV3 SW 被回收（30s 空闲）后会 **reject**（message channel
 * closed），而不是返回 `{ok:false}`。于是：
 *   · rejected Promise 从 onClick 里漂出去（unhandled rejection）；
 *   · firstPush 永远停在 'pulling' ⇒ `isFirstPushBusy('pulling')` 恒真 ⇒
 *     **两个推送按钮永久禁用**，用户只能重开页面；
 *   · 后续的「解除归属待决」永远跑不到（令牌泄漏，A3 的另一条来源）。
 *
 * 【为什么抽成函数】姊妹函数 runPush 有完整的 try/catch/finally，而这条路径
 * 一行都没有 —— 这种「两个对称入口一个有一个没有」的缺陷，只有把「命令抛出/
 * 返回失败/成功」三种结果都变成可断言的输出，才能真正钉住。
 * ════════════════════════════════════════════════════════════════════════ */

/** 下载命令的返回形状（只取本函数需要的两个字段，便于注入）。 */
export type DownloadCommandResult = { ok: boolean; error?: string };

/** 下载流程的收敛结果：UI 状态 + 是否成功 + 成功后才写的收尾。 */
export type PullOutcome =
  | { kind: 'blocked'; reason: string }
  | { kind: 'done'; pendingCleared: boolean };

/**
 * 跑一次下载命令并把三种结果收敛成一个可渲染的状态（绝不抛出）。
 *
 * 调用方只需：先 `setFirstPush({kind:'pulling'})`，然后按返回的 `kind` 渲染。
 * **本函数保证不抛** —— 这正是缺陷的修法本身（否则 UI 会卡在忙态）。
 */
export async function runPullCommand(args: {
  run: () => Promise<DownloadCommandResult>;
  /** 命令 ok 之后的收尾（解除归属待决）。它自己失败不会影响 `kind: 'done'`。 */
  complete: () => Promise<{ pendingCleared: boolean }>;
  /** reason 机器码 → 用户文案（生产里是 resolveSyncFailureCopy）。 */
  copyOf: (reason: string | undefined) => string;
  onError?: (err: unknown) => void;
}): Promise<PullOutcome> {
  let dl: DownloadCommandResult;
  try {
    dl = await args.run();
  } catch (err) {
    args.onError?.(err);
    // ⚠️ 不敢说「本机数据未受影响」：SW 是在下载途中被杀的，合并到底落没落盘
    // 本页无从得知。说错方向会让用户白白重复一次或误以为已经拉全了。
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: 'blocked',
      reason:
        `从云端下载失败：${detail}。` +
        '后台同步进程可能已中断，本机是否已合并**无法确认** —— ' +
        '请重新点一次「从云端下载到本机」并核对两边数量后再继续。',
    };
  }
  if (!dl.ok) {
    return {
      kind: 'blocked',
      reason: `从云端下载失败：${args.copyOf(dl.error)}。本机数据未受影响。`,
    };
  }
  // 走到这里数据已经真的合了：收尾失败不得把结果改写成失败。
  const { pendingCleared } = await args.complete();
  return { kind: 'done', pendingCleared };
}
