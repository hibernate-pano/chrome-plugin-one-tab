/**
 * 「登记的待传会话」与「本轮真的上行的会话」之间的**覆盖判据**（2026-10-20 D-3）。
 *
 * ── 这条判据为什么必须存在 ────────────────────────────────────────────────
 * 归属待决期（WebDAV 首次同步）上传的是**增量白名单**里的会话。白名单由写方
 * 一路登记（core/mutationAffectedGroups + storage.noteGroupsChanged），
 * 而「本轮实际上行哪些」由 `activeGroups ∩ 白名单` 决定。
 *
 * 修复前的致命缝隙：**这两个集合没有对账**。白名单里全是不存在的 id 时
 * （导入路径登记的是备份文件里的 id，而落盘时 id 被 `genId()` 重新生成），
 * 上行集合是空集，而 `pending_upload` 与白名单照样被清掉 ——
 * 20 个导入的会话永远到不了云盘，alarm 与 60s 轮询也不再重试，界面毫无提示。
 *
 * ── 判据放在纯函数里的理由 ────────────────────────────────────────────────
 * 1. 这是**后端无关**的：Supabase 与自带存储走的是同一段引擎代码，
 *    判据只有一份 ⇒ 两个后端不会漂移（漂移过一次的地方正是它）。
 * 2. 纯函数才能对每种组合打行为断言（本仓库没有 DOM 测试环境）。
 *
 * ── 为什么「提交给后端裁决」就算「已同步」 ────────────────────────────────
 * 后端可能**认输**（远端版本更新，本地不上行，等下次下载合并物理替换）。
 * 认输是**已裁决**，不是「没传上去」——把它算成未同步会让 pending_upload
 * 永远清不掉、上传陷入无限重试。
 *
 * ── 2026-10-20 D-10：「登记不可信」标志不再自锁 ──────────────────────────
 * 这个标志描述的是「**上一轮**的登记失败」——
 * 即「我可能漏登记了某些改动，所以『登记集合 ⊆ 上行集合』这个对账不足以证明没漏」。
 *
 * 它原先的复位条件写在引擎的 `if (coverage.canClearPending)` 之内，
 * 而那个判据里含「标志为假」⇒ **标志为真 ⇒ 判据为假 ⇒ 复位永远执行不到**
 * ⇒ 自锁（标志一旦置上就永不复位 ⇒ pending_upload 永远清不掉 ⇒ 每轮后台
 * 同步都在重跑上传，而界面还报「同步成功」——因为 `skippedGroups` 恒为
 * `undefined`，读起来像「没有例外」）。
 *
 * 本文件给出的是**与上传对账完全无关**的复位路径，两个方向各一条：
 *   · 写方侧（`decideRegistryAfterRegistryWrite`）：「本次登记成功」
 *     ⇒ 「登记机制此刻不可信」这个事实不再成立；
 *   · 读方侧（`decideRegistryAfterUpload`）：「本轮提交的是**全量**」
 *     ⇒ 漏登记的那批就在这份全量里 ⇒ 缺口补上了。
 *
 * 两条都依据**事实**（登记成功 / 本轮提交了什么），与「对账是否通过」无关，
 * 因此不存在自指。
 */
