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
 * ── 与 SupabaseSyncPort 的关系（重要，别删错）───────────────────────────
 * 本文件**不替换** `utils/supabase/ports.ts`。两者的差别：
 *   · `SupabaseSyncPort` = Supabase 实现的**技术细节面**（读回校验、JSONB 迁移…）
 *     仍被 `utils/supabase/*` 内部与测试使用，删除会波及一大片。
 *   · `SyncBackendPort`（本文件）= SyncEngine 真正需要的**语义面**。
 * `services/tabGroupSyncService.ts` 是这两者之间的**适配器**（见
 * `src/sync-backend/resolve.ts`）。
 *
 * ── 这一版（阶段 0）只做「加接缝」，不切流量 ────────────────────────────
 * 本阶段结束时 SyncEngine 的行为必须与改造前**逐字一致**：
 * 默认解析出的后端仍是 Supabase，调用序列、错误语义、退避行为都不变。
 * 「什么时候切到 WebDAV」是后续阶段的事（settings.syncBackend）。
 */
import type { DownloadSkippedGroup, TabGroup, UserSettings } from '@/types/tab';

/** 后端标识。写进同步水位键名与设置持久化，用于「换后端 ⇒ 水位作废」。 */
export type SyncBackendId = 'supabase' | 'webdav';

/**
 * 远端一条会话的**指纹**（探活与增量选组的依据）。
 *
 * 对应 Supabase 侧的 `TabGroupDigest`，但抽掉了一切 Supabase 专有的列
 * （`version`、`is_deleted` 的列名形态、`last_op_device`/`last_op_seq`）。
 * 文件后端给不出 `version`（那是数据库的自增/触发器概念），
 * 所以它是**可选**字段而不是 required。
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
  /**
   * 本轮**补传（找回）**的会话 id —— 2026-10-20 修 P0「索引丢了被当成空库」新增。
   *
   * 非空 = 云端索引曾与实际内容脱节：这些会话被本机水位线误判成「已上传」
   * （于是被增量逻辑跳过、永远补不回去），本轮是**揪出来强制补传**的。
   *
   * 之所以要把它带出端口：这是一次**需要用户知道**的异常（不是常规增量），
   * 上层要能如实上报，而不是让修复悄悄发生、用户毫不知情。
   * 云端后端（Supabase）没有这个场景，永远不填。
   */
  recoveredIds?: string[];
  /**
   * 本轮是否**重建**过云端索引（manifest 丢失后从分片目录找回）。
   * true = 云端索引曾经丢过，本轮是恢复态；上层可据此提示用户。
   */
  indexRebuilt?: boolean;
}

/** 远端设置的读取结果。null = 远端没有设置（不是「读失败」）。 */
export type DownloadSettingsResult = Record<string, unknown> | null;

/**
 * 端口层 re-export「读不出来的那几组」的类型（2026-10-20 D-6）。
 *
 * 为什么在端口层再导出一次：这两个类型的**定义**住在 `@/types/tab`
 * （那个文件零 import ⇒ 放共享类型不会造成循环依赖），但**端口的消费者**
 * 只应该 import 端口。让他们为了描述「端口方法返回什么」而去 import
 * 一个业务类型模块，是分层泄漏。
 *
 * 注意这不是「另立一份定义」—— re-export 的是**同一个**类型
 * （`@/types/tab` 里那一份），两侧永远同形。
 */
export type { DownloadSkippedGroup, DownloadSkipReason } from '@/types/tab';

