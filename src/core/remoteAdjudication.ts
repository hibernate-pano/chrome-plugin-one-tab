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
 * ⚠️ Supabase 侧的实现（utils/supabase/upload.ts、utils/supabase/readback.ts）
 * 按本次任务约束**不得改动**，因此它暂时仍用自己的那一份；
 * 两边的一致性由 tests/backendParityAdjudication.test.ts 钉住
 * （同一批输入必须给出同一结论）—— 漂移会让那条测试变红。
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
 * 本地该不该对远端认输（本次不上行，等下次下载合并物理替换）。
 *
 * 判据：**远端印记严格更新** ⇒ 认输。
 * 与 `mergeOpStamped` 的组级 LWW 逐字一致（stamp 大者整组赢）。
 *
 * 「无印记」按全序最小处理（`compareStampsLoose`）：远端没有印记而本地有 ⇒
 * 本地赢（本地是已知的一方）；两边都没有 ⇒ 打平，不认输。
 */
export function shouldConcedeToRemote(
  localLastOp: OpStamp | undefined,
  remote: RemoteState
): boolean {
  return compareStampsLoose(remote.lastOp, localLastOp) > 0;
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
 * 墓碑读回校验：**「广播成功」的定义**。
 *
 * 只有「远端确实已经是墓碑、且印记就是我们要的那个」才算广播成功。
 * 任何不一致 ⇒ 抛错 ⇒ 调用方**不消费**删除队列 ⇒ 下一轮重播
 * （重播幂等，丢掉删除意图不可逆 —— 1.22.0 起没有回收站）。
 *
 * ── 与 Supabase 侧的等价关系 ──────────────────────────────────────────────
 * Supabase 侧做同一件事的是 `verifyTombstoneReadback`
 * （utils/supabase/readback.ts）：比对 `is_deleted` 与印记，不一致就抛错。
 * 两边的**判据**在这里（`compareTombstoneReadback`），
 * Supabase 那份按任务约束未改动，一致性由 parity 测试钉住。
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
