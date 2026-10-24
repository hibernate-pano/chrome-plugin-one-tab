/**
 * 组级 LWW（Last-Writer-Wins）合并纯函数：输入本地/云端两组快照，输出合并结果。
 *
 * ── 2026-09-29 合并语义重写：整组覆盖（无墓碑，产品拍板）──
 *
 * 旧模型：组字段按 stamp 决胜 + tabs 按 id 并集 + tab 级 stamp 决胜 + URL 去重
 * 败者盖墓碑（mergeStamp）。墓碑体系废除后，tab 级并集失去删除意图载体——
 * 并集会把任一端物理删除的 tab 当作「另一端新增」复活。
 *
 * 新模型：**组是合并的最小单位，整组覆盖**。
 * - 两端都有该组 → 组 stamp（lastOp）大者整组赢：tabs/name/lock/version 全跟赢家。
 *   tab 的增删改都通过「组 stamp 提升 + 整组行上传」广播，无 tab 级合并。
 * - 仅云端有 → 活跃组收入；is_deleted=true（删除广播行）不收入。
 * - 仅本地有 → 保留本地。
 * - 云端墓碑 vs 本地活跃 → **云端墓碑一律赢**（本地副本被物理移除）。
 *   2026-10-24 审计 DS-3 之前这里是「stamp 决胜」—— 两台设备的印记来自**各自
 *   独立的计数器**，离线设备的编辑号与删除号之间**没有因果关系**，比大小等于
 *   掷硬币 ⇒ 删除被静默撤销。论证与影响面见下方分支注释。
 * - 本地墓碑（老版本写入的残留形状）调用方须在合并前过滤，本函数不感知。
 *
 * 代价（已在方案拍板时确认）：两台设备**同时**编辑同一个会话，**整组**由印记
 * 决胜（序号大者赢，序号相同则按设备编号字典序），败方的新增标签丢失。
 *
 * ⚠️ **不是「后保存方赢」**（2026-10-23 审计 DS-43-18 更正）：两台设备的序号
 * 来自**各自独立**的计数器（seqRegistry 只保证本机单调 + 观察到的全网最大值），
 * 跨设备裸比数值并不代表真实先后 ⇒ **先保存的那台完全可能赢**。
 * 文档曾长期写「以最后保存的一方为准」（README / 商店文案 / 本文件头），
 * 那是在教一个**不成立的预期** —— 用户据此以为「我后保存的就赢」，而实际不是。
 * ⇒ 文案一律按「印记决胜」表述，见 README「整组覆盖」与商店文案「Known Issues」。
 *
 * stamp 缺失视为全序最小值（EMPTY_STAMP），保证迁移前数据输给任何带 stamp 的实体。
 * 合并不产生新实体、不铸新 stamp——mergedStamp/URL 去重概念随墓碑一并废除。
 */
import type { TabGroup } from '../types/tab';
import { compareStamps, EMPTY_STAMP } from './opStamp';

function pickByStamp(a: TabGroup, b: TabGroup): TabGroup {
  const sa = a.lastOp ?? EMPTY_STAMP;
  const sb = b.lastOp ?? EMPTY_STAMP;
  return compareStamps(sa, sb) >= 0 ? a : b;
}

export function mergeOpStamped(local: TabGroup[], cloud: TabGroup[]): TabGroup[] {
  const byId = new Map<string, { local?: TabGroup; cloud?: TabGroup }>();
  for (const g of local) byId.set(g.id, { ...(byId.get(g.id) || {}), local: g });
  for (const g of cloud) byId.set(g.id, { ...(byId.get(g.id) || {}), cloud: g });

  const merged: TabGroup[] = [];
  for (const [, sides] of byId) {
    const { local: lg, cloud: cg } = sides;
    if (lg && !cg) { merged.push(lg); continue; }
    if (cg && !lg) {
      // 云端墓碑行且本地无副本：删除广播的终点，不收入（行本身永不入库）
      if (cg.isDeleted) continue;
      merged.push(cg);
      continue;
    }
    // 两端都有
    if (cg!.isDeleted) {
      // ── 2026-10-24 审计 DS-3（P0）：**云端墓碑一律赢** ──────────────────
      //
      // 旧语义是「比印记，谁大谁赢」（`pickByStamp`）。而两台设备的印记来自
      // **各自独立的计数器**（`utils/seqRegistry.ts` 的 Lamport 时钟只保证
      // 「本设备发出的号 > 它观察到的任何号」）⇒ 一台**离线**设备上的编辑，
      // 它的号与另一台设备上的删除号**没有任何因果关系** ⇒ 比大小等于掷硬币：
      //
      //   A 删掉会话 S（墓碑号 100）；B 离线期间编辑过 S（B 的号 101）⇒
      //   旧语义「B 赢」⇒ 墓碑被丢弃 ⇒ **A 明确删掉的会话又回来了**，
      //   而且回来的还是 B 的版本（A 那份内容被顶掉）。
      //   B 的号若是 99 则删除生效 ⇒ **同一件事两种结果**，用户无法预期。
      //
      // ⇒ 现在墓碑无条件赢：本地活跃副本被**物理移除**（删除跨设备传播）。
      //
      // 为什么这条不会误伤「用户明确要恢复一个被删的会话」：
      //   ① 本地删除是**物理移除**，1.22.0 起**没有回收站**，
      //      `loadDeletedGroups` / `restoreGroup` / `purgeGroup` 早已删除
      //      ⇒ 不存在「跨设备恢复被删会话」这条功能；
      //   ② `applyImportGroups` 给导入的组发**全新 id** ⇒ 导入的会话与云端
      //      墓碑的 id 永不相同 ⇒ 不会被墓碑误吞；
      //   ③ 删除没有撤销 ⇒ 同设备也不会出现「墓碑 vs 本机活跃副本」。
      // 剩下唯一的竞争就是「别的设备离线期间改过」⇒ 那份改动本来就知道不了
      // 那个会话已经被删 ⇒ 让删除生效是唯一不自相矛盾的选择。
      //
      // ⚠️ 显式覆盖模式（用户选了「以本地为准」）不走这里 —— 那条路径由
      //   上游的 overwrite 闸门处理（本地组先置空），判据不参与。
      continue;
    }
    // 活跃 vs 活跃：整组覆盖，赢家通吃
    merged.push(pickByStamp(lg!, cg!));
  }
  return merged;
}
