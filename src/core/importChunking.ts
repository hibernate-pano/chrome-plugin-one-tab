/**
 * 导入的分块与去重（纯函数，无 IO）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────────
 *
 * 导入的载荷要跨进程走一趟：`chrome.runtime.sendMessage` 的消息体有**上限**
 * （Chromium 实现细节，约 64MiB；**不是**公开 API 契约，所以本仓不把它当契约用，
 * 只当「不能无限大」这件事的现实约束）。原先整个文件的所有会话组**塞进一条
 * 消息**：文件一大，要么消息发不出去（用户看到一句看不懂的失败），
 * 要么 SW 处理一整条巨型消息时超过 30s 的等待窗口（用户看到「导入失败」，
 * 而命令其实已经被受理、后台还在跑）。
 *
 * ⇒ 分块：把 N 个组切成若干条**小消息**，每条都走**同一条**单写者队列，
 *   语义与一条大消息完全一致（每块都是「读真值 → 合并 → 盖印记 → 写盘」）。
 *
 * ── 分块带来的唯一语义变化：跨块判重 ──────────────────────────────────────
 *
 * `applyImportGroups` 判重时比对的是**文件原样的指纹**（组名 + URL 集合），
 * 而**已落盘**的组的指纹是**清洗后**的（危险协议被剔除、标签 id 换新）。
 * 同一批里，第二个重复组是拿「文件指纹」和「本批第一个的文件指纹」比 ⇒ 判中；
 * 分块后，第二个重复组（若落在后一块）是拿「文件指纹」和「已落盘的清洗后指纹」比
 * ⇒ **可能判不中** ⇒ 造出一份副本。
 *
 * ⇒ 修法：**分块之前**先按文件指纹去重（与 `applyImportGroups` 同一口径），
 *   被去掉的计入 `skippedExisting` —— 计数与不分块时完全一致。
 *   （这是「跨块也要幂等」的前置条件，不是优化。）
 */

import type { TabGroup } from '../types/tab';
import { groupContentFingerprint } from './normalizeTabsData';

/** 判重只需要「组名 + 标签」两样（与 groupContentFingerprint 的入参一致）。 */
export type FingerprintableGroup = Pick<TabGroup, 'name' | 'tabs'>;

/**
 * 一条 `importGroups` 消息里最多带多少个会话组。
 *
 * 取 500 的理由：
 *   · 一条消息的体量随之被压到「几百 KB ~ 几 MB」量级 ⇒ SW 处理单块是**亚秒级**
 *     ⇒ 不会撞上 30s 的等待窗口（原先整批一条消息时，大文件必撞）。
 *   · 块数不会多到「发消息本身成为瓶颈」：十万个会话 = 200 块。
 */
export const IMPORT_CHUNK_GROUPS = 500;

/**
 * 把会话组切成若干块（每块最多 `size` 个）。
 * 空数组返回空数组（调用方据此不必发任何消息）。
 *
 * 泛型保留调用方的具体类型（生产上是 TabGroup，测试里是朴素对象）。
 */
export function chunkGroups<T extends FingerprintableGroup>(
  groups: T[],
  size: number = IMPORT_CHUNK_GROUPS
): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < groups.length; i += step) {
    chunks.push(groups.slice(i, i + step));
  }
  return chunks;
}

/** 按文件指纹去重的结果。 */
export interface DedupeResult<T> {
  /** 保留下来的组（保持文件原顺序，同指纹的**第一个**留下）。 */
  groups: T[];
  /** 被去掉的重复组数量（文件里同一个会话出现了多次）。 */
  duplicates: number;
}

/**
 * 按**文件指纹**（组名 + URL 集合）去重，保留首次出现的那个。
 *
 * 与 `applyImportGroups` 的判重口径**完全一致**（同一个 `groupContentFingerprint`）
 * —— 口径不一致 = 「导入两次不造副本」这条承诺在分块后失效。
 */
export function dedupeByFileFingerprint<T extends FingerprintableGroup>(
  groups: T[]
): DedupeResult<T> {
  const seen = new Set<string>();
  const kept: T[] = [];
  let duplicates = 0;
  for (const group of groups) {
    const fp = groupContentFingerprint(group);
    if (seen.has(fp)) {
      duplicates += 1;
      continue;
    }
    seen.add(fp);
    kept.push(group);
  }
  return { groups: kept, duplicates };
}
