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