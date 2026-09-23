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
 * P0-3 判定顺序（只增信号、不减信号，保证 fail-open 无漏判）：
 * 1) 行数不等 → 新增 / 硬删
 * 2) digest 有本地没有的 id → 云端新增
 * 3) 本地有 digest 没有的 id → 云端硬删
 * 4) 单调 seq 不等（任一侧有印记即比较；云端有、本地无也算变更）→ 内容/意图变更
 *    ※ seq 相等时仍继续检查版本/时间戳/删除位（时间戳仅作参考信号之一）
 * 5) 同 id 下 updated_at 不等 → 内容更新（毫秒比较，防字符串格式抖动）
 * 6) version 不等 → 版本推进
 * 7) is_deleted 不等（列存在时） → 删除状态变化
 */
export function hasRemoteChanges(localGroups: TabGroup[], digest: GroupDigestLike[]): boolean {
  if (digest.length !== localGroups.length) return true;
  const localById = new Map<string, TabGroup>(localGroups.map(g => [g.id, g]));
  for (const row of digest) {
    const local = localById.get(row.id);
    if (!local) return true;
    // 4) seq 为主：任一侧有印记就必须逐字段比对，不等即变更
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
    // 5) 时间戳仅参考：毫秒比较防字符串格式抖动
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
  // 行数相等时正常应清空；防御性保留（map 残留 = 本地独有 id）
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
 * 校验合并结果，防止「同步覆盖导致本地数据丢失」时自动回滚。
 *
 * ⚠️ 基线只算本地「活跃」组（isDeleted=false）：mergeTabGroups 第一步会跳过软删组，
 * 而 storage.getGroups() 返回的数组含软删组。若用 localGroups.length（含软删）当基线，
 * 累积的软删组会抬高 expectedMin，导致正常合并被误判为非法 → 触发回滚 → 云端变更永远同步不进来。
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
