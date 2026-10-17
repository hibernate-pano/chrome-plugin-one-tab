import type { TabGroup } from '../types/tab';

// ── 下载前置保护（防「本地删除被云端旧数据复活」） ──────────────────────

/**
 * 上传保护窗口。chrome.alarms 驱动的延迟上传最小间隔 30s，刚完成上传的
 * 短窗口内云端已是本地新状态，后续到达的下载合并应跳过——避免与在途
 * 上传竞态、用云端旧版本覆盖本地新版本。
 */
export const UPLOAD_GUARD_MS = 35_000;

export interface DownloadPrecheckInput {
  /** forceRemote = 用户显式要求云端覆盖本地，跳过一切保护 */
  forceRemote: boolean;
  /** 最近一次成功上传时间戳（ISO），null 表示从未上传 */
  lastUploadTime: string | null;
  /** 本地是否有未推送变更 */
  pendingUpload: boolean;
  now: number;
}

export type DownloadPrecheckAction =
  | { action: 'skip'; reason: 'recent_upload_guard' }
  | { action: 'upload_first' }
  | { action: 'proceed' };

/**
 * 决定 downloadAndMerge 的前置动作。纯函数，便于单测覆盖全部分支。
 *
 * 规则（按顺序短路）：
 * 1. forceRemote → 直接下载（用户显式覆盖意图）
 * 2. 刚上传过（UPLOAD_GUARD_MS 内）→ 跳过下载：云端已是本地新状态，
 *    再拉只会浪费且可能与在途上传竞态
 * 3. 有未推送变更 → 先上传再下载：否则「删除书签后 upload alarm 未到
 *    就触发下载」会让云端旧数据把刚删的内容合并回来（复活），事后再
 *    把复活后的状态推上云，删除意图彻底丢失
 * 4. 其余 → 正常下载
 *
 * 注意 guard 只在此处检查一次；upload_first 成功后的下载流程不再重查
 * （否则会被自己刚刷新的 lastUploadTime 挡住）。
 */
export function decideDownloadPrecheck(input: DownloadPrecheckInput): DownloadPrecheckAction {
  if (input.forceRemote) return { action: 'proceed' };

  if (input.lastUploadTime) {
    const sinceUpload = input.now - new Date(input.lastUploadTime).getTime();
    if (sinceUpload >= 0 && sinceUpload < UPLOAD_GUARD_MS) {
      return { action: 'skip', reason: 'recent_upload_guard' };
    }
  }

  if (input.pendingUpload) return { action: 'upload_first' };

  return { action: 'proceed' };
}

/**
 * 云端软删（墓碑）写入方式决策——纯函数，便于单测钉住降级行为。
 *
 * 关键不变式：**只有云端连 is_deleted 列都没有时才允许硬删**。
 * 印记列（last_op_seq）缺失或探测失败时，软删必须仍走「不带印记的局部 UPDATE」，
 * 绝不降级成 DELETE——硬删让云端行永久消失，他端活跃副本再上传就重新 INSERT 出同一组
 * = 幽灵复活；而印记列与「把 is_deleted 置 true」本身无关。
 */
export function decideCloudTombstoneWrite(
  hasTombstoneColumn: boolean,
  hasStampColumn: boolean
): 'stamp' | 'plain' | 'hard-delete' {
  if (!hasTombstoneColumn) return 'hard-delete';
  return hasStampColumn ? 'stamp' : 'plain';
}

// ── 轻量探活指纹对比（P0-3 收紧：单调 seq 为主，时间戳仅参考） ─────────────

/** hasRemoteChanges 的输入行：digest 全列或最小列（缺列时对应字段为 undefined） */
export interface GroupDigestLike {
  id: string;
  updated_at: string;
  version?: number | null;
  is_deleted?: boolean | null;
  last_op_device?: string | null;
  last_op_seq?: number | null;
}

