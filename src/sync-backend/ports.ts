/**
 * 后端无关的同步端口（2026-10-13，WebDAV 自带存储改造 · 阶段 0）。
 *
 * ── 为什么要有这一层（背景见 docs/webdav-selfhost-sync-plan.md §3）────────
 * 1.22.x 的 S3 拆分已经做了 `SupabaseSyncPort`，但那个接口的 8 个方法是
 * **按 Supabase 的能力设计的**：
 *   · `uploadTabGroups` 返回 `{ result, writtenTombstoneIds }`（读回校验的副产物）
 *   · `purgeExpiredCloudTombstones(maxAgeDays)` 依赖「云端行」这个概念
 *   · `migrateToJsonb()` 是 Supabase 专属的历史迁移，与同步语义无关
 * 文件后端没有「行」，把这些方法硬塞进去会得到一个处处是 `if (isSupabase)`
 * 的假抽象。因此这里定义**后端无关的最小面**，各后端各自实现，
 * SyncEngine 只认这个面。
 *
 * ── 与 SupabaseSyncPort 的关系（2026-10-16：该层已随之删除）────────────
 * 本文件当年**不替换** `utils/supabase/ports.ts`：后者是 Supabase 实现的
 * 技术细节面，而 `SyncBackendPort`（本文件）是 SyncEngine 真正需要的语义面。
 * 2026-10-16 Supabase 后端整体下线，两者同批删除，本文件成为唯一端口面。
 *
 * ── 这一版只定义端口，流量只有自带存储一种（2026-10-16）───────────────
 * WebDAV 自带存储是唯一后端：`SyncBackendId` 已收窄为 `'webdav'`，
 * 不再存在「按设置在两个后端之间选」的分支。保留这一层的原因不变：
 * SyncEngine 只认语义面，将来接入新后端仍然从这里长。
 */
import type { TabGroup, UserSettings } from '@/types/tab';

/** 后端标识。写进同步水位键名与设置持久化，用于「换后端 ⇒ 水位作废」。
 *
 *  2026-10-16：TapStack 云端（Supabase）下线后只剩自带存储一种，
 *  所以这里的联合类型收窄为单成员。保留 type 而不是直接写 `'webdav'`，
 *  是为了让「后端 id」在代码里仍然是一个具名概念。 */
export type SyncBackendId = 'webdav';

/**
 * 远端一条会话的**指纹**（探活与增量选组的依据）。
 *
 * 对应 Supabase 侧的 `TabGroupDigest`，但抽掉了一切 Supabase 专有的列
 * （`version`、`is_deleted` 的列名形态、`last_op_device`/`last_op_seq`）。
 */
export interface RemoteGroupFingerprint {
  id: string;
  /**
   * 远端实体的最后修改时刻（ISO）。**必填。**
   *
   * 消费方 `hasRemoteChanges` 用它与本地 `updatedAt` 比对
   * （syncDecision.ts:157-162），而该函数拿不到有效时间戳时会退化成
   * 「字符串不等 ⇒ 有变更」——即每次探活都判有变更，up_to_date 短路永久失效。
   * 那是 fail-safe（多走一次全量，不丢数据），但会让「省掉一次全量下载」
   * 这个探活的**全部价值**归零。两个后端都必须能给出它：
   * Supabase 有 updated_at 列；WebDAV 把它写进 manifest.json（§4.1 布局）。
   */
  updatedAt: string;
  /**
   * 后端原生的**不透明**版本标识（WebDAV = ETag 原始字符串，含引号）。
   * 只由适配器自己用于乐观锁（If-Match）与「远端是否变过」的快速判定，
   * 不做跨后端解释，也不参与 mergeOpStamped 的仲裁。
   */
  etag?: string;
  /**
   * Supabase 独有的单调版本号（数据库触发器维护；v1.22 起已冻结为兼容字段）。
   *
   * ── 为什么它与 etag 是两个独立字段 ────────────────────────────────────
   * 2026-10-13 阶段 0 初稿曾把 Supabase 的 version 转成字符串塞进 `etag`，
   * 再在接缝处 `Number(etag)` 还原。**那是错的**：ETag 是不透明字符串
   * （形如 `"a1b2c3"`），`Number('a1b2c3')` 得到 NaN，而消费方用它做
   * `(row.version ?? 1) !== (local.version ?? 1)` 的强判定
   * （syncDecision.ts:163）。NaN 会让该判定恒为「有变更」；更糟的情形是
   * 两个不同的 ETag 恰好转成同一个数字，被判成「没变」而**漏掉真实变更**。
   * 合并两个语义不同的字段，就是在制造这种「看起来省事」的静默失真。
   */
  version?: number | null;
  /** 删除广播载体是否处于「已删除」状态。 */
  isDeleted?: boolean;
  /** 操作印记（写入者）。缺失视为全序最小值，与 mergeOpStamped 的约定一致。 */
  lastOp?: { d: string; s: number };
}

