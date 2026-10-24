/**
 * 远端裁决的**共享判据**（2026-10-20 D-4 / D-5）。
 *
 * ── 为什么要有这一份 ──────────────────────────────────────────────────────
 * 两个后端都要回答同一个问题：「远端这一份比我新吗？我该认输吗？」
 * Supabase 侧的答案是**读云端行**（`findConcededGroupIds` → `shouldConcedeGroup`，
 * 见 utils/supabase/upload.ts）；自带存储侧曾经是**读索引**（manifest 里抄的
 * 那一行 lastOp）—— 索引是派生数据，可能与内容脱节，于是两边口径不一致，
 * 且不一致的方向正好是「用旧内容盖掉新内容」。
 *
 * 本文件把这层判据抽成纯函数，让两边**看同一个地方**：
 *   · `resolveRemoteState`：远端印记该从**内容**取还是从**索引**取（内容优先）；
 *   · `shouldConcedeToRemote`：拿到印记后，本地该不该认输。
 *
 * ⚠️ Supabase 侧**也**用这里的**墓碑判据**（`shouldConcedeGroup` 调
 *   `shouldConcedeToRemoteTombstone`，见 utils/supabase/upload.ts）——
 *   2026-10-24 审计 DS-3 之前，那边用的是自己抄的一份，而本文件头注释
 *   声称「由 tests/backendParityAdjudication.test.ts 钉住」——
 *   **那个测试文件从来不存在**（文档在教一个不存在的规则）。
 *   现在两边真的共用这里的判据，一致性由 `tests/backendParityDefects.test.ts`
 *   里的那条**真调用两个实现**的用例钉住（不是把判据重写一遍再比）。
 *
 * ⚠️ **但两边的口径并非处处相同**，差的那一处是**有意的**（2026-10-24 更正）：
 *   · **墓碑方向**（远端是墓碑、本地是活跃）⇒ 两边**完全一致**：一律认输。
 *   · **活跃 vs 活跃**（远端印记更新）⇒ 两边**不同**：
 *     Supabase 的上传预检**不拦**（服务端有 `guard_tab_group_op_stamp`
 *     按印记全序裁决，读回再判「被取代」= 收敛）；
 *     WebDAV **认输跳过**（自带存储没有服务端守卫，不拦就是拿旧内容盖掉
 *     对端的新版本 = 静默丢数据）。
 *   这个差异由 `tests/backendParityDefects.test.ts` 里那条「已知的口径差异
 *   必须被钉住」的用例显式记录 —— 不写下来的差异，下一个人会当 bug「统一」
 *   掉，而统一的方向恰好是危险的那边。
 */
import { compareStampsLoose, type OpStamp } from './opStamp';

/** 远端实体的状态（内容或索引里的都行）。 */
export interface RemoteEntityState {
  /** 操作印记（写入者 + 序号）。 */
  lastOp?: OpStamp;
  /** 是否是墓碑（已删除）。 */
  isDeleted?: boolean;
}

export interface RemoteStateInput {
  /**
   * 远端**内容**读到的状态。
   * null = 内容不存在 / 解析不了 / 解不开 —— 此时只能退回索引。
   */
  content: RemoteEntityState | null;
  /** 远端**索引**里的状态（manifest 条目、摘要行……）。 */
  index?: RemoteEntityState | null;
}

export interface RemoteState {
  /** 用于裁决的印记。 */
  lastOp?: OpStamp;
  /** 是否是墓碑。 */
  isDeleted?: boolean;
  /**
   * 印记是否来自**内容**。
   * false = 来自索引（或两边都没有）⇒ 调用方要清楚自己拿的是二手信息。
   */
  fromContent: boolean;
}

/**
 * 解析远端状态：**内容优先**。
 *
 * 索引是派生数据（可重建、可过期、可与内容脱节），内容才是真相。
 * 内容读不到时才退回索引 —— 并且如实标出 `fromContent: false`，
 * 让调用方决定要不要因此保守处理。
 */