export interface UploadCoverageInput {
  /**
   * 本轮登记的待传会话 id（增量白名单快照）。
   * 空 = 本轮没有登记任何改动。
   */
  registeredIds: readonly string[];
  /**
   * 本轮实际**提交给后端裁决**的会话 id（后端认输的也算已裁决）。
   */
  submittedIds: readonly string[];
  /**
   * 本轮是否真的调用了后端上传。
   * false = 一个都没提交（清单为空、或被闸门挡下）。
   */
  uploadPerformed: boolean;
  /**
   * 登记过程本身不可信（白名单写入失败 ⇒ 不知道漏登记了哪些改动）。
   *
   * 这一项独立于集合比较：白名单**读得到**不等于它**写全了**。
   * 登记失败时即便两个集合看起来「覆盖完整」，也不能宣称「都同步了」。
   */
  registryUnreliable?: boolean;
  /**
   * 「漏登记的那批改动」**还没被一次全量提交覆盖**（2026-10-20 D-10）。
   *
   * 与 `registryUnreliable` 的区别（两者都是「不得宣称全部已同步」的理由）：
   *   · unreliable —— 登记机制**此刻**不可信（最近一次登记失败了）；
   *   · gapOpen —— 之前漏登记的那批改动**至今没被全量补传过**。
   *
   * 漏登记 ⇒ 那批改动的 id **已经不知道了** ⇒ 唯一的兜底是「全量传一次」。
   */
  registryGapOpen?: boolean;
  /**
   * 本轮的上传清单是不是**由登记集合（白名单）决定**的。
   *
   * ── 它是「登记不可信」这个标志**是否影响本轮结论**的唯一判据 ──────────
   * · 清单由白名单过滤（WebDAV 归属待决期）⇒ 登记不完整 = 本轮真的漏传
   *   ⇒ 标志**阻断**本轮（不得宣称「都同步了」、不得清 pending_upload）；
   * · 清单是**全量**（本机全部活跃会话）⇒ 登记完整与否**不影响本轮传了什么**
   *   —— 漏登记的那批改动也在这份全量里 ⇒ 标志**不阻断**本轮。
   *
   * ⚠️ 缺省为 true（保守）：读不到时宁可当成「本轮依赖登记集合」。
   * 判成 false 的代价是「漏登记的改动被当成已传」；判成 true 的代价只是
   * 「多留一轮 pending_upload」—— 后者远小于前者。
   */
  scopeDerivedFromRegistry?: boolean;
  /**
   * 已知以「删除」结案的会话 id（本轮已广播删除、或删除意图还在队列里）。
   *
   * 它们**不该**被上行（本地已经没有这个会话了），所以不能算「未同步」。
   */
  deletedIds?: readonly string[];
}

export interface UploadCoverage {
  /** 登记了、但本轮没有上行的会话 id（已去掉以删除结案的）。 */
  unsyncedIds: string[];
  /** unsyncedIds 的长度。 */
  unsyncedCount: number;
  /**
   * 能不能清 `pending_upload` 与增量白名单。
   *
   * false ⇒ **保留** pending_upload（让下一轮重试），并把「有变更没传上去」
   * 如实报给调用方。true ⇒ 两样都可以清。
   */
  canClearPending: boolean;
  /** 登记过程不可信（白名单写入失败）。 */
  registryUnreliable: boolean;
  /**
   * 「漏登记的那批改动」**还没被一次全量提交覆盖**（2026-10-20 D-10）。
   *
   * 这一位与 `registryUnreliable` 都是「不得宣称全部已同步」的理由，
   * 但含义不同：unreliable 是「登记机制此刻不可信」，gapOpen 是
   * 「之前漏掉的那批至今没补传」。
   */
  registryGapOpen: boolean;
  /**
   * 本轮**无法确认「全部已同步」**。
   *
   * 与 `canClearPending` 同为 false 但含义不同：
   *   · `canClearPending=false` + 本项 false ⇒ 确实有会话没传上去（数量已知）；
   *   · `canClearPending=false` + 本项 true  ⇒ 集合对得上账，但「没漏」这件事
   *     **无从证明** ⇒ 同样不得宣称「全部已同步」。
   *
   * 这一项是给界面看的：它为 true 时界面**必须**说「无法确认是否全部同步」，
   * 不能报「同步成功」—— 那正是自锁期里界面在撒谎的地方。
   */
  cannotConfirmAllSynced: boolean;
}

/** 去重且保序。 */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * 对账「登记的待传集合」与「本轮上行的集合」。
 *
 * 判据（两条都满足才算「本轮真的传了」）：
 *   1. 登记集合 ⊆ 上行集合 ∪ 删除结案集合；
 *   2. 本轮**没有**「漏登记的改动没被补上」这种缺口。
 *
 * ── 第 2 条的两种形态 ──────────────────────────────────────────────────
 * · 本轮清单由**白名单**决定（归属待决期）⇒ 登记不可信 ⇒ 本轮真可能漏传
 *   ⇒ 阻断（不得宣称「都同步了」、不得清 pending_upload）。
 * · 本轮清单是**全量**⇒ 登记不可信**不影响本轮传了什么**（漏登记的那批
 *   就在这份全量里）⇒ 不阻断。
 *
 * ⚠️ 注意这里与 D-3 的差别：D-3 判「登记不可信 ⇒ 恒不阻断」，那正是自锁的
 * 另一半（标志清不掉）。现在阻断与否取决于「本轮传的全不全」，而不是
 * 「标志是不是还挂着」—— 标志由本文件下面两个迁移函数独立复位。
 */