/** 上传一批会话的结果。
 *
 * `writtenIds` 是**本轮确实写上远端**的 id 集合（不是「打算写的」）：
 * 删除广播的清队必须用它点名，否则一轮上传期间新登记的删除意图会被连坐清掉。
 * 这一点在 Supabase 侧叫 `writtenTombstoneIds`，此处扩成全部已写 id。
 */
export interface UploadGroupsResult {
  /** 本次真正写上远端的会话 id。 */
  writtenIds: string[];
  /** 覆盖模式是否真的执行了（false = 因本地无活跃组而跳过）。 */
  overwroteRemote?: boolean;
}

/** 远端设置的读取结果。null = 远端没有设置（不是「读失败」）。 */
export type DownloadSettingsResult = Record<string, unknown> | null;

/**
 * 同步后端的最小语义面 —— SyncEngine 依赖的全部能力。
 *
 * 设计约束：**每个方法名的语义都与后端无关**。不允许出现
 * `upsertRow` / `listFiles` / `jsonb` 这类泄漏实现细节的名字。
 */
export interface SyncBackendPort {
  readonly id: SyncBackendId;
  /** 展示名（UI 用）。 */
  readonly label: string;

  /** 探活：只拉指纹，不拉会话内容。用于「远端有没有变」的短路判断。
   *  失败必须抛错（调用方据此决定是否降级走全量），不得静默返回 []。 */
  fetchFingerprints(): Promise<RemoteGroupFingerprint[]>;

  /** 全量下载会话。失败抛错。 */
  downloadGroups(): Promise<TabGroup[]>;

  /** 上传一批会话（**不负责**删除广播、不负责墓碑 TTL 清理）。
   *
   *  删除广播由 `broadcastDeletes` 单独负责——两件事的失败语义不同
   *  （上传失败可以整体重试，删除广播失败必须保留队列），混在一个方法里
   *  会让「清队」与「写成功」之间出现无法原子化的缝隙。 */
  uploadGroups(groups: TabGroup[], opts?: { overwriteRemote?: boolean }): Promise<UploadGroupsResult>;

  /** 广播删除意图（跨设备删除的唯一载体）。
   *  失败**必须抛错**——吞掉它等于让已删的组在对端复活
   *  （见 utils/storage.ts pendingDeleteIds 段的 fail-closed 论证）。 */
  broadcastDeletes(ids: string[]): Promise<void>;

  /** 物理清理超过龄期的删除广播载体。失败抛错（调用方降级为下轮重试）。 */
  purgeExpiredDeletes(maxAgeDays?: number): Promise<number>;

  uploadSettings(settings: UserSettings): Promise<void>;
  downloadSettings(): Promise<DownloadSettingsResult>;
}

/**
 * ── 为什么端口上**没有**「增量水位」相关方法 ─────────────────────────────
 *
 * 「本设备已确认写上远端的最大 stamp 序号」（水位）是**每个后端自己的内部状态**，
 * 不是 SyncEngine 需要知道的东西：
 *   · Supabase 侧它由 upload.ts 内部持有（loadSyncWatermark / saveSyncWatermark，
 *     且绑定了 deviceSeq 基线防「清数据后 seq 时钟回退」——见 syncWatermark.ts
 *     的完整论证与 syncWatermarkClockRegression 测试）。
 *   · WebDAV 侧由 WebDAV 适配器自己持有（键名按后端标识寻址，换后端自动失效）。
 *
 * 所以「哪些组是脏的、要不要走增量」是**适配器内部的策略**，
 * 不进接口。这不是为了少写两个方法，而是因为：
 * 一旦把它提到端口上，SyncEngine 就必须理解水位的语义，
 * 那时两个后端的水位键格式、失效规则、时钟回退保护就得在 Engine 里分支 ——
 * 那正是本阶段要消灭的东西。
 *
 * 【2026-10-13 阶段 0 的一处修正记录】初稿这里写过
 * `getSyncState()` / `saveSyncState()`，并在 Supabase 适配器里实现为
 * 「返回 {0, null} / no-op」。那是**假实现**：它让接口看起来完整，
 * 实际调用方拿到的永远是「从未同步过」，会静默把增量降级成全量，
 * 或者更糟——让上层以为水位已推进。**已删除，不留占位。**
 */

