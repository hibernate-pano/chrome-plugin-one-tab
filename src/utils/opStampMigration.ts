/**
 * 阶段二存量数据迁移（规格 §7）：所有未带 stamp 的实体盖 legacy 印记；
 * 本设备 seq 由 seqRegistry 自动修复为 max+1000。幂等。
 *
 * 入口：SW 启动时调用 ensureOpStampMigrated（mutationService 内挂载）。
 * 幂等：已带 stamp 且 d !== 'legacy' 的实体跳过；已墓碑的实体保留 isDeleted + 盖 legacy stamp。
 */
import type { TabGroup, Tab } from '@/types/tab';
import { makeStamp } from '@/utils/opStamp';

export interface MigrationResult {
  groups: TabGroup[];
  migrated: number;
}

export function migrateOpStamps(groups: TabGroup[]): MigrationResult {
  let migrated = 0;
  const out: TabGroup[] = groups.map(g => {
    const newGroup = { ...g };
    if (!newGroup.lastOp) {
      newGroup.lastOp = makeStamp('legacy', newGroup.version || 1);
      migrated++;
    }
    newGroup.tabs = newGroup.tabs.map((t: Tab) => {
      const nt = { ...t };
      if (!nt.lastOp) {
        // tab 上的 version 不存在；以 createdAt 哈希或 1 兜底
        nt.lastOp = makeStamp('legacy', 1);
        migrated++;
      }
      return nt;
    });
    return newGroup;
  });
  return { groups: out, migrated };
}