/**
 * 端口上的「读不出来的那几组」清单（2026-10-20 D-6）。
 *
 * 「这一组存在于远端，但本轮**没能把它还原成可用的会话**」。远端那一行
 * **原封保留**（不写不删）—— 不是数据丢了，是「这一轮读不到」。
 *
 * 危险的不是「读不到」，而是「读不到」在返回值里**消失**：
 * 调用方拿到的是一个「少了几组」的数组，无法区分
 * 「云端本来就只有这几组」与「云端还有几组，但这一轮读不出来」。
 *
 * 覆盖下载（forceRemote）的语义是「云端完全镜像本地」：本地整体被云端替换。
 * 读不出来的那组不在结果里 ⇒ 它也不在合并结果里 ⇒ 本机那份被物理清除，
 * 而云端那一行原封保留 —— 用户以为云端是权威源，结果**云端的数据被他自己的
 * 下载吃掉了**，UI 还报「下载成功」。1.22.0 起删除即物理清除、无回收站 ⇒ 不可逆。
 *
 * （清单的**类型**就是 `DownloadSkippedGroup[]`，见本文件上方的 re-export ——
 * 不另立别名：别名只会让人多记一个名字，形状完全一样。）
 */

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

  /**
   * 全量下载会话。失败抛错。
   *
   * ⚠️ 这个方法**只给成功还原的那些** —— 「读不出来的那几组」不在返回值里。
   * 调用方若**用下载结果替换本地**（覆盖下载），必须同时拿到
   * `downloadSkippedGroups()` 的清单，否则会把「这轮没读到」误当成「云端没有」
   * ⇒ 本机那份被物理清除，而云端那一行原封保留 ⇒
   * 用户以为云端是权威源，结果**云端的数据被他自己的下载吃掉了**，UI 还报成功。
   * 1.22.0 起删除即物理清除、无回收站、无撤销 ⇒ 这一条不可逆。
   *
   * 两条读取必须来自**同一轮**下载（不能分两次调用），因此它们由
   * `services/downloadWithSkippedGroups.ts` 一起编排。
   */
  downloadGroups(): Promise<TabGroup[]>;

  /**
   * 本轮**读不出来**而被整组跳过的会话（2026-10-20 D-6）。
   *
   * **可选能力**：不是每个后端都产生跳过。
   *   · 云端后端（Supabase）：会 —— 解密失败 / 形状不可恢复 / 还原率不达标 /
   *     tabs 表回填被截断 / 单组处理异常，那几组被整组跳过（云端行仍在）。
   *   · 自带存储（WebDAV）：**不会** —— 它是 fail-closed 的，读不出来的分片
   *     直接让整轮抛错中止（见 webdav/adapter.ts 的 downloadGroups）。
   *
   * 方法不存在 ⇒ 该后端本轮没有跳过任何会话（**这是事实，不是「不知道」**）。
   * 方法存在却抛错 ⇒ 事实未知 ⇒ 调用方必须中止（fail-closed）。
   */
  downloadSkippedGroups?(): Promise<DownloadSkippedGroup[]>;

  /** 上传一批会话（**不负责**删除广播、不负责墓碑 TTL 清理）。
   *
   *  删除广播由 `broadcastDeletes` 单独负责——两件事的失败语义不同
   *  （上传失败可以整体重试，删除广播失败必须保留队列），混在一个方法里
   *  会让「清队」与「写成功」之间出现无法原子化的缝隙。 */
  /**
   * 上传会话组。
   *
   * `opts.suppressFirstSyncFullUpload`（2026-10-18 P1#4）：
   * 调用方明确表示「本次**不是**用户已确认归属的首次全量」，请按增量处理。
   *
   * 背景：WebDAV 适配器在「远端还没有 manifest」时走 firstSync = 上传**全部**
   * 本地组（首次配置，这是对的）。但用户切到自带存储后，归属决策由设置页的
   * 三选一决定，而保存一个新会话触发的自动上传也会走进这里 —— 于是决策没做，
   * 数据却已经全量上去了。调用方通过本参数把那类「用户没点头」的上传
   * 降级为增量，避免替用户做决定。
   *
   * 只有自带存储适配器需要实现它；云端后端忽略即可（它的上传语义与
   * firstSync 无关）。选 `opts` 而不是新方法，是为了让「忘了传」在类型上
   * 仍合法、在行为上退回现状 —— 而不是让所有后端实现都被迫改签名。
   */
  uploadGroups(
    groups: TabGroup[],
    opts?: { overwriteRemote?: boolean; suppressFirstSyncFullUpload?: boolean }
  ): Promise<UploadGroupsResult>;


  /**
   * 广播删除意图（跨设备删除的唯一载体）。
   *
   * 失败**必须抛错**——吞掉它等于让已删的组在对端复活
   * （见 utils/storage.ts pendingDeleteIds 段的 fail-closed 论证）。
   *
   * ── 「广播成功」的定义（2026-10-20 D-5）：**读回确认** ─────────────────
   * 写完**不算**成功。返回（resolve）必须意味着：
   *   「远端**确实**已经是墓碑，且印记就是本次要写的那一个」——
   *   而不只是「PUT 返回了 2xx」。
   *
   * 为什么这条必须写在**端口**上（而不是各后端各自实现）：
   * 调用方（syncEngine.upload）会**照着这个定义**消费删除队列
   * （`clearPendingDeleteIds`）。若某个后端把「写完」当成成功，
   * 而服务端其实没落盘（PUT 被接受却没持久化、被同步客户端改写），
   * 那么云端那条记录仍然是活跃的 → 下次下载合并走「云端有、本地无」分支
   * → **整组在所有设备上复活**。而 1.22.0 起没有回收站，用户连「再删一次」
   * 都得先找到它在哪。
   *
   * 读回不可能时（内容读不到、连 ETag 都拿不到）**不许**当作成功：
   * 抛错，让调用方**不消费**队列，下一轮重播（重播幂等，
   * 丢掉删除意图不可逆）。
   *
   * 各后端的实现：
   *   · Supabase —— `markCloudGroupsAsDeleted` + `verifyTombstoneReadback`
   *     （utils/supabase/upload.ts、utils/supabase/readback.ts）；
   *   · 自带存储 —— `broadcastDeletes` + `verifyTombstoneReadback`
   *     （sync-backend/webdav/adapter.ts）。
   * 两侧共用同一套**判据**（core/remoteAdjudication 的
   * compareTombstoneReadback），不允许各写一份。
   */
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

