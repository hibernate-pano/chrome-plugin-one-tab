/**
 * 增量上传的水位键（2026-10-10 F2）。
 *
 * 【它是什么】本设备**已确认写上云**的最大 stamp 序号（Lamport seq）。
 * 下次上传时，序号不大于它的组跳过（见 supabase/upload.ts 的
 * selectDirtyGroupsForUpload 与那段的完整口径论证）。
 *
 * 【为什么键名不在 storage-kv/keys.ts】完整的理由写在 STORAGE_KEYS 末尾那段
 * 注释里。三句话版本：
 *   1) 它是**可重建的推导量**，不是用户数据 —— 丢了只会多传一次；
 *   2) 它**按账号寻址**（云端数据按 user_id 隔离，本地 KV 没有这个维度），
 *      换账号时必须失效；放进全局键表会让「清除本地数据 / 迁移扫描」把它
 *      当用户数据处理，反而把一个旧账号的水位带进新账号；
 *   3) 它的三条失效纪律（读失败 → 0、写失败 → 抛错、只在读回校验通过后推进）
 *      由上传链路自己持有最清楚，键表里放一个「谁都能清」的项反而模糊责任。
 *
 * ── 2026-10-11 P0：裸整数水位会永久漏传 → 改为「按账号寻址 + 绑定 seq 基线」──
 *
 * 原实现存的是**一个裸整数**，于是有一条「漏传且永不自愈」的路径（已实证）：
 *
 *   1) 水位存到 seq=5000（该账号日常同步）；
 *   2) 用户点「清除本地数据」→ storage.clear() 按 Object.values(STORAGE_KEYS)
 *      删键，**DEVICE_SEQ 在表里被清零**，而水位**不在**表里 → 存活 5000；
 *   3) 用户新建会话 → seqRegistry.current() = max(DEVICE_SEQ=0, 观察到的印记=空)
 *      → nextSeq() 从 **1** 重启 → 新组 lastOp.s = 1；
 *   4) selectDirtyGroupsForUpload(groups, 5000) → `1 > 5000` 为假 → **跳过**；
 *   5) 新组永远不上云；下一次下载合并时云端旧行 seq 更大（LWW 云端赢）→
 *      **用户新建的会话被静默覆盖消失**，而 UI 上报的是「同步成功」。
 *
 * 本仓 v1.22.0 起无回收站、无撤销，这条路径 = 静默数据丢失。
 *
 * 【两处修法，缺一不可 —— 各自堵不同的一半】
 *   A. **按 userId 寻址**：水位键名带账号前缀。堵的是「换账号带旧水位」
 *      （账号 A 水位 5000，登出后登录账号 B，本地新建 seq=1 的组本会被 A 的
 *      水位遮蔽）。仅做 A 堵不住上面那条清数据路径 —— 同一账号清数据后
 *      水位照样是 5000，而新组 seq 照样从 1 重启。
 *   B. **绑定 seq 基线**：水位存 `{ seq, deviceSeq }`，deviceSeq 是写入水位
 *      那一刻本设备 seq 计数器的值。读取时若当前 deviceSeq < 存下的 deviceSeq，
 *      说明**seq 时钟回退了**（清数据 / KV 迁移丢键 / 被手改），旧水位的比较
 *      基准已不成立 → **弃用水位当 0**（全量上行）。这条直接堵住步骤 2→4：
 *      清数据后 DEVICE_SEQ=0 < 存下的 5000 → 水位作废。
 *
 * 【为什么「deviceSeq ≥ seq」这个自洽性方向是对的】
 * 写入水位时 deviceSeq 与 seq 来自**同一次推进**（本次上行组的 max seq 就是水位
 * 起点，deviceSeq 计数器也已取过号），正常路径下 deviceSeq ≥ seq。之后只有
 * 计数器回退（清数据 / 丢键 / 手改）才会让 deviceSeq < 存下的 deviceSeq —— 而那正是
 * 必须弃用水位的时刻。反过来（deviceSeq 变大）永远安全：只可能是有新写入，
 * 闸门判据「seq > 水位」仍然正确。
 *
 * 【失效点（穷举）】
 *   - 首次使用本版本 / 键不存在 / 值损坏 → 未设置 → 0 → 全量（正确）。
 *   - 换账号 → 键名不同 → 未设置 → 0 → 该账号首轮全量（正确）。
 *   - 清除本地数据 / DEVICE_SEQ 丢失 → seq 时钟回退 → 弃用水位 → 全量（正确）。
 *   - 覆盖上传（overwriteCloud）→ 传 0 强制全量（正确，见 upload.ts）。
 *
 * 键名按账号寻址后不再是常量，故这里是**前缀 + 构造器**；旧版写下的裸整数键
 * （LEGACY_SYNC_WATERMARK_KEY）形状与 SyncWatermark 不符 → 判为「未设置」
 * → 全量一次，随后以新格式写入（自动迁移，无需清理动作）。
 */
const SYNC_WATERMARK_PREFIX = 'supabase_sync_watermark_seq';

/** 某账号的水位键名（按 userId 寻址，隔离「换账号带旧水位」）。 */
export const syncWatermarkKey = (userId: string): string =>
  `${SYNC_WATERMARK_PREFIX}:${userId}`;

/** 旧版（未按账号寻址）的裸整数键名：形状已不匹配，只保留名字供迁移说明用。 */
export const LEGACY_SYNC_WATERMARK_KEY = SYNC_WATERMARK_PREFIX;

/**
 * 水位的值形状。
 *
 * `seq`：本设备已确认写上云的最大 stamp seq（闸门「seq > 水位则上行」的基准）。
 * `deviceSeq`：写入时本设备 seq 计数器的值 —— **seq 时钟的自洽性基线**。
 * 读取时若当前计数器低于它，说明时钟回退，水位作废（见文件头 P0 段 B）。
 */
export interface SyncWatermark {
  seq: number;
  deviceSeq: number;
}