/**
 * 指纹对比：云端 digest 行 vs 本地快照。任一信号即视为有变更（宁可误判走一次
 * 全量，也不漏判导致本地 stale）。探活只做“无变更短路”，永不改变合并结果。
 *
 * ── 2026-10-10 缺陷 1：按 id 集合比对，墓碑行单独计（P1 恒 true）──
 *
 * 【旧判据与它的真实后果】原来是 `if (digest.length !== localGroups.length) return true`
 * 作为第一条信号。而 digest 的查询（probe.ts fetchTabGroupsDigest）按设计**不过滤**
 * is_deleted：云端删除是以「行保留 + is_deleted=true」的墓碑形式存在 30 天
 * （purgeExpiredCloudTombstones），被删的会话行**永远留在 digest 里**。
 * 于是：
 *   设备 A 删一个会话 → 设备 B 下轮把组合并掉（本地不再保留）
 *   → 云端那一行仍是墓碑 → digest.length = N（含墓碑）而 localGroups.length = N-1
 *   → hasRemoteChanges **恒 true** → up_to_date 短路永不命中 → 每 60s 走一次
 *     全量 downloadTabGroups（每组一次 PBKDF2-100k 约 9ms、整份 blob 写回 IndexedDB、
 *     notifyGroupsChanged 唤醒所有已打开的管理页整表重载）。
 * 影响面 = 用过一次跨端删除的用户 × 30 天 × 每台设备。
 *
 * 【为什么不用「在 digest 查询里加 .eq('is_deleted', false)」这种更小的改法】
 * 因为 count 交叉校验（探活的 fail-open 自证完整性）拿的 Content-Range 总行数
 * 与「实际逐回的数组长度」必须在**同一个口径**上：若过滤了墓碑，count(exact)
 * 返回的仍是过滤后的行数（两者仍自洽，但 digest 的行数从此与「云端实际行数」脱钩，
 * 排查时无法区分「云端只有 N 行」与「云端 N+1 行、其中 1 行是墓碑」）。同时
 * tombstone 墓碑行的变化（新增删除广播）本来就**必须**计入变更信号，
 * 在过滤层丢掉它们等于在查询层丢掉信号——这比在判定层丢掉更早、更难查。
 *
 * 【新判据：双向 id 集合差 + 逐行指纹】
 * 1) 云端活跃行（is_deleted 不为真）里出现本地没有的 id → 新增
 * 2) 本地有、云端活跃行里没有的 id → 云端硬删 / 墓碑（本地已服从或未上传）
 * 3) 两侧同 id 的逐字段指纹（seq/device/updated_at/version/is_deleted）比对
 * 云端墓碑行（is_deleted=true）**不参与**与本地的集合比对：它按设计长期存在，
 * 它的“删除意图”已由 B 设备吸收进本地状态（本地副本已消失），不需要反复触发全量。
 * 墓碑行只在一开始被吸收时（本地尚有该组）通过第 3 条的 is_deleted 位比对触发一次变更。
 *
 * 【不变式：仍只减“恒 true 的假信号”，不漏判任何真实变更】
 * 原本由“长度不等”捕捉的“新增/硬删”信号，现在由第 1、2 条按 id 集合捕捉，
 * 强度等价（长度不等蕴含两侧 id 集合不等，反之不成立——但反过来的那一侧已被
 * 第 1、2 条盖住）。探活仍只做“无变更短路”，任何真实的云端内容/删除位变化仍会
 * 被逐字段指纹捕捉。
 */
export function hasRemoteChanges(localGroups: TabGroup[], digest: GroupDigestLike[]): boolean {
  // 只拿云端的**活跃行**参与比对；墓碑行（is_deleted=true）单独统计。
  // is_deleted 字段在未迁移 schema 的最小列 digest 里是 undefined —— 那种情况下
  // 所有行都当作活跃（无墓碑可剔，与「云端只能硬删」的降级模式一致）。
  const cloudActive: GroupDigestLike[] = [];
  for (const row of digest) {
    if (row.is_deleted === true) continue; // 墓碑行：并入 cloudTombstoneCount，不参与集合差
    cloudActive.push(row);
  }

  // 1) 行数先比（**活跃行**口径）：两侧活跃数不等 → 新增 / 硬删
  if (cloudActive.length !== localGroups.length) return true;

  const localById = new Map<string, TabGroup>(localGroups.map(g => [g.id, g]));
  for (const row of cloudActive) {
    const local = localById.get(row.id);
    // 2) 云端活跃行有本地没有的 id → 云端新增
    if (!local) return true;
    // 3) seq 为主：任一侧有印记就必须逐字段比对，不等即变更
    const cloudSeq = row.last_op_seq ?? null;
    const localSeq = local.lastOp?.s ?? null;
    if (cloudSeq !== null || localSeq !== null) {
      if (cloudSeq !== localSeq) return true;
      const cloudDev = row.last_op_device ?? null;
      const localDev = local.lastOp?.d ?? null;
      if (cloudDev !== null || localDev !== null) {
        if (cloudDev !== localDev) return true;
      }
    }
    // 4) 时间戳仅参考：毫秒比较防字符串格式抖动
    const cloudTime = Date.parse(row.updated_at);
    const localTime = Date.parse(local.updatedAt);
    const timeChanged =
      Number.isNaN(cloudTime) || Number.isNaN(localTime)
        ? row.updated_at !== local.updatedAt
        : cloudTime !== localTime;
    if (timeChanged) return true;
    if ((row.version ?? 1) !== (local.version ?? 1)) return true;
    if (row.is_deleted !== undefined && row.is_deleted !== null) {
      if (Boolean(row.is_deleted) !== Boolean(local.isDeleted)) return true;
    }
    localById.delete(row.id);
  }
  // 集合相等时正常应清空；防御性保留（map 残留 = 本地独有的活跃 id → 云端硬删）
  return localById.size > 0;
}

/**
 * 获取需要同步到云端的标签组
 * @param groups 所有标签组
 * @returns 需要同步的标签组（排除软删除的）
 */
export const getGroupsToSync = (groups: TabGroup[]): TabGroup[] => {
  // 过滤掉已软删除的标签组
  return groups.filter(group => !group.isDeleted);
};

