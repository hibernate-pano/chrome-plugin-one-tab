/**
 * 存量实体补操作印记的统一入口（阶段二·§7）。
 *
 * 为什么单独成文件：调用方有两个，且都不能通过 mutationService 转（mutationService
 * import 了 syncEngine，反向 import 会形成循环依赖）：
 *   1. service-worker 的 runMigrations —— SW 安装/浏览器启动时跑一次
 *   2. syncEngine.downloadAndMerge —— 下载合并前的兜底（见下）
 *
 * 为什么要进单写者队列：本函数是「全量读 → 改 → 写 groups」，与用户保存并发时会用
 * 旧快照覆盖掉刚刚写入的会话（丢用户数据）。队列实现是朴素 promise 链、不可重入，
 * 所以用 getQueueDepth() 区分：已在队列内（下载/上传路径，backgroundSync 用 enqueue
 * 包裹）就串行地就地执行；队列外（SW 启动）就入队，交给单写者。
 *
 * 为什么下载合并前还要兜底一次：未盖印记的实体在合并中等于 EMPTY_STAMP（全序最小值），
 * 会静默输给任何带印记的云端行。若迁移因故没跑（SW 被消息唤醒的冷启动不触发
 * onStartup/onInstalled、当次 groups 为空、导入备份后出现旧形状数据），用户本地数据
 * 会在一次下载后无声消失。函数幂等且首次之后只读一次标志位。
 */
import { storage } from '@/utils/storage';
import { getDeviceId } from '@/utils/deviceUtils';
import { migrateOpStamps } from '@/utils/opStampMigration';
import { enqueue, getQueueDepth } from '@/background/mutationQueue';

async function runMigration(): Promise<void> {
  if (await storage.getOpStampMigrated()) return;
  const groups = await storage.getGroups();
  // 无数据时不置位标志位：此刻为空不等于以后为空（首次安装尚未水合、清数据后重新登录），
  // 提前置位会让后来出现的旧实体永远拿不到印记。
  if (groups.length === 0) return;
  const deviceId = await getDeviceId();
  const { groups: migratedGroups, migrated } = migrateOpStamps(groups, deviceId);
  if (migrated > 0) {
    await storage.setGroups(migratedGroups);
    console.log(`[OpStamp] 迁移完成: ${migrated} 个实体盖本设备印记`);
  }
  await storage.setOpStampMigrated(true);
}

export function ensureOpStampMigrated(): Promise<void> {
  // 已在队列内 → 就地执行（此刻本就读写串行，再入队会死锁）
  if (getQueueDepth() > 0) return runMigration();
  return enqueue('opStampMigration', runMigration);
}
