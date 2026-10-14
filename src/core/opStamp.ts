/**
 * 操作印记（规格 §4）：实体（TabGroup/Tab）携带 { d, s }，合并时按全序决胜，
 * 任何带印记的实体对必出唯一赢家。EMPTY_STAMP 全序最小值，用于迁移前/云端空列。
 */
export interface OpStamp { d: string; s: number }

export const EMPTY_STAMP: OpStamp = { d: '', s: 0 };

export function makeStamp(deviceId: string, seq: number): OpStamp {
  return { d: deviceId, s: seq };
}

/**
 * 全序比较（规格 §4.2）：
 *   s 不同 → 数值比较
 *   s 相同 → d 字符串字典序比较
 *   完全相等 → 0
 *
 * 无 updatedAt / id 兜底：任一带印记实体对必唯一赢家，避免「同一设备同一序号盖
 * 多个实体」的 race 必须借助时间戳二次判定——seq 单调递增保证这一点。
 */
export function compareStamps(a: OpStamp, b: OpStamp): -1 | 0 | 1 {
  if (a.s !== b.s) return a.s > b.s ? 1 : -1;
  if (a.d !== b.d) return a.d > b.d ? 1 : -1;
  return 0;
}

export function isLater(a: OpStamp, b: OpStamp): boolean {
  return compareStamps(a, b) > 0;
}

/**
 * 比较「可能没有印记」的两个实体（2026-10-14 收口双实现）。
 *
 * ── 为什么要另立一个，而不是让调用方自己兜 undefined ─────────────────────
 * WebDAV 适配器曾自带一份compareStamps 副本，把无印记当作 `s:-Infinity`，
 * 并在注释里声称「与 core/opStamp 同口径」—— 其实**不同口径**：
 * 本文件的 `EMPTY_STAMP` 是 `{d:'', s:0}`，而 `s:-Infinity`比它更小。
 * 两份实现讲同一件事、口径却不一致，是典型的「改一处忘另一处」隐患，
 * 故统一到这里。
 *
 * ── 为什么保留 `-Infinity` 而不是改用 EMPTY_STAMP ───────────────────────
 * `-Infinity` 让「无印记」严格小于**任何**真实印记（含seq=0 的第一份），
 * 方向上更保守：远端有印记而本地没有时判远端赢 ⇒ 本地认输，
 * 不会用「状态未知的本地副本」覆盖远端。EMPTY_STAMP（s:0）与 seq=0
 * 相比则是「相等」，会走进「本地赢」的分支去覆写远端 —— 对「不知道」
 * 的状态而言那是**危险的方向**。
 *
 * 因此本函数与 `compareStamps` 的差异是有意保留的，不是 bug。
 */
export function compareStampsLoose(
  a: OpStamp | undefined,
  b: OpStamp | undefined
): -1 | 0 | 1 {
  const MISSING: OpStamp = { d: '', s: -Infinity };
  const sa = a ?? MISSING;
  const sb = b ?? MISSING;
  const r = compareStamps(sa, sb);
  return r;
}