/**
 * 覆盖下载（forceRemote）的**空云端闸门**。
 *
 * ── 为什么需要它：覆盖路径绕过 validateMergeResult 的规则 2 ────────────
 * syncEngine.downloadAndMerge 在 forceRemote 下于合并**前**把 localGroups
 * 置成 `[]`（云端完全镜像本地的语义），于是 validateMergeResult 看到的
 * activeLocalCount 恒为 0，规则 2「本地有活跃数据但合并后为空」永远不会
 * 触发 —— 覆盖路径下那条防线形同不存在。
 *
 * 后果就是最坏的那种：用户在 1.24.0+ 点「从云端下载（覆盖）」，而云端恰好
 * 是空的（还没配好 / 库被清空 / 换个库地址连上了空盘 / 刚清过云端数据），
 * 本机会话被**整体清空**，而 UI 显示覆盖成功。
 * 1.22.0 起删除即物理清除、无回收站 —— 这不可逆。
 *
 * ── 判据为什么不含「云端只有墓碑」────────────────────────────────────
 * 云端只有 is_deleted 行（没有活跃行）时，那正是「另一台设备把会话都删了」，
 * 收敛到空是**必须传播的合法结果**。用 cloudGroups.length 当判据会把它
 * 也拦下来，于是删除永远传不过来、对端留一份永不收敛的僵尸副本。
 * 所以判据用 cloudTotalCount（行数，含墓碑）而非活跃数。
 *
 * ── 为什么放在 syncDecision 而不是 syncEngine ──────────────────────────
 * 与 decideDownloadPrecheck 同构：纯函数、可在 node:test 直测、不碰 chrome.*。
 * 引擎那侧只负责「调用点 + 落用户文案」，判据本身不留在 IO 交错里。
 */
export interface ForceRemoteOverwriteInput {
  /** 本地活跃（未删除）会话数 */
  localActiveCount: number;
  /** 云端行数（含墓碑行）：0 = 云端一个字节都没有 */
  cloudTotalCount: number;
}
export type ForceRemoteOverwriteDecision =
  | { action: 'proceed' }
  // ⚠️ reason 只进日志（syncEngine logError），**不给用户看**：用户文案由
  // SyncButton 的 REASON_COPY['overwrite_empty_cloud_refused'] 提供。
  // 这里保留一句完整表述是为了日志能独立说明「拒绝了什么」，但它与
  // REASON_COPY 是两处文案 —— 改文案时别只改一处。
  | { action: 'refuse'; reason: string };

export function decideForceRemoteOverwrite(
  input: ForceRemoteOverwriteInput
): ForceRemoteOverwriteDecision {
  if (input.localActiveCount > 0 && input.cloudTotalCount === 0) {
    return {
      action: 'refuse',
      reason:
        `云端没有任何数据，用空云端覆盖会清空本机 ${input.localActiveCount} 个会话且无法恢复，` +
        '已中止。如需清空本机请手动删除会话。',
    };
  }
  return { action: 'proceed' };
}

/**
 * 校验合并结果，防止「同步覆盖导致本地数据丢失」时自动回滚。
 *
 * ⚠️ 基线只算本地「活跃」组（isDeleted=false）：legacy 的 mergeTabGroups 第一步会跳过软删组，
 * 而 storage.getGroups() 返回的数组含软删组。若用 localGroups.length（含软删）当基线，
 * 累积的软删组会抬高 expectedMin，导致正常合并被误判为非法 → 触发回滚 → 云端变更永远同步不进来。
 *
 * ⚠️ 覆盖下载（forceRemote）的空云端保护**不在这里**，而是上游的
 * decideForceRemoteOverwrite：那条路径在合并前就把 localGroups 置空，
 * 本函数的规则 2 在它上面恒不可达。两处必须分工明确，改一处要想到另一处。
 */
export function validateMergeResult(
  localGroups: TabGroup[],
  cloudGroups: TabGroup[],
  mergedGroups: TabGroup[]
): { valid: boolean; reason?: string } {
  const activeLocalCount = localGroups.filter(g => !g.isDeleted).length;

  // 规则 1：两边都没有活跃数据，合并为空是正常的
  if (activeLocalCount === 0 && cloudGroups.length === 0 && mergedGroups.length === 0) {
    return { valid: true };
  }

  // 规则 2：本地有活跃数据但合并后为空，异常
  if (activeLocalCount > 0 && mergedGroups.length === 0) {
    return {
      valid: false,
      reason: `本地有 ${activeLocalCount} 个活跃组，但合并后为 0（可能云端覆盖了所有本地数据）`,
    };
  }

  // 规则 3：合并后组数不应低于 活跃本地组数 减去云端明确删除的组数
  const cloudDeletedCount = cloudGroups.filter(g => g.isDeleted).length;
  const expectedMin = Math.max(0, activeLocalCount - cloudDeletedCount);

  if (mergedGroups.length < expectedMin) {
    return {
      valid: false,
      reason: `合并后 ${mergedGroups.length} 个组，低于预期最小值 ${expectedMin}（活跃本地 ${activeLocalCount}，云端删除 ${cloudDeletedCount}）`,
    };
  }

  return { valid: true };
}