export function resolveRemoteState(input: RemoteStateInput): RemoteState {
  const content = input.content;
  if (content) {
    return {
      ...(content.lastOp ? { lastOp: content.lastOp } : {}),
      ...(content.isDeleted === true ? { isDeleted: true } : {}),
      fromContent: true,
    };
  }
  const index = input.index ?? null;
  return {
    ...(index?.lastOp ? { lastOp: index.lastOp } : {}),
    ...(index?.isDeleted === true ? { isDeleted: true } : {}),
    fromContent: false,
  };
}

/**
 * 「远端是墓碑、本地是活跃副本」⇒ 本地**一律认输**（删除优先于编辑）。
 *
 * ── 为什么删除要压过编辑（2026-10-24 审计 DS-3，P0）─────────────────────
 * 旧语义是「比印记，谁大谁赢」。而**两台设备的印记来自各自独立的计数器**
 * （`utils/seqRegistry.ts` 的 Lamport 时钟：只保证「本设备发出的号大于它
 * 观察到的任何号」）⇒ 一台**离线**设备上的编辑，它的号与另一台设备上的删除号
 * **没有任何因果关系**，比大小等于掷硬币：
 *
 *   A 删掉会话 S（墓碑号 100）；B 离线期间编辑过 S（B 的号 101）⇒
 *   旧语义下「B 赢」⇒ 墓碑被丢弃 ⇒ **A 明确删掉的会话又回来了**，
 *   而且回来的还是 B 的版本 ⇒ A 那份内容被顶掉。
 *
 * 反过来（B 的号 99）则删除生效 ⇒ **同一件事，两种结果**，
 * 且用户完全无法预期。这就是「静默撤销删除」的根因。
 *
 * ── 删掉「编辑赢」这条路为什么没有代价（逐条查过，2026-10-24）────────────
 * ① **没有回收站**：本地删除是物理移除（`core/mutationOps.ts` 的
 *    `applyDeleteGroup` 直接 `groups.filter(...)`），`loadDeletedGroups` /
 *    `restoreGroup` / `purgeGroup` 早已删除 ⇒ 不存在「跨设备把删掉的会话恢复回来」
 *    这条需求 ⇒ 删除优先不会挡掉任何真实功能。
 * ② **导入不会撞号**：`applyImportGroups` 给导入的组发**全新 id**
 *    ⇒ 导入的会话与云端墓碑的 id 永不相同 ⇒ 不存在「用户明确要恢复一个被删的
 *    会话」被误吞的场景。
 * ③ **删除没有撤销**（1.22.0 起无回收站、无删除撤销）⇒ 不存在「本机删了又
 *    想拿回来」的本地竞争 ⇒ 同设备也不会出现「墓碑 vs 本机活跃副本」。
 *
 * ⇒ 剩下的唯一竞争就是「**别的设备**离线期间改过」⇒ 那份改动**本来就不知道
 * 那个会话已经被删了**⇒ 让删除生效是唯一不自相矛盾的选择。
 *
 * ⚠️ **显式覆盖模式不受这条约束**：用户明确选了「以本地为准」
 *   （`upload.ts` 的 `overwriteRemote` / WebDAV 的 `overwriteMode`）
 *   ⇒ 那时用户已经替这件事做了决定，不该由判据替他反悔。
 *   两个后端都在调用点显式跳过认输预检（口径一致）。
 */
export function shouldConcedeToRemoteTombstone(
  local: RemoteEntityState,
  remote: RemoteState
): boolean {
  return remote.isDeleted === true && local.isDeleted !== true;
}

/**
 * 本地该不该对远端认输（本次不上行，等下次下载合并物理替换）。
 *
 * 判据分两条，**顺序不可换**：
 *   ① 远端是墓碑而本地是活跃副本 ⇒ **认输**（删除优先于编辑，见
 *      {@link shouldConcedeToRemoteTombstone} 的完整论证）。
 *   ② 否则：**远端印记严格更新** ⇒ 认输。
 *
 * 与 `mergeOpStamped` 的**合并**语义一致（活跃 vs 活跃：stamp 大者整组赢、
 * 平局本地赢；墓碑 vs 活跃：墓碑赢）。
 *
 * ⚠️ 与 Supabase 侧的 `shouldConcedeGroup` 在**活跃 vs 活跃**上刻意不同
 *   （那边不拦，交给服务端守卫 + 读回裁决；这边拦，因为没有服务端守卫）。
 *   墓碑方向上两边**完全一致**。差在哪由
 *   `tests/backendParityDefects.test.ts` 显式钉住。
 *
 * 「无印记」按全序最小处理（`compareStampsLoose`）：远端没有印记而本地有 ⇒
 * 本地赢（本地是已知的一方）；两边都没有 ⇒ 打平，不认输。
 */