export function reconcileUploadCoverage(input: UploadCoverageInput): UploadCoverage {
  const registered = unique(input.registeredIds);
  const submitted = new Set(unique(input.submittedIds));
  const deleted = new Set(unique(input.deletedIds ?? []));

  const unsyncedIds = registered.filter(id => !submitted.has(id) && !deleted.has(id));
  const registryUnreliable = input.registryUnreliable === true;
  const registryGapOpen = input.registryGapOpen === true;
  // 本轮清单是不是**由白名单**决定的（缺省 true = 保守）。
  const scopeDerivedFromRegistry = input.scopeDerivedFromRegistry !== false;
  // 登记不可信**且**本轮清单依赖白名单 ⇒ 本轮真的可能有改动没传上去。
  // 反过来（本轮是全量）⇒ 漏登记的那批也在这份全量里 ⇒ 本轮传的全不缺。
  const registryBlocksThisRound = registryUnreliable && scopeDerivedFromRegistry;

  return {
    unsyncedIds,
    unsyncedCount: unsyncedIds.length,
    // 登记不可信（且本轮依赖白名单）/ 漏登记未补齐 ⇒ 永远不能说「都传了」。
    canClearPending: !registryBlocksThisRound && !registryGapOpen && unsyncedIds.length === 0,
    registryUnreliable,
    registryGapOpen,
    // 界面据此决定能不能说「全部已同步」。
    cannotConfirmAllSynced:
      registryBlocksThisRound || registryGapOpen || unsyncedIds.length > 0,
  };
}

/** 「登记不可信」标志的状态（两个位 + 一个并发保护计数器）。 */
export interface RegistryFlagState {
  /**
   * 登记机制**此刻**不可信（最近一次写方登记失败了）。
   *
   * 复位条件 = **下一次登记成功**（写方事实，与上传对账无关）。
   */
  unreliable: boolean;
  /**
   * 之前漏登记的那批改动**还没被一次全量提交覆盖**。
   *
   * 复位条件 = **一次全量提交**（那批改动就在这份全量里）。
   *
   * ⚠️ 它与 `unreliable` 必须**分开**：只复位 `unreliable` 是不够的 ——
   * 那样下一轮又按白名单过滤 ⇒ 漏登记的那批**永远传不上去**（静默丢失）。
   */
  gapOpen: boolean;
}

/**
 * 写方侧的标志迁移（2026-10-20 D-10）。
 *
 * ── 判据依据的是**写方的事实**，与上传对账**完全无关** ⇒ 不自指 ─────────
 * 标志为 true 时，下一次写方登记成功就能把它清掉 —— 这就是那条
 * 「与上传对账无关的解除路径」。
 *
 * ── 为什么「登记成功」只清 unreliable、不清 gapOpen ─────────────────────
 * 漏登记的那批改动的 id **压根没记下来** ⇒ 事后**无法**枚举它们 ⇒
 * 唯一的兜底是「全量传一次」⇒ 必须等那次全量真的发生。
 * 在这之前清掉 gapOpen ⇒ 下一轮按白名单过滤 ⇒ 漏登记的那批永远传不上去
 * （静默丢失，且没有任何提示）。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 「登记成功」作用在已经可信的状态上 ⇒ 状态不变（changed=false ⇒ 不写盘）。
 * 「登记失败」作用在已经失败的状态上 ⇒ 状态不变（除了并发计数器，见下）。
 */
