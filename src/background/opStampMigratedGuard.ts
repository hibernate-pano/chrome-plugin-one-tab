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
 * 所以由调用方**显式声明**自己是否已在队列内：
 *   - 已在队列内（下载/上传路径，backgroundSync 用 enqueue 包裹）→ 就地串行执行；
 *     此刻本就读写串行，再入队会死锁。
 *   - 队列外（SW 启动的 runMigrations）→ 入队，交给单写者。
 *
 * 【为什么不能用 getQueueDepth() 猜 —— 2026-10-07 专家团体检 P0-4】
 * 旧判据是 `if (getQueueDepth() > 0) return runMigration()`。但 getQueueDepth()
 * 返回的是**整个队列**的深度，不区分「我是不是这个 job 的一部分」。于是 SW 冷启动
 * 调 runMigrations() 时，若恰好有别的 job 在跑（60s 的 backgroundSync alarm 刚
 * enqueue 了 sync:download，或 alarm 驱动的延迟上传），判据就成立 → runMigration
 * **在队列外直接执行**全量读-改-写 groups，与那条 sync:download 的 setGroupsImmediate
 * 交错 —— 违反 mutationQueue 声明的单写者不变量，后写的赢，而被覆盖的一方**已经
 * 报成功给用户了**。v1.22.0 起无回收站，这条路径丢的组用户找不回来。
 * 926 个测试全都躲过了它：要复现需构造「队列里有别人的活 + 同时触发 onInstalled」。
 *
 * 两个调用点都知道自己在哪：syncEngine.downloadAndMerge（自己在 sync:download 这个
 * job 内）传 true；service-worker 的 runMigrations（队列外）传 false。显式参数没有
 * 猜测空间，这才是能长期守住的不变量。
 *
 * 为什么下载合并前还要兜底一次：未盖印记的实体在合并中等于 EMPTY_STAMP（全序最小值），
 * 会静默输给任何带印记的云端行。若迁移因故没跑（SW 被消息唤醒的冷启动不触发
 * onStartup/onInstalled、当次 groups 为空、导入备份后出现旧形状数据），用户本地数据
 * 会在一次下载后无声消失。函数幂等且首次之后只读一次标志位。
 */
import { storage } from '@/utils/storage';
import { getDeviceId } from '@/utils/deviceUtils';
import { migrateOpStamps } from '@/utils/opStampMigration';
import { enqueue } from '@/background/mutationQueue';
import { logInfo } from '../utils/log';

async function runMigration(): Promise<void> {
  if (await storage.getOpStampMigrated()) return;
  const groups = await storage.getGroupsForWrite();
  // 无数据时不置位标志位：此刻为空不等于以后为空（首次安装尚未水合、清数据后重新登录），
  // 提前置位会让后来出现的旧实体永远拿不到印记。
  if (groups.length === 0) return;
  const deviceId = await getDeviceId();
  const { groups: migratedGroups, migrated } = migrateOpStamps(groups, deviceId);
  if (migrated > 0) {
    // 直写而非防抖版 setGroups：本函数是全量读-改-写，走防抖会在 500ms 窗口内
    // 被 MV3 回收 —— storage.ts:236-245 正是为那个场景准备了 setGroupsImmediate。
    // 改完这处后，生产代码里 setGroups（防抖版）已无调用方。
    await storage.setGroupsImmediate(migratedGroups);
    logInfo(`[OpStamp] 迁移完成: ${migrated} 个实体盖本设备印记`);
  }
  await storage.setOpStampMigrated(true);
}

/**
 * @param inQueue 调用方是否已经处于单写者队列的某个 job 内。
 *   true  → 就地串行执行（再入队会死锁）
 *   false → 入队执行（队列外，交给单写者）
 */
export function ensureOpStampMigrated(inQueue: boolean): Promise<void> {
  if (inQueue) return runMigration();
  return enqueue('opStampMigration', runMigration);
}