export function shouldConcedeToRemote(
  local: RemoteEntityState,
  remote: RemoteState
): boolean {
  if (shouldConcedeToRemoteTombstone(local, remote)) return true;
  return compareStampsLoose(remote.lastOp, local.lastOp) > 0;
}

/** 墓碑读回的期望值（我们要写上去的东西）。 */
export interface TombstoneExpectation {
  id: string;
  /** 期望远端带的印记。 */
  lastOp?: OpStamp;
}

/** 墓碑读回的实际值（从远端读到的）。 */
export interface TombstoneReadback {
  id: string;
  /** 远端是不是墓碑。 */
  isDeleted: boolean;
  /** 远端带的印记。 */
  lastOp?: OpStamp;
}

export interface TombstoneReadbackVerdict {
  ok: boolean;
  /** 不一致时的原因（人话，进错误信息）。 */
  reason?: string;
}

/**
 * 墓碑读回校验：**「广播成功」的定义**（自带存储侧用）。
 *
 * 只有「远端确实已经是墓碑、且印记就是我们要的那个」才算广播成功。
 * 任何不一致 ⇒ 抛错 ⇒ 调用方**不消费**删除队列 ⇒ 下一轮重播
 * （重播幂等，丢掉删除意图不可逆 —— 1.22.0 起没有回收站）。
 *
 * ── 与 Supabase 侧的差别（2026-10-24 审计更正：此前这里写错了）────────────
 * 本文件这个函数（比 **is_deleted + 印记**）是**自带存储侧**在用的那个
 * （`sync-backend/webdav/adapter.ts` 的删除广播读回）。
 * Supabase 侧有**同名但不同判据**的另一个函数
 * （`utils/supabase/readback.ts` 的 `compareTombstoneReadback(ids, rows, opts)`），
 * 它只比 **is_deleted**、并把「云端没这一行」按调用方的语义处理
 * （默认报错，plain 模式可显式当成「删除意图已达成」）。
 *
 * ⚠️ 此前本注释写的是「Supabase 侧…比对 is_deleted **与印记**…两边的判据在这里」
 * —— **那是假的**：Supabase 侧读回时只 select 了 `id, is_deleted`
 * （`readback.ts` 的 `verifyTombstoneReadback`），**根本没有印记这一维**。
 *
 * 两边口径不同是**有意的**，不是漂移：
 *   · 自带存储侧要确认「写进去的**就是**我这一条墓碑」⇒ 必须比印记
 *     （它的分片头里就带着印记，比对成本为零）。
 *   · Supabase 侧要确认的是「**这个会话确实被删掉了**」⇒ `is_deleted` 足够；
 *     而且**不能**要求印记等于我的：别的设备写下的更新墓碑同样满足删除意图
 *     （那不是失败，是收敛）⇒ 要求印记相等反而会把删除意图判成故障、无限重播。
 * ⇒ 改动任何一边之前，先确认它的「广播成功」定义是什么。
 */
export function compareTombstoneReadback(
  expected: TombstoneExpectation,
  actual: TombstoneReadback
): TombstoneReadbackVerdict {
  if (!actual.isDeleted) {
    return { ok: false, reason: `会话 ${expected.id} 读回不是墓碑（删除没有落盘）` };
  }
  if (expected.lastOp) {
    const got = actual.lastOp;
    if (!got) {
      return { ok: false, reason: `会话 ${expected.id} 读回没有印记（期望 ${expected.lastOp.d},${expected.lastOp.s}）` };
    }
    if (got.d !== expected.lastOp.d || got.s !== expected.lastOp.s) {
      return {
        ok: false,
        reason: `会话 ${expected.id} 读回印记(${got.d},${got.s}) 与期望(${expected.lastOp.d},${expected.lastOp.s})不一致`,
      };
    }
  }
  return { ok: true };
}