export function decideRegistryAfterRegistryWrite(input: {
  /** 写入前的状态。 */
  before: RegistryFlagState;
  /** 本次登记是否成功（noteGroupsChanged 没抛错）。 */
  writeSucceeded: boolean;
}): {
  /** 写入后的状态。 */
  after: RegistryFlagState;
  /** 状态是否发生了变化（没变 ⇒ 调用方不必写盘）。 */
  changed: boolean;
} {
  const after: RegistryFlagState = input.writeSucceeded
    ? { unreliable: false, gapOpen: input.before.gapOpen }
    : { unreliable: true, gapOpen: true };
  return {
    after,
    changed: after.unreliable !== input.before.unreliable || after.gapOpen !== input.before.gapOpen,
  };
}

/**
 * 读方侧（上传轮次）的标志迁移（2026-10-20 D-10）。
 *
 * ── 判据依据的是「本轮提交了什么」这个**事实**，与对账**完全无关** ───────
 * 本轮提交的是**全量**（本机每一个活跃会话都在提交清单里）⇒ 漏登记的那批
 * 就在这份全量里 ⇒ 缺口补上了 ⇒ 标志整体清掉。
 *
 * 这就是自锁的解药：原来的复位条件是「对账通过」，而「对账通过」需要
 * 「标志为假」⇒ 标志为真时永远对不上账 ⇒ 永远不复位。
 * 现在复位看的是「本轮是不是全量」—— 标志为真恰恰**促使**下一轮走全量
 * ⇒ 下一轮就把标志清了 ⇒ 不再死锁。
 *
 * ── 为什么全量提交可以**两个位一起清** ─────────────────────────────────
 * 一次全量提交意味着「本机有的每一个会话都提交了」⇒ 登记完整与否
 * **不影响本轮传了什么**（漏登记的那批也在这份全量里）。
 * 这也是「后台不会永远在重试」的保证：普通轮次本来就是全量 ⇒ 标志最多
 * 挂一轮就被清掉 ⇒ pending_upload 随即被清 ⇒ 不再每轮重跑。
 *
 * ── 本轮不是全量 ⇒ 状态原样保留 ───────────────────────────────────────
 * （含「本轮没发生登记」—— 那不构成任何证据，既不能复位也不能置位。）
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 * 已经是干净的状态再走一次 ⇒ after == before ⇒ changed=false ⇒ 不写盘。
 */
export function decideRegistryAfterUpload(input: {
  /** 轮次开始时读到的状态。 */
  before: RegistryFlagState;
  /**
   * 本轮提交的是不是**全量**（本机每一个活跃会话都在提交清单里）。
   *
   * 事实的准确表述是「本轮提交出去的会话**覆盖了本机全部活跃会话**」——
   * 由调用方数出来（submittedIds ⊇ 本机活跃会话 id），不由本函数猜。
   */
  submittedFullScope: boolean;
}): {
  /** 轮次结束后的状态。 */
  after: RegistryFlagState;
  /**
   * 本轮是否**需要**全量上传才能补上漏登记的那批改动。
   *
   * 判据 = 「gapOpen 还开着」⇒ 之前漏登记过 ⇒ 那一批 id 已经不知道
   * ⇒ 必须靠全量兜底。
   *
   * ⚠️ 这是**需要**，不是**强制**：归属待决期（WebDAV 首次同步）禁止自动
   * 全量上传 —— 那会替用户做归属决定（见 syncEngine 的 decideSuppressFullUpload）。
   * 那种情况下本轮**不能**全量 ⇒ gap 保持开着 ⇒ 引擎如实上报「无法确认
   * 全部已同步」并告诉用户下一步（完成归属决策的那一次上传就是全量 ⇒
   * gap 在那一轮关闭）。**不许**为了关 gap 而绕过归属决策。
   */
  needsFullScope: boolean;
  /** 状态是否发生了变化（没变 ⇒ 调用方不必写盘）。 */
  changed: boolean;
} {
  const after: RegistryFlagState = input.submittedFullScope
    ? { unreliable: false, gapOpen: false }
    : { unreliable: input.before.unreliable, gapOpen: input.before.gapOpen };
  return {
    after,
    // gapOpen 还开着 ⇒ 漏登记的那批还没补上 ⇒ 需要一次全量。
    needsFullScope: after.gapOpen,
    changed: after.unreliable !== input.before.unreliable || after.gapOpen !== input.before.gapOpen,
  };
}
