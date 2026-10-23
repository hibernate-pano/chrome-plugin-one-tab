/**
 * 云端差量判据：让下载的**字节量与「变更量」成正比**，而不是与「库大小」成正比。
 *
 * ── 为什么需要它（2026-10-23，第 53 轮）────────────────────────────────
 * 云端出网（egress）按「发出去多少字节」计，Free 档 5GB / 30 天。
 * 而全量下载 `select *` 会把**每一行**的加密 tabs_data 都拉回来
 * （实测：100 组 × 10 标签时，tabs_data 占响应体 **93.5%**）。
 * 后台同步每 10 分钟一轮（存量用户 syncEnabled=true）⇒ 一天 144 轮 ⇒
 * 每台设备每 30 天要发「库大小 × 144 × 30」字节：
 * 100 组 × 10 标签 ≈ 436KB/轮 ⇒ 单设备 ≈ **1.8GB / 30 天**；
 * 库到 300 组、或用户有 3～4 台设备 ⇒ 直接撞穿 5GB ⇒ **整个项目被封**
 * （Supabase 的 egress 封禁是**项目级**的：连 /auth/v1/health 都返回 402，
 *   不是「某个用户慢一点」，是「全项目不可用」）。
 *
 * ⇒ 结构性解法不是「少同步几轮」（那是把症状压小），而是
 *   **让每轮只传真正变了的那几行** ⇒ 出网量 ∝ 变更量，与库大小无关。
 *
 * ── 本模块是**纯判据**（无 IO）─────────────────────────────────────────
 * 输入：本地活跃组 + 本地墓碑残留 id + 云端指纹（digest）
 * 输出：① 哪些云端行必须回源取 payload；
 *      ② 哪些云端行「本地那份就能代表它」（不必回源）；
 *      ③ 哪些云端行是墓碑（**只需印记，不需 payload**）。
 *
 * ── 为什么「本地那份就能代表云端那一行」是**安全的**─────────────────────
 * 合并（mergeOpStamped）对「两端都有」的组做**印记决胜**：
 * 印记相同 ⇒ `pickByStamp` 返回**本地那份** ⇒ 云端那份的内容**被丢弃**。
 * ⇒ 对「本地印记 ≥ 云端印记」的行，回源取回云端内容是**纯浪费**
 *   （多解一次 PBKDF2-100k、多传一次全量 blob），而用本地副本代表它，
 *   合并结果**逐字相同**。这正是「出网量 ∝ 变更量」能成立的全部依据。
 *
 * ⚠️ 这条依据只在**印记可���**时成立 —— 所以判据里用的比较函数
 *   （`compareStamps`）必须与合并里那个**是同一份**（opStamp.ts），
 *   不许在这里另抄一份比较规则（判据漂移是这个仓库反复出现的事故类型）。
 */
import type { TabGroup } from '../types/tab';
import type { GroupDigestLike } from './syncDecision';
import { compareStamps, EMPTY_STAMP } from './opStamp';

/** 云端指纹行 → 该行的操作印记（缺失 = 最小值，与合并口径一致）。 */
function cloudStampOf(row: GroupDigestLike): { d: string; s: number } {
  // 条件与下载侧构造 lastOp 的那句**逐字一致**（utils/supabase/download.ts）：
  // seq 必须是 number 且 device 非空，否则视为「无印记」。
  return typeof row.last_op_seq === 'number' && row.last_op_device
    ? { d: String(row.last_op_device), s: row.last_op_seq }
    : EMPTY_STAMP;
}

/**
 * 本地那份会不会赢下这一行的合并？
 *
 * ⚠️ 必须与 `mergeOpStamped` 的 `pickByStamp` **同规则**：
 *   那里是 `compareStamps(sa, sb) >= 0 ? a : b`（a = 本地，b = 云端），
 *   缺失印记一律当 EMPTY_STAMP。差一个符号 ⇒ 会把「云端更新的那一行」
 *   误判成「本地赢」⇒ **云端的新内容被静默丢弃**（用户看到的现象是
 *   「另一台设备改了，这台永远不变」）。
 */
function localWins(local: TabGroup, row: GroupDigestLike): boolean {
  return compareStamps(local.lastOp ?? EMPTY_STAMP, cloudStampOf(row)) >= 0;
}

export interface CloudDeltaInput {
  /**
   * 本地**活跃**组（合并输入口径：已剥掉本地墓碑残留）。
   * 必须与引擎喂给 mergeOpStamped 的那一份**同口径**。
   */
  localGroups: TabGroup[];
  /**
   * 本地墓碑残留的 id（老版本写入形状）。
   *
   * 它们的云端对应行**必须照旧回源取回** —— 因为合并时本地那份已被剥掉，
   * 云端那一行会以「云端有、本地无」的身份进合并结果（D-8 的复活链路）。
   * 不取回 ⇒ 行为与今天的全量下载不一致。
   */
  localTombstoneIds: string[];
  /** 云端指纹（digest）。必须**完整**（探活层已做 count 交叉校验）。 */
  digest: GroupDigestLike[];
}

