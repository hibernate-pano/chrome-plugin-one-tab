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
 * - 云端墓碑 vs 本地活跃 → stamp 决胜：云端新 → 本地组服从删除（物理移除）；
 *   本地新（离线期间的未同步修改）→ 本地保留，下次上传覆盖云端墓碑。
 * - 本地墓碑（老版本写入的残留形状）调用方须在合并前过滤，本函数不感知。
 *
 * 代价（已在方案拍板时确认）：两台设备**同时**编辑同一个会话，后保存方整组赢，
 * 先保存方的新增标签丢失。错峰使用完全无损。
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
      // 云端删除广播 vs 本地活跃副本：stamp 决胜。
      // 云端新 → 删除生效（本地物理移除）；本地新（离线修改未上传）→ 本地赢，
      // 下次上传整组覆盖云端墓碑（删除被本地更新撤销，与旧模型语义一致）。
      if (pickByStamp(lg!, cg!) === lg) merged.push(lg!);
      continue;
    }
    // 活跃 vs 活跃：整组覆盖，赢家通吃
    merged.push(pickByStamp(lg!, cg!));
  }
  return merged;
}
