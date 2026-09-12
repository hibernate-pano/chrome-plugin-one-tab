/**
 * 阶段二存量数据迁移（规格 §7）：所有未带 stamp 的实体盖本设备印记；幂等。
 *
 * 入口：SW 启动时调用 ensureOpStampMigrated（service-worker runMigrations 内挂载）。
 * 幂等：已带 lastOp 的实体跳过（靠 OP_STAMP_MIGRATED 标志位短路整次迁移）。
 * 已墓碑的实体保留 isDeleted，只补印记。
 *
 * 为什么盖「本设备 id」而不是 'legacy' 这种统一假设备：
 * 1. 收敛性：相同内容的旧数据在两台设备上会得到完全相同的 stamp，
 *    合并时平分（pickByStamp 平局取本地）→ 两台设备各自保留自己的副本，永不收敛。
 *    换成各自的设备 id 后，平局由设备 id 字典序决定性分出胜者。
 * 2. 平局序：'legacy' 与 uuid 比字典序时 'l' > 'f'（uuid 只含 0-9a-f），
 *    假设备反而会赢过真实设备，与「未升级数据应输给新印记」的意图相反。
 * 3. 归属诚实：印记代表「某台设备声称此实体处于此状态」，没有设备叫 legacy。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { makeStamp } from '@/utils/opStamp';

export interface MigrationResult {
  groups: TabGroup[];
  migrated: number;
}

export function migrateOpStamps(groups: TabGroup[], deviceId: string): MigrationResult {
  let migrated = 0;
  const out: TabGroup[] = groups.map(g => {
    const newGroup = { ...g };
    if (!newGroup.lastOp) {
      newGroup.lastOp = makeStamp(deviceId, newGroup.version || 1);
      migrated++;
    }
    newGroup.tabs = newGroup.tabs.map((t: Tab) => {
      const nt = { ...t };
      if (!nt.lastOp) {
        // tab 上没有 version 概念，统一用组 version 作序（保证同一次迁移的 tab 印记
        // 不会比组印记更“新”，避免后续 tab 级操作反过来输给迁移值）
        nt.lastOp = makeStamp(deviceId, newGroup.version || 1);
        migrated++;
      }
      return nt;
    });
    return newGroup;
  });
  return { groups: out, migrated };
}