export interface CloudDelta {
  /** 必须回源取 payload 的云端行 id（内容可能已变，或本地根本没有）。 */
  payloadIds: string[];
  /**
   * 「云端这一行会被本地那份盖住」的云端行 id。
   *
   * 合并结果里这一行 = 本地那份（印记决胜），所以**不必**回源，
   * 用本地副本代表它即可（装配时用）。
   */
  coveredByLocalIds: string[];
  /**
   * 云端墓碑行（is_deleted=true）。
   *
   * 墓碑**只需要印记**就能完成合并（mergeOpStamped 的墓碑分支只比印记），
   * 不需要它的 tabs_data ⇒ **不回源**。
   *
   * ⚠️ 一处**行为变化**（如��化、且是修复方向）：今天全量下载时，
   *   墓碑行的 payload 若「读不出来」会被整组跳过 ⇒ 它不在云端集合里 ⇒
   *   删除意图**传不过来** ⇒ 那一组在对端复活（本地那份还会把墓碑盖回去）。
   *   合成墓碑（只用印记）让删除意图**正常传播** —— 这正是墓碑存在的意义。
   */
  tombstones: GroupDigestLike[];
}

/**
 * 算出「这一轮真正需要回源取的那几行」。
 *
 * 纯函数，无 IO。输入的 digest 必须完整（探活层已交叉校验行数），
 * 否则「云端有、本地没有」的那几行会被误判成「不存在」⇒ 内容丢失。
 */
export function computeCloudDelta(input: CloudDeltaInput): CloudDelta {
  const localById = new Map<string, TabGroup>();
  for (const g of input.localGroups) localById.set(g.id, g);
  const localTombstoneIds = new Set(input.localTombstoneIds);

  const payloadIds: string[] = [];
  const coveredByLocalIds: string[] = [];
  const tombstones: GroupDigestLike[] = [];

  for (const row of input.digest) {
    const id = String(row.id);

    // 墓碑：只需印记，不需 payload。
    if (row.is_deleted === true) {
      tombstones.push(row);
      continue;
    }

    const local = localById.get(id);

    // 云端有、本地没有 ⇒ 云端独有的组（另一台设备新建）⇒ 必须取回。
    if (!local) {
      payloadIds.push(id);
      continue;
    }

    // 本地只剩墓碑（D-8 形状）⇒ 云端那一行照旧取回，保持与全量下载一致。
    if (localTombstoneIds.has(id)) {
      payloadIds.push(id);
      continue;
    }

    // 印记决胜：本地赢 ⇒ 云端那份的内容会被合并丢弃 ⇒ 不必回源。
    if (localWins(local, row)) {
      coveredByLocalIds.push(id);
      continue;
    }

    // 云端赢 ⇒ 必须取回云端那份内容（否则新内容被静默丢弃）。
    payloadIds.push(id);
  }

  return { payloadIds, coveredByLocalIds, tombstones };
}

/**
 * 把「回源取回的那几行」装配成**完整的云端集合**（口径与全量下载一致）。
 *
 * ── 为什么装配成「完整集合」而不是「只有变化的那几行」──────────────────
 * 上层（引擎的合并、覆盖闸门、删除熔断、预览摘要）拿到的都叫「云端集合」，
 * 里面包含墓碑行、包含每一行的 id。若这里只给「变化的那几行」，
 * 那些**没变的**行在云端集合里就**消失了** ⇒
 *   · `validateMergeResult` 的规则 3（云端明确删除了几组）会算错；
 *   · 覆盖下载的闸门会以为云端少了很多行；
 *   · 合并里「云端有、本地无」的判定会把没变的行当成云端新增。
 * ⇒ 必须补齐。而补齐用的那份内容，就是**本地副本**（印记相同 ⇒ 合并选本地）。
 *
 * ── 顺序 ────────────────────────────────────────────────────────────────
 * 全量下载按 `created_at DESC, id DESC` 排序。装配结果按同一口径排序，
 * 这样「云端有、本地无」的那几组（唯一会受顺序影响的部分）
 * 在落盘顺序上与今天逐字一致。
 */
export function assembleCloudGroups(
  fetched: TabGroup[],
  delta: CloudDelta,
  localById: Map<string, TabGroup>
): TabGroup[] {
  const out: TabGroup[] = [];
  const seen = new Set<string>();

  const push = (g: TabGroup): void => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    out.push(g);
  };

  for (const g of fetched) push(g);

  // 「本地那份就能代表它」的行：用本地副本占位。
  for (const id of delta.coveredByLocalIds) {
    const local = localById.get(id);
    if (!local) continue;
    push({ ...local, isDeleted: false });
  }

  // 云端墓碑：用指纹合成（只需印记）。
  for (const row of delta.tombstones) {
    push(synthesizeTombstone(row));
  }

  out.sort(byCreatedAtDescThenIdDesc);
  return out;
}

/**
 * 由指纹合成一个云端墓碑行。
 *
 * 只需要「id + 印记 + 是墓碑」三样 —— mergeOpStamped 的墓碑分支
 * 只比印记，tabs/name 一律不用（墓碑从来不会以活跃身份进合并结果）。
 */
export function synthesizeTombstone(row: GroupDigestLike): TabGroup {
  const stamp = cloudStampOf(row);
  return {
    id: String(row.id),
    name: '',
    tabs: [],
    createdAt: String(row.updated_at),
    updatedAt: String(row.updated_at),
    isLocked: false,
    isDeleted: true,
    ...(stamp === EMPTY_STAMP ? {} : { lastOp: { d: stamp.d, s: stamp.s } }),
    ...(typeof row.version === 'number' ? { version: row.version } : {}),
  };
}

/** `created_at DESC, id DESC`（与全量下载的排序同一口径）。 */
function byCreatedAtDescThenIdDesc(a: TabGroup, b: TabGroup): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const va = Number.isNaN(ta) ? 0 : ta;
  const vb = Number.isNaN(tb) ? 0 : tb;
  if (va !== vb) return vb - va;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}
