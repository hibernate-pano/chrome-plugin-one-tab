/**
 * Pure helpers for tombstone GC.
 *
 * 与 tombstoneGc.ts 分开：本文件零依赖（不 import supabase），
 * 可以在测试里独立 import 验证而不会触发 supabase 模块解析。
 */

/**
 * 计算 cutoff ISO 字符串（用于 .lt('updated_at', cutoff)）
 *
 * @param olderThanDays 多少天前
 * @param now 可选注入的"当前时间"（便于测试）
 */
export function computeCutoff(olderThanDays: number, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}
