/**
 * WebDAV 后端适配器（2026-10-13，阶段 1 的最后一块）。
 *
 * 把传输层 / 加密 / 熔断 / 布局编排成 `SyncBackendPort` 的实现。
 * 这是本次改造里**最容易出数据安全问题**的一块，因此文件里每个不显然的
 * 决定都写了理由，改动前请先读完整段。
 *
 * ── 三条贯穿全文件的纪律 ────────────────────────────────────────────────
 * 1. **「不可用」绝不等于「空」**。manifest 读不到（404）= 远端确实还没建库，
 *    返回空是事实；manifest 解析失败 = 数据坏了，**必须抛错**。
 *    把后者当空库会让云端「看起来被清空」→ 合并清空本地 → 无回收站不可逆。
 * 2. **乐观锁失败（412）不降级为无条件覆盖**。按分片做组级 LWW 裁决：
 *    本地 stamp 更新 → 用新 ETag 重试；远端更新 → 认输跳过（等下次下载合并）。
 *    这与 Supabase 侧的 `findConcededGroupIds` 认输预检是同一个语义。
 * 3. **水位的比较基准是「本设备 seq 时钟」**，不是墙上时间。
 *    seq 时钟回退（用户清了本地数据）时旧水位必须作废，否则新会话会被
 *    旧水位永久遮蔽、永不上云（Supabase 侧踩过这个 P0，见 syncWatermark.ts）。
 *
 * ── 第四条纪律（2026-10-20 修 P0「索引丢了被当成空库」时补上）──────────
 * 4. **「索引丢了」≠「远端空了」**。manifest.json 是**派生数据**：
 *    真正的内容是 `groups/` 目录下的分片文件。索引不在了，只能说明
 *    **我们不知道云端有什么**，不能说明**云端什么都没有**。
 *    把两者混同的后果（已确认的 P0 数据丢失）：
 *      · 设备 A、B 共用一个库，B 有 S1..S5、A 有 S1..S3；
 *      · 索引因第三方同步客户端冲突/用户整理目录而丢失；
 *      · A 的下一次上传看到 404 ⇒ 判定「远端是空库」⇒ 全量上传 A 的 S1..S3
 *        ⇒ manifest 被整体换成本批的 3 个条目；
 *      · S4/S5 的**分片文件还在磁盘上**，却不在索引里 ⇒ 对所有设备隐形；
 *      · B 的水位线又认为 S4/S5「已上传」⇒ 永远不再上行 ⇒ 云端侧永久丢失。
 *    现在 `loadIndex()` 区分三态：**空库 / 索引在 / 索引丢了但分片还在**。
 *    第三态必须先**重建索引**（列目录 + 读回分片）再谈上传，
 *    重建不出来就**中止本轮**（fail-closed），绝不按空库处理。
 */
import type { TabGroup, UserSettings } from '@/types/tab';
import type { DeleteBroadcastResult } from '@/core/accountScope';
import type {
  DownloadSettingsResult,
  RemoteGroupFingerprint,
  SyncBackendPort,
  UploadGroupsResult,
} from '../ports';
import { WebDavClient, WebDavError } from './client';

/**
 * 这个错误是不是「父目录不存在」（HTTP 409）。
 *
 * 只认 WebDavError 的 409：网络层失败（status 0）与 5xx 都不是「目录没了」，
 * 重试建目录对它们没有意义（只会把同一个故障重试一遍）。
 */
function isConflictStatus(err: unknown): boolean {
  return err instanceof WebDavError && err.status === 409;
}
// 设备 id 的权威键名（2026-10-17）：见 nextDeleteStamp 的说明。
// 手抄字面量导致删除广播全部盖成 d:'unknown'，是本文件修掉的一个 P0。
import { LEGACY_KEYS } from '@/storage-kv/keys';
import {
  GROUPS_DIR,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  SETTINGS_PATH,
  decodeGroup,
  emptyManifest,
  encodeGroup,
  encodeTombstone,
  inspectShardFileName,
  isManifestUsable,
  makeEncryptedEnvelope,
  makePlainEnvelope,
  parseEnvelope,
  parseManifest,
  serializeEnvelope,
  serializeManifest,
  shardHeaderFromPayload,
  shardPath,
  legacyPathDiffers,
  legacyShardPath,
  type Manifest,
  type ShardFingerprint,
  type ShardHeader,
} from './layout';
import { createVault, openVault, type Vault } from '../crypto';
// 2026-10-24 审计 SEC-1：新建加密库时的口令强度门槛（见 passphrasePolicy 的文件头）。
import { evaluatePassphrase, PASSPHRASE_MIN_LENGTH } from './passphrasePolicy';
import { checkDeleteFailsafe } from '@/core/deleteFailsafe';
// 远端裁决的**共享判据**（2026-10-20 D-4/D-5）：内容优先于索引，
// 墓碑读回 = 「广播成功」的定义。与 Supabase 侧是同一套口径，见该文件。
import {
  compareTombstoneReadback,
  resolveRemoteState,
  shouldConcedeToRemote,
} from '@/core/remoteAdjudication';
// 同一会话两份副本的裁决口径（2026-10-26 布局改 1 位前缀）。
// 委托给 core/opStamp，避免口径漂移 —— 与 mergeOpStamped 同一套全序。
import { compareStampsLoose } from '@/core/opStamp';
import { logWarn } from '@/utils/log';

/** 适配器配置。口令为 null/undefined 表示用户选了「不加密」（明文存云盘）。 */
export interface WebDavBackendConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** 远端根目录（相对 baseUrl）。默认 `TapStack`。 */
  rootPath?: string;
  /** 加密口令。null / 空字符串 = 不加密（**会在隐私说明里如实告知**）。 */
  passphrase?: string | null;
  /**
   * 加密是否**必须**（用户没在「不加密」上明确勾选）。
   *
   * 与 `passphrase` 的分工：`passphrase` 回答「这次有没有口令」，
   * 本字段回答「没口令时该怎么办」。分开是因为「本次忘了输口令」与
   * 「用户压根不要加密」是两种完全不同的状态：
   *   · 前者必须**报错**（否则数据会**明文**上云，且用户毫不知情）；
   *   · 后者是合法选择（界面已展示风险）。
   * 只用一个字段表达两者，必然漏掉其中一种 —— 而漏掉的正是危险的那种。
   */
  requireEncryption?: boolean;
}

/** 本地状态存储（水位）。抽成接口是为了测试能注入内存实现。 */
export interface AdapterKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface WebDavAdapterDeps {
  client: WebDavClient;
  config: WebDavBackendConfig;
  /** 本地 KV（默认走 chrome.storage / IndexedDB 适配层）。 */
  kv: AdapterKv;
  /** 时钟注入（测试用）。 */
  now?: () => string;
  /**
   * 本设备 seq 计数器的当前值。用于水位的「时钟回退」自检。
   * 注入而不是直接 import seqRegistry：那会把「发号器」与「同步后端」耦合起来，
   * 而发号器的生命周期由写作路径持有（它比同步更底层）。
   */
  peekDeviceSeq?: () => Promise<number>;
  /**
   * 本设备 Lamport 时钟的**取号**与**抬升**能力（2026-10-20 D-7）。
   *
   * 删除广播的印记必须由**本机时钟**发出（见 nextDeleteStamp 的完整论证），
   * 所以适配器需要的不只是「看一眼计数器」，而是「取一个新号」+「把观察到的
   * 更大的号吸收进本机时钟」。
   *
   * 为什么注入而不是直接 import seqRegistry：同 peekDeviceSeq 的理由 ——
   * 发号器的生命周期由写作路径持有，它比同步更底层。
   *
   * 缺省实现退化成「只看 + 不抬升」：那会让删除广播拿不到真正的新号
   * （D-7 的缺陷形态）。**生产路径必须注入**（src/sync-backend/index.ts 绑定了
   * 真实的 seqRegistry），测试里则可以注入内存实现来断言行为。
   */
  nextDeviceSeq?: () => Promise<number>;
  /** 把观察到的号吸收进本机 Lamport 时钟（保证本机随后发出的号严格大于它）。 */
  bumpDeviceSeqIfLower?: (candidate: number) => Promise<number>;
  /**
   * **只读模式**（2026-10-23 第 50 轮）：这个适配器只许读，不许写远端。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────
   * 设置页有两处会造适配器（「测试连接」与「探测远端」）。它们过去是
   * **靠调用方自觉**只调读方法 —— 一旦有人在这两处基础上加一次写操作，
   * 就落回 D-7 那个缺陷形态（墓碑号退化成「云端 seq + 1」⇒ 跨设备删除被
   * 静默撤销、会话复活）。
   *
   * 有了这个开关，写方法在**运行时**直接拒绝 ⇒「只读」不再是一句注释，
   * 而是可执行的约束（判据见 tests/guards/webDavTransportSingleAcquisition.test.ts）。
   *
   * ⚠️ 只拦**本适配器自己的**写方法。`checkConnection()` 内部会往远端写一个
   * 探针文件（`.tapstack-probe`，用来实测服务端支持不支持条件写）——
   * 那不是用户数据，不构成「写」，所以不在此列。
   */
  readOnly?: boolean;
}

/** 水位值形状。与 Supabase 侧同构（含 deviceSeq 基线）。 */
interface SyncWatermark {
  seq: number;
  deviceSeq: number;
}

/**
 * 远端索引（manifest）的三态。
 *
 * · `empty` —— 远端确实没有这个库：`groups/` 目录不存在，或目录里一个分片都没有。
 *   这是**合法**的首次同步起点，走「首次全量上传」。
 * · `manifest` —— 索引在（`rebuilt: false`），或者索引丢了、我们刚从分片目录
 *   **重建**了一份（`rebuilt: true`）。
 *
 * `rebuilt` 不是装饰标记：只有它为 true 时，我们才**确知**云端到底有哪些分片
 * （权威认知），也只有它为 true 时，「本地水位线以为已上传、但云端其实没有」
 * 这份差异才能被揪出来并补传（见 selectMissingFromIndex）。
 */
type RemoteIndex =
  | { kind: 'empty' }
  | { kind: 'manifest'; manifest: Manifest; etag: string | null; rebuilt: boolean };

/** 远端 groups/ 目录的一次扫描结果。 */
interface RemoteShardScan {
  /** 符合本版本布局的分片（id + 相对 baseUrl 的路径 + 落点）。 */
  shards: Array<{ id: string; path: string; loc?: 'legacy' }>;
  /**
   * **同一个会话的两份副本里，输掉的那一份**（相对 baseUrl 的路径）。
   *
   * 2026-10-26 布局改 1 位前缀后，老版本设备写的旧路径与新版本设备写的新路径
   * 可能同时存在。裁决规则 = **操作印记大者胜**（与 mergeOpStamped 同一口径）。
   * 输的那份不是「错误」——它是**冗余**，会在上传后自检阶段被删掉
   * （删之前确认胜者仍可读 ⇒ 删的只是重复，不是内容）。
   *
   * 为什么不能「两份都当有效分片」：同一个 id 出现两条 ⇒ 索引里该有两条指纹
   * ⇒ 合并时会对同一个会话做两次裁决 ⇒ 哪一条赢取决于遍历顺序 ⇒ 不收敛。
   */
  redundant: string[];
  /**
   * **不符合**本版本布局的文件（相对 baseUrl 的路径）。
   *
   * 非空即意味着「云端目录被人动过」：可能是用户整理过目录，也可能是一个
   * 装 着真实会话内容的分片被放错了位置。两种情况都**不能**当「没有这个文件」
   * —— 那正是会让内容对所有设备隐形的那类静默丢失。
   */
  unexpected: string[];
  /**
   * 目录**列不出来**（404/409/405/501）。
   *
   * true = 我们**不知道**云端有什么 —— 绝不能当成「云端是空的」。
   * 与 `shards.length === 0` 严格区分：那是「确知云端一个分片都没有」。
   */
  listingFailed: boolean;
}

/** 水位键前缀。按「库地址」寻址 —— 换库 / 换账号自动失效，不会带旧水位过去。 */
const WATERMARK_PREFIX = 'webdav_sync_watermark';

/**
 * 乐观锁重试上限。
 *
 * 3 次是「够用且不会卡住」的取值：每次重试都要重新 GET + 解密 + 裁决，
 * 而真实并发（两台设备同时改同一个会话）在第三次之前必然分出胜负——
 * 因为每次重试前我们都会读到对方的新 ETag，裁决结果不会再变。
 * 无限重试反而危险：两次以上的 412 通常意味着有别的东西在持续改这个文件
 * （用户的同步客户端 / 手改脚本），此时应该停下来出声而不是对着干。
 */
const CONFLICT_RETRY_LIMIT = 3;

/**
 * 列目录时的并发上限。
 *
 * 为什么不是串行：重建索引 / 索引自检都要列 `groups/` 下的**所有**前缀子目录
 * （会话数 ≈ 前缀子目录数）。串行会让恢复态的上传等上好几秒。
 * 为什么不是无限并发：坚果云这类服务端有并发/频率限制，打满它会触发限流，
 * 反而把同步拖垮。8 是「不慢、也不压服务器」的折中。
 */
const DIR_SCAN_CONCURRENCY = 8;

/**
 * 「索引 ↔ 实际分片」全量自检的最小间隔（毫秒）。理由见 shouldVerifyIndex。
 *
 * ⚠️ **2026-10-26：这个数字是限额倒推出来的，不是拍脑袋调出来的。**
 *
 * 一次全量扫描的请求数 = 1（列 `groups/`）+ N（逐个列前缀子目录）次 PROPFIND，
 * 而 N = **用到的前缀目录数**。
 * 生产会话 id 是 `nanoid()`（64 字符表 ⇒ 前 1 位 64 种取值、前 2 位 4096 种）。
 *
 * 坚果云官方限制（help.jianguoyun.com/?p=2064）：
 *   · **每 30 分钟不超过 600 次请求**（免费版 600、付费版 1500）；
 *   · 单次请求返回的文件数上限 **750**（不分页会「文件同步不完整」）。
 *
 * ⇒ 前缀 2 位时：1000 个会话约用到 887 个前缀目录 ⇒ 单次扫描约 888 次
 *   ⇒ **一次扫描就超过 600** ⇒ 撞线。
 * ⇒ 前缀 1 位时：N ≤ 64 ⇒ 单次扫描 ≤ 65 次 ⇒ 限额问题消失。
 *
 * ⚠️ **老库（2 位目录）的扫描成本降不下来** —— 那些目录不会被自动删掉
 *   （删目录 = 动用户云盘上的东西，删错了就是内容丢失）。
 *   ⇒ 对老库而言，**间隔**才是承重墙：
 *   升级后最坏的老库 = 256 个老的 2 位目录 + 64 个新建会话的 1 位目录
 *   ⇒ 单次扫描 321 次 ⇒ 间隔 5 分钟时 30 分钟内要发 6 × 321 = 1926 次
 *   （**远超 600**）⇒ 间隔 30 分钟时只要 321 次 ⇒ 仍在限额内。
 *
 * ⚠️ 剩下的边界（不掩饰）：一个**会话数上千**的老库（2 位前缀目录 > 590 个）
 *   单次扫描仍可能撞线 ⇒ 本版不处理（处理它就意味着删用户的目录）。
 *
 * ⚠️ **撞线的后果不是「变慢」**：坚果云返回 **503 BlockedTemporarily**，
 * 官方建议「关闭同步后六小时再重新启用同步即可」
 * ⇒ **同步直接停摆 6 小时**（用户看到的是「云端不可用」）。
 * ⇒ 所以这个间隔是「同步还能不能用」的承重墙，不是性能调优项。
 */
export const INDEX_VERIFY_INTERVAL_MS = 30 * 60_000;

/**
 * 远端分片的**裁决依据**（2026-10-20 D-4）。
 *
 * 全部来自**分片内容**，不是索引：
 *   · `lastOp` —— 分片自己的操作印记（头部优先，老分片则解密正文取）；
 *   · `isDeleted` —— 分片自己是不是墓碑；
 *   · `etag` —— 服务端给的条件写凭据（不是索引里抄的那一份）。
 */
interface RemoteShardState {
  /** 远端有没有这个分片。 */
  exists: boolean;
  /** 服务端给的 ETag（条件写用）。 */
  etag: string | null;
  /** 分片自身的印记。 */
  lastOp?: { d: string; s: number };
  /** 分片自身是不是墓碑。 */
  isDeleted?: boolean;
  /** 分片在，但内容读不出来（外壳坏了）⇒ 不可裁决。 */
  unreadable?: boolean;
  /**
   * 读到的是**哪个文件**（完整路径，2026-10-26 布局改动后新增）。
   *
   * 为什么必须有：条件写的凭据（ETag）只对**它所属的那个资源**有效。
   * 老库的分片在旧路径上，而新代码只写新路径 ⇒ 拿旧路径的 ETag 去
   * If-Match 新路径 ⇒ 必然 412（目标根本不存在）⇒ 每次上传都失败。
   * ⇒ 读到的路径与写的路径不一致时，条件写必须换成「仅当不存在时创建」。
   */
  path?: string;
}

export class WebDavBackendAdapter implements SyncBackendPort {
  readonly id = 'webdav' as const;
  readonly label = '自带存储（WebDAV）';

  private readonly client: WebDavClient;
  private readonly config: WebDavBackendConfig;
  private readonly kv: AdapterKv;
  private readonly now: () => string;
  private readonly peekDeviceSeq: () => Promise<number>;
  private readonly nextDeviceSeq: () => Promise<number>;
  private readonly bumpDeviceSeqIfLower: (candidate: number) => Promise<number>;
  /** 只读模式（探针路径）：true ⇒ 写方法一律拒绝。 */
  private readonly readOnly: boolean;
  /**
   * 兜底本机时钟的号位（只在调用方**没注入**发号器时使用）。
   *
   * 为什么需要它：兜底取号器若不持有号位，每次发号都会拿到同一个数 ⇒
   * 墓碑号与云端 seq 无关 ⇒ 退回 D-7 的缺陷形态。见构造函数的说明。
   */
  private fallbackSeq: number;
  private readonly root: string;

  /**
   * 条件写能力（**显式状态**，2026-10-20 D-4）。null = 还没探测。
   *
   * 为什么必须变成「状态」而不是每次现探：裁决策略要在「发不发 If-Match」
   * 上分叉，而这个判断必须**每轮一致** —— 同一轮里先按「支持」发、后按
   * 「不支持」不发，等于自己跟自己打架，412 重试路径也就失去了意义。
   * 探测一次、缓存住，策略才有稳定依据。
   */
  private conditionalWrites: boolean | null = null;

  /**
   * **已经建好**的远端目录（相对 baseUrl 的路径，例：`TapStack/groups/a`）。
   *
   * ── 为什么需要它（2026-10-24 审计 PERF-01）────────────────────────────
   * 写一个分片要逐级 MKCOL（root → groups → 前缀目录），而生产会话 id
   * 是 `nanoid()`（21 位、64 字符表 ⇒ 前 2 位有 **4096** 种取值）⇒ 1000 个会话
   * 约产生 884～899 个不同前缀目录 ⇒ 每轮上传的 MKCOL 里约 **70%** 是
   * 「对早已存在的目录再发一次必然 405 的空请求」，而且**全程串行**。
   *
   * 实测（真实 WebDavClient 打真实服务器）：写一个会话要 **6.89～7.91 次串行
   * 往返**（下载同库只要 1.00 次）⇒ 1000 个会话一轮上传 ≈ 6900～7900 次往返 ⇒
   * 用户看到的是「推送失败：操作超时（30 秒）」，而后台其实还在继续传。
   *
   * ⚠️ **2026-10-26：前缀位数改成 1 位之后，这笔账已经小了两个数量级。**
   * 64 字符表的前 1 位只有 64 种取值 ⇒ 1000 个会话最多产生 **64** 个前缀目录
   * （原来约 890 个）⇒ MKCOL 的空请求从约 70% 降到约 6%。
   * ⇒ 这个缓存**仍然保留**（它是对的，且老库仍是 2 位布局 ⇒ 老库照样受益），
   *   但别再拿「6.89 次往返/会话」当现状 —— 那是 2 位布局时代的测量值。
   *
   * ── 为什么缓存是**安全**的 ──────────────────────────────────────────
   * `client.mkcol` 把 **405（目录已存在）当成成功** ⇒ 「建过」这件事幂等 ⇒
   * 缓存「这个目录已经在了」不会让写入失败。
   *
   * ── 为什么缓存是**实例级**而不是模块级 ───────────────────────────────
   * 缓存的是「**这个库**里有哪些目录」⇒ 换服务器（改配置）必须清空 ⇒
   * 模块级缓存会把 A 服务器的目录记到 B 服务器头上（⇒ B 上少了目录 ⇒
   * PUT 409）。适配器实例与配置一一绑定（配置一变就重建适配器）⇒
   * 实例级缓存天然随配置失效 ✔。
   *
   * ── 目录被人删掉了怎么办 ────────────────────────────────────────────
   * 缓存会过期 ⇒ PUT 返回 409 ⇒ `writeShard` 会**忘掉**这个目录、重建一次、
   * 再重试一次（见 writeShard 的注释）。⇒ 「云盘上的目录被人删了」不会
   * 变成「本机从此再也传不上去」。
   */
  private readonly knownDirs = new Set<string>();

  constructor(deps: WebDavAdapterDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.kv = deps.kv;
    this.now = deps.now ?? (() => new Date().toISOString());
    // 默认 0：没有发号器时水位基线的自检退化为「不检测」，
    // 这在真实运行时不会发生（写作路径总会注入），测试里则让断言更简单。
    this.peekDeviceSeq = deps.peekDeviceSeq ?? (async () => 0);
    // ── 2026-10-20 D-7：删除广播的取号与抬升 ────────────────────────────
    //
    // 生产路径（src/sync-backend/index.ts）注入真实的 seqRegistry ——
    // 那是**唯一**能让删除广播的号与写作路径共享同一个计数器的接法。
    // 下面的兜底只在「调用方没注入发号器」时生效（测试与设置页的探测适配器）。
    //
    // 兜底必须**真的是一台本机时钟**，不能是「看一眼 + 不发号」：
    //   · 之前的兜底取号器算完 `peek + 1` 就丢掉，且配套的 bump 是空操作
    //     ⇒ 每次发号都拿到**同一个**数，且那个数与云端 seq 无关 ⇒
    //     墓碑号退化成「云端 seq + 1」= 缺陷形态本身（只是换了个地方发生）。
    //   · 现在兜底持有**自己的单调号位**：发号时抬一格、吸收时抬高下限，
    //     于是「墓碑的号是本机发出去的」与「本机随后的号严格大于墓碑」两条
    //     不变式在兜底路径上同样成立。
    //
    // 兜底号位与写作路径的计数器**不共享**（那是「没注入发号器」的代价），
    // 所以生产路径必须注入 —— 见 src/sync-backend/index.ts 的绑定。
    this.fallbackSeq = 0;
    this.nextDeviceSeq =
      deps.nextDeviceSeq ??
      (async () => {
        const observed = await this.peekDeviceSeq();
        this.fallbackSeq = Math.max(this.fallbackSeq, observed) + 1;
        return this.fallbackSeq;
      });
    this.bumpDeviceSeqIfLower =
      deps.bumpDeviceSeqIfLower ??
      (async (candidate: number) => {
        if (candidate > this.fallbackSeq) this.fallbackSeq = candidate;
        return this.fallbackSeq;
      });
    this.root = normalizeRoot(deps.config.rootPath);
    // 只读模式：默认 false（生产路径照旧可写）；探针路径显式传 true。
    this.readOnly = deps.readOnly === true;
  }

  /**
   * 写操作的闸门（只读模式下直接拒绝）。
   *
   * 为什么放在**每个写方法的第一行**而不是别处：闸门必须早于任何网络访问，
   * 否则「只读探针误调了写方法」会先在远端留下痕迹再报错 —— 那时候
   * 「没写成功」的承诺已经不成立了。
   */
  private assertWritable(): void {
    if (!this.readOnly) return;
    throw new Error(
      '这个适配器是**只读探针**（设置页的「测试连接」/「探测远端」用），不允许写远端。' +
        '要写真实数据请走正常的同步路径。'
    );
  }

  // ── 路径 ────────────────────────────────────────────────────────────

  private p(rel: string): string {
    return this.root ? `${this.root}/${rel}` : rel;
  }

  private get watermarkKey(): string {
    // 按 baseUrl + 用户名 + 根目录寻址：这三者任一变化都意味着「另一个库」。
    // 哈希而不是直接拼：用户名/地址可能很长且含特殊字符，键名要短且安全。
    return `${WATERMARK_PREFIX}:${shortHash(`${this.client.baseUrl}|${this.config.username}|${this.root}`)}`;
  }

  // ── 密码学上下文 ────────────────────────────────────────────────────

  /** 本轮同步的加密上下文。null = 明文模式。 */
  private vault: Vault | null = null;

  /**
   * 按 manifest 决定加密上下文。
   *
   * **一次同步只派生一次密钥**（见 crypto.ts 里 Vault 的性能论证）。
   * 缓存在实例字段上：SyncEngine 在一次同步里对同一个适配器实例串行调用
   * 多个方法，缓存命中；下一轮同步会新建实例（由 resolve 层负责），
   * 因此不会跨轮持有旧口令派生的密钥。
   */
  private async unlock(manifest: Manifest | null): Promise<Vault | null> {
    if (this.vault) return this.vault;

    const encrypted = manifest?.encrypted === true;
    if (!encrypted) {
      // 首次创建时按配置里有没有口令决定，而不是一律明文。
      const pass = this.config.passphrase;
      if (pass) {
        // 2026-10-24 审计 SEC-1：这一行正是在**新建**一个加密库 ⇒ 这个口令
        // 是在「选一个」，不是在「回忆一个」 ⇒ 弱口令必须在这里被拦下。
        //
        // 【为什么门槛落在这里，而不是表单校验】口令**不落盘**（只在浏览器
        // 会话内存里，见 webdav/config.ts 的文件头），所以老用户每次重开页面
        // 都要**重新输入**当年那个口令。把门槛放在表单上 ⇒ 当年用了 `123456`
        // 的老用户，在新设备上配同一个库、或清过配置再配回来时，会被**自己
        // 的口令**挡在门外 —— 把「安全加固」做成「数据取不回来」。
        //
        // 而这一行只在「库里还没有加密」时才走得到（已加密的库走下面的
        // openVault）⇒ 拦的**永远**是「选口令」，不会拦「回忆口令」。
        const verdict = evaluatePassphrase(pass);
        if (!verdict.acceptable) {
          throw new Error(
            `这个云端库还没有加密过，而你设置的加密口令太弱（${verdict.reason}）。` +
              '已中止：口令太弱时，拿到你云盘副本的人可以离线把它猜出来，' +
              '整库会话（会话名、标签标题、网址）就都失去保护了。' +
              `请在同步设置里换一个至少 ${PASSPHRASE_MIN_LENGTH} 位的口令。`
          );
        }
        this.vault = await createVault(pass);
      } else if (this.config.requireEncryption) {
        // ⚠️ 这一条挡的是「静默明文上云」：用户选择了加密，但本次没给口令。
        // 继续走下去会把标签页明文写进他自己的云盘，而界面一路绿灯。
        throw new Error(
          '已选择启用加密，但本次没有提供口令，已中止以免数据以明文上传。' +
            '请重新输入口令，或在设置里改为「不加密」。'
        );
      }
      return this.vault;
    }

    const pass = this.config.passphrase;
    if (!pass) {
      throw new Error(
        '这个云端库是加密的，但本机没有口令。请在同步设置里填入当时设置的口令。'
      );
    }
    this.vault = await openVault(pass, manifest.salt as string);
    return this.vault;
  }

  // ── manifest 读写 ───────────────────────────────────────────────────

  /**
   * 重建出来的索引缓存。
   *
   * 只在「远端没有 manifest.json」的恢复态里有值。存在的理由是**成本**：
   * 恢复态里每次探活（fetchFingerprints）都会触发一次「列目录 + 读回全部分片」，
   * 而探活是每分钟级的高频调用 —— 不缓存的话恢复态会把用户的云盘打爆。
   *
   * 失效时机：manifest 写回成功（索引已落盘）、或写回时发生 412 冲突
   * （说明远端状态已经变了，缓存的认知不再可靠）。
   */
  private rebuiltIndex: Manifest | null = null;

  /** 上次做「索引 ↔ 实际分片」全量自检的时刻（0 = 从没做过）。 */
  private lastIndexVerifyAt = 0;

  /**
   * 读远端索引（manifest），并区分三种状态。
   *
   * @returns `empty` = 远端确实没有这个库（**合法状态**，首次同步从这里开始）
   * @returns `manifest` = 索引在，或索引丢了但我们已从分片目录重建
   * @throws 文件存在但解析不了 / 加密库缺 salt —— 「坏了」必须与「空」分开
   * @throws 索引丢了、想重建却重建不出来 —— **中止本轮**，绝不按空库处理
   */
  private async loadIndex(): Promise<RemoteIndex> {
    const got = await this.client.get(this.p(MANIFEST_PATH));
    // 'notFound' in got = 404 或 409（父目录不存在）。两者对「清单还不存在」等价：
    // 坚果云等按 RFC 4918 对不存在的父目录回 409 而不是 404，语义上仍是「没有」。
    if (got && !('notFound' in got)) {
      const parsed = parseManifest(got.body);
      if (!parsed) {
        throw new Error(
          `云端清单文件（${MANIFEST_PATH}）无法解析，已中止本次同步以免把本地数据判成「云端已清空」。` +
            '请检查该文件是否被其他程序改动过。'
        );
      }
      if (!isManifestUsable(parsed)) {
        throw new Error(
          '云端清单显示这个库是加密的，但缺少密钥参数（salt）。文件可能被截断，已中止本次同步。'
        );
      }
      return { kind: 'manifest', manifest: parsed, etag: got.etag, rebuilt: false };
    }

    // ── 索引不在。接下来要回答的是：「远端是空的」还是「索引丢了、分片还在」？──
    // 判据不是 manifest 本身，而是**分片目录**：
    //   · groups/ 目录都不存在 ⇒ 远端确实没建过库（首次同步的合法起点）；
    //   · groups/ 目录存在 ⇒ 里面可能有分片 ⇒ 必须重建索引。
    //
    // ⚠️ 为什么先 stat 再列目录（而不是直接列）：
    // 有些服务端不支持 Depth:1（405/501）。先用 Depth:0 的 stat 判存在性，
    // 首次同步（groups/ 压根不存在）就完全不碰 Depth:1 —— 不支持列目录的
    // 服务端依然能完成首次同步。代价是多一次极轻量的 PROPFIND。
    const dir = await this.client.stat(this.p(GROUPS_DIR));
    if (!dir.exists) return { kind: 'empty' };

    if (this.rebuiltIndex) {
      return { kind: 'manifest', manifest: this.rebuiltIndex, etag: null, rebuilt: true };
    }

    const rebuilt = await this.rebuildManifestFromDisk();
    // groups/ 在，但里面一个分片都没有 ⇒ 远端确实没有任何会话内容。
    if (!rebuilt) return { kind: 'empty' };
    this.rebuiltIndex = rebuilt;
    return { kind: 'manifest', manifest: rebuilt, etag: null, rebuilt: true };
  }

  /**
   * 读「写索引时用的 base」——**不做恢复**。
   *
   * ── 为什么必须与 loadIndex 分开 ────────────────────────────────────────
   * `loadIndex` 在索引不在时会**去重建**（列目录 + 读回全部分片）。
   * 而 writeManifest 的用途是「基于最新的远端索引合并后写回」——
   * 它在**首次同步**里也会被调用，而首次同步时远端根本没有索引，
   * 目录也还不存在（要等写分片时才建出来）。
   *
   * 若 writeManifest 复用 loadIndex，就会发生这个顺序：
   *   写分片 → 建出 groups/ 目录 → 调 writeManifest → loadIndex 发现
   *   「索引不在 + groups/ 在」⇒ 判定「索引丢了」⇒ 去重建 ⇒ 重建时列目录
   *   （列得到）⇒ 把刚写的分片收进 base ⇒ 写回索引 —— 看起来没事，
   *   但在**不支持 Depth:1** 的服务器上，重建会直接抛错 ⇒ 首次同步挂死。
   *
   * 写索引时需要的 base 只有两种可能：
   *   · 远端**有**索引 ⇒ 用它（这是并发安全的核心）；
   *   · 远端**没有**索引 ⇒ 从零开始（空 base），而这正是首次同步的形态。
   * 「远端没有索引但目录里有分片」是**恢复态**，那条路由 loadIndex 负责，
   * 写索引时不需要再问一次（问一次就会踩上面那个坑）。
   */
  private async loadIndexForWrite(): Promise<{ manifest: Manifest; etag: string | null } | null> {
    const got = await this.client.get(this.p(MANIFEST_PATH));
    if (!got || 'notFound' in got) return null;
    const parsed = parseManifest(got.body);
    if (!parsed) {
      throw new Error(
        `云端清单文件（${MANIFEST_PATH}）无法解析，已中止本次同步以免把本地数据判成「云端已清空」。` +
          '请检查该文件是否被其他程序改动过。'
      );
    }
    if (!isManifestUsable(parsed)) {
      throw new Error(
        '云端清单显示这个库是加密的，但缺少密钥参数（salt）。文件可能被截断，已中止本次同步。'
      );
    }
    return { manifest: parsed, etag: got.etag };
  }

  /**
   * 重建索引**失败**时的统一出口。
   *
   * 分两种「失败」，但**处理方式相同**（中止本轮，绝不按空库处理）：
   *   · 目录列不出来（服务端不支持 Depth:1 / 目录被挪了）⇒ 我们不知道云端有什么；
   *   · 目录里全是无法识别的文件 ⇒ 我们同样不知道云端有什么。
   * 区别只在于**给用户看的话**（能不能给出可操作的下一步）。
   */
  private indexUnrecoverable(reason: string): never {
    throw new Error(
      `云端索引（${MANIFEST_PATH}）丢失，且无法从云盘的会话文件目录重建：${reason}` +
        '已中止本次同步 —— 绝不会把云端当成空库（那会用本机的子集覆盖云端内容，' +
        '造成不可恢复的丢失）。请检查云盘目录结构，或在设置里重新做一次全量同步。'
    );
  }

  /**
   * 列目录 + 读回分片，**从磁盘重建**一份 manifest。
   *
   * ── 哪些字段是可信的、哪些是不可信的 ──────────────────────────────────
   * 可信（来自分片**内容**，逐个读回并解密）：
   *   · id —— 来自**文件名**（`groups/<id前1位>/<id>.json`，老库是前 2 位），
   *     不依赖内容，也不依赖能不能解密 ⇒ **加密库同样拿得到**；
   *   · updatedAt / lastOp / isDeleted —— 来自解码后的会话内容，
   *     加密库需要口令才能拿到（拿不到就中止，见下）；
   *   · etag —— 来自这次 GET 的响应头（服务端不给就没有这一项）。
   * 不可信 / 拿不到：
   *   · generatedAt —— 只能填「现在」，它本来就不参与判定（多设备时钟不可信）；
   *   · 拿不到口令时的 updatedAt / lastOp —— **本函数直接抛错**，
   *     绝不拿「猜出来的」值去填。理由：`lastOp` 缺失会让
   *     `compareStampsLoose(undefined, x)` 把远端判成「最小」，
   *     于是下一次上传会用**旧内容覆盖新内容** —— 一个「看起来重建成功了、
   *     其实索引是错的」状态，比不重建更危险。
   */
  private async rebuildManifestFromDisk(): Promise<Manifest | null> {
    const scan = await this.scanRemoteShards();

    // ── 列不出来 ⇒ 我们**不知道**云端有什么（不是「云端是空的」）────────
    if (scan.listingFailed) {
      this.indexUnrecoverable(
        `无法列出云端的 ${GROUPS_DIR}/ 目录（服务器可能不支持 PROPFIND Depth:1，或目录已被移动）。`
      );
    }

    if (scan.shards.length === 0) {
      if (scan.unexpected.length > 0) {
        // 目录里有东西，但没有一个是我们认识的布局 ⇒ 可能是被人动过。
        // 此时**绝不能**判定「远端是空库」：那些文件里可能装着真实会话。
        throw new Error(
          `云端 ${GROUPS_DIR}/ 目录里有 ${scan.unexpected.length} 个无法识别的文件` +
            `（例如 ${scan.unexpected.slice(0, 3).join('、')}），目录结构与本版本不符。` +
            '已中止本次同步以免把云端当成空库导致内容被覆盖。' +
            '请检查云盘目录是否被手工整理过，或把分片放回 groups/<id前1位>/<id>.json' +
            '（2026-10-26 之前建的库用 groups/<id前2位>/<id>.json，两种布局都认）。'
        );
      }
      return null; // 远端确实一个分片都没有
    }

    const fingerprints: ShardFingerprint[] = [];
    const vaults = new Map<string, Vault>();
    let encrypted = false;
    let salt: string | undefined;

    for (const shard of scan.shards) {
      // shard.path 已经是「相对 baseUrl」的路径（里面含了同步根目录），
      // 所以这里**不能**再套 this.p()。
      const got = await this.client.get(shard.path);
      if (!got || 'notFound' in got) {
        throw new Error(
          `云端分片 ${shard.id} 在列目录之后就不见了（可能正被其它程序改动），` +
            '已中止本次同步以免把云端当成空库。'
        );
      }
      const env = parseEnvelope(got.body);
      if (!env) {
        throw new Error(
          `云端分片 ${shard.id} 无法解析（可能被截断或改坏），已中止本次同步以免把云端当成空库。`
        );
      }

      let payload: unknown;
      if (env.kind === 'encrypted') {
        // 加密分片的 salt 就在**外壳里**（明文）⇒ 索引丢了也能找回库的密钥参数。
        // 这是「加密库也能重建索引」的关键（见 crypto.ts 的 EncryptedPayload）。
        if (salt !== undefined && env.enc.salt !== salt) {
          throw new Error(
            '云端分片的加密 salt 互相不一致（这个库可能被合并过两个来源），' +
              '已中止本次同步以免用错误的密钥覆盖云端内容。'
          );
        }
        salt = env.enc.salt;
        encrypted = true;

        const pass = this.config.passphrase;
        if (!pass) {
          throw new Error(
            '云端库是加密的，但本机没有口令，无法重建云端索引。' +
              '已中止本次同步以免把云端当成空库。请在同步设置里填入当时设置的口令后重试。'
          );
        }
        let vault = vaults.get(env.enc.salt);
        if (!vault) {
          // 一次同步只派生一次密钥（PBKDF2 250k 轮，很贵）；同一 salt 复用。
          vault = await openVault(pass, env.enc.salt);
          vaults.set(env.enc.salt, vault);
          // 与重建出来的 manifest 用的 salt 一致 ⇒ 后续 unlock() 直接复用它，
          // 不必再派生一次（也避免派生出**另一个** salt 的密钥）。
          this.vault = vault;
        }
        payload = await vault.decrypt(env.enc);
      } else {
        payload = env.plain;
      }

      const group = decodeGroup(payload);
      if (!group) {
        throw new Error(
          `云端分片 ${shard.id} 的内容无法解析成会话，已中止本次同步以免把云端当成空库。`
        );
      }
      if (group.id !== shard.id) {
        throw new Error(
          `云端分片 ${shard.id} 的内容与文件名对不上（内容里的 id 是 ${group.id}），` +
            '已中止本次同步以免把云端当成空库。'
        );
      }

      fingerprints.push({
        id: shard.id,
        ...(got.etag ? { etag: got.etag } : {}),
        updatedAt: group.updatedAt,
        ...(group.isDeleted ? { isDeleted: true } : {}),
        ...(group.lastOp ? { lastOp: group.lastOp } : {}),
        // 落点必须记进重建出来的索引（2026-10-26）：这个分片落在旧布局里。
        // 不记 ⇒ 读方会按新路径去读 ⇒ 读不到 ⇒ 回退才救回来 ⇒ 而裁决用的
        // 又是另一份 ⇒ 「读到的」与「裁决的」不是同一份 ⇒ 静默覆盖。
        ...(shard.loc === 'legacy' ? { loc: 'legacy' as const } : {}),
      });
    }

    return {
      v: MANIFEST_VERSION,
      generatedAt: this.now(),
      encrypted,
      ...(salt ? { salt } : {}),
      shards: fingerprints,
    };
  }

  /**
   * 扫描远端 `groups/` 目录，列出符合本版本布局的分片。
   *
   * 布局有两种（2026-10-26 起新库用前者，老库用后者）：
   *   · `groups/<id前1位>/<id>.json`（新）
   *   · `groups/<id前2位>/<id>.json`（旧，老库的分片在那儿，不能当隐形数据）
   *   · 先列 `groups/` → 拿到前缀子目录；
   *   · 再逐个列前缀子目录 → 拿到 `<id>.json` 文件名。
   *
   * 同一个 id 在两条路径上都有一份时，按**操作印记**裁决（见 pickCopyByStamp），
   * 并把落点记进 `loc` —— 索引必须知道「读哪一份」，否则会出现
   * 「拿 A 的内容配 B 的印记」的静默覆盖。
   *
   * 为什么逐个列而不是 Depth:infinity：见 client.ts 的 listDir 注释
   * （截断的 infinity 结果 = 静默少列 = 静默丢数据）。
   *
   * 为什么必须校验「文件名推导出的路径 == shardPath(id) / legacyShardPath(id)」：
   * 索引里的 id 会被上层拿去读文件。若文件被放到了别的目录，
   * 索引里的 id 指向一个**读不到**的位置 —— 那等于把这个会话变成隐形数据。
   * 所以对不上就归入 unexpected（由调用方 fail-closed），而不是将就收下。
   */
  private async scanRemoteShards(): Promise<RemoteShardScan> {
    const scan: RemoteShardScan = { shards: [], redundant: [], unexpected: [], listingFailed: false };

    const root = await this.client.listDir(this.p(GROUPS_DIR));
    // ⚠️ 「列不出来」与「列出来是空的」必须分开：
    //   · 列不出来 ⇒ 我们**不知道**云端有什么 ⇒ 绝不按空库处理；
    //   · 列出来是空的 ⇒ 确知云端一个分片都没有。
    // 把前者当后者，就是本次要修的 P0（换了个位置重新犯）。
    if (!root.listed) {
      scan.listingFailed = true;
      return scan;
    }
    const rootEntries = root.entries;
    const prefixDirs = rootEntries.filter(e => e.isCollection);
    // groups/ 根下的散落文件不是本版本布局（分片必须在自己的前缀子目录里）。
    for (const loose of rootEntries.filter(e => !e.isCollection)) {
      scan.unexpected.push(loose.path);
    }

    // 同一个 id 可能在新旧两条路径上各有一份 ⇒ 先按 id 归拢，最后统一裁决。
    const copies = new Map<string, { current?: string; legacy?: string }>();

    await mapWithConcurrency(prefixDirs, DIR_SCAN_CONCURRENCY, async dir => {
      const child = await this.client.listDir(dir.path);
      if (!child.listed) {
        // 某个前缀子目录列不出来 ⇒ 那一段内容我们**不知道**。
        // 不能当成「那个前缀下没有分片」。
        scan.listingFailed = true;
        return;
      }
      for (const c of child.entries) {
        if (c.isCollection) {
          scan.unexpected.push(c.path);
          continue;
        }
        const info = inspectShardFileName(c.name);
        if (info.id === null) {
          // 不是分片（notes.txt），或是 id 非法的 .json（`a b.json`）。
          // 后者必须出声：它可能装着真实内容，静默忽略 = 隐形数据。
          scan.unexpected.push(c.path);
          continue;
        }
        // ── 两种布局都认（2026-10-26）─────────────────────────────────────
        // 新布局：groups/<id前1位>/<id>.json
        // 旧布局：groups/<id前2位>/<id>.json（老库的分片在那儿，不能当隐形数据）
        const currentPath = this.p(shardPath(info.id));
        const legacyPath = legacyPathDiffers(info.id) ? this.p(legacyShardPath(info.id)) : null;
        if (c.path === currentPath) {
          const slot = copies.get(info.id) ?? {};
          slot.current = c.path;
          copies.set(info.id, slot);
          continue;
        }
        if (legacyPath !== null && c.path === legacyPath) {
          const slot = copies.get(info.id) ?? {};
          slot.legacy = c.path;
          copies.set(info.id, slot);
          continue;
        }
        // 路径对不上任何一种布局 ⇒ 目录被人动过（或被别的程序整理过）。
        scan.unexpected.push(c.path);
      }
    });

    // ── 同一个 id 的两份副本：按操作印记裁决 ──────────────────────────────
    for (const [id, slot] of copies) {
      if (slot.current && slot.legacy) {
        const winner = await this.pickCopyByStamp(slot.current, slot.legacy);
        scan.shards.push({ id, path: winner.path, ...(winner.loc === 'legacy' ? { loc: 'legacy' as const } : {}) });
        scan.redundant.push(winner.loserPath);
        continue;
      }
      if (slot.legacy) {
        scan.shards.push({ id, path: slot.legacy, loc: 'legacy' });
        continue;
      }
      if (slot.current) {
        scan.shards.push({ id, path: slot.current });
      }
    }

    // 两份副本并存 = 老设备与新设备都写过这个会话。
    // **不自动删任何一份**（2026-10-26）：两台设备的 Lamport 序号互不可比，
    // 「哪份更晚」只能靠印记判断，而删错那一份就是**不可逆的**内容丢失。
    // 保留两份 + 索引记下读哪一份 ⇒ 正确性有保证，代价只是多占一个文件。
    if (scan.redundant.length > 0) {
      logWarn(
        `[webdav] 云端有 ${scan.redundant.length} 个会话同时存在于新旧两种目录布局中` +
          `（例：${scan.redundant.slice(0, 3).join('、')}）。已按操作印记选一份为准，` +
          '两份都保留（不会自动删除，以免删错那一份造成内容丢失）。'
      );
    }

    return scan;
  }

  /**
   * 同一个会话的两份副本（一份新布局、一份旧布局）里哪一份说了算。
   *
   * ── 判据：操作印记大者胜（与 mergeOpStamped 同一口径）──────────────────
   * 为什么不能「新的那份永远赢」：老版本设备（2026-10-26 之前）写的**就是**旧
   * 路径。若它比新版本设备**更晚**地改了那个会话，它的新内容就在旧路径上。
   * 一律让新路径赢 ⇒ 那个改动被静默吞掉（用户在新设备上永远看不到它）。
   *
   * 为什么不能比「修改时间」：多台设备的墙上时钟不可信（这正是仓库里
   * `opStamp` 存在的理由）。只有印记是全序的。
   *
   * 印记取自**明文头部**（不解密）；老分片没有头部 ⇒ 印记未知 ⇒ 按
   * `compareStampsLoose` 的口径当成「最小」⇒ 有头部的那份赢。
   * 两份都没有印记 ⇒ 平局 ⇒ **新布局赢**（确定性 tiebreak，保证多台设备
   * 扫出来是同一个结果 ⇒ 收敛）。
   */
  private async pickCopyByStamp(
    currentPath: string,
    legacyPath: string
  ): Promise<{ path: string; loc?: 'legacy'; loserPath: string }> {
    const [curHdr, legHdr] = await Promise.all([
      this.readShardHeaderOnly(currentPath),
      this.readShardHeaderOnly(legacyPath),
    ]);
    const cmp = compareStampsLoose(curHdr?.lastOp, legHdr?.lastOp);
    if (cmp >= 0) return { path: currentPath, loserPath: legacyPath };
    return { path: legacyPath, loc: 'legacy', loserPath: currentPath };
  }

  /** 只读一个分片的明文头部（不解密）。读不到 ⇒ undefined。 */
  private async readShardHeaderOnly(path: string): Promise<ShardHeader | undefined> {
    const got = await this.client.get(path);
    if (!got || 'notFound' in got) return undefined;
    const env = parseEnvelope(got.body);
    return env?.hdr;
  }

  /**
   * 该不该现在做「索引 ↔ 实际分片」的全量自检。
   *
   * ── 为什么有间隔，而不是每次上传都查 ──────────────────────────────────
   * 自检要**列目录**（1 + 前缀子目录数 次 PROPFIND），而上传是高频动作
   * （保存一次会话就可能触发一轮）。每次都查 ⇒ 请求数翻十几倍，
   * 用户的云盘（尤其有 750 条 PROPFIND 上限的坚果云）先扛不住。
   *
   * ── 为什么间隔不会让数据更糟 ────────────────────────────────────────
   * 自检抓的是**已经存在**的偏离（索引早就少了条目）。而写 manifest 永远
   * 是在**最新 base 上合并** ⇒ 本轮上传**不会制造**新的偏离 ⇒ 巡检晚一点
   * 发现，数据的处境不变。真正制造偏离的那条路径（索引丢失）由 loadIndex
   * 的重建**当场**兜住，不靠巡检。
   */
  private shouldVerifyIndex(force: boolean): boolean {
    const now = Date.now();
    if (force) {
      this.lastIndexVerifyAt = now;
      return true;
    }
    if (now - this.lastIndexVerifyAt < INDEX_VERIFY_INTERVAL_MS) return false;
    this.lastIndexVerifyAt = now;
    return true;
  }

  /**
   * 上传后的自检：云端索引（manifest）与**实际分片文件**是否一致。
   *
   * 两种偏离都要抓：
   *   · 磁盘上有、索引里没有（orphan）—— **数据丢失方向**：那些会话对所有
   *     设备隐形，且本机水位线可能认为「已上传」而永远不再上行；
   *   · 索引里有、磁盘上没有（ghost）—— 索引指向了不存在的内容，
   *     下载时会被判成「云端已删除」而误删本地副本。
   *
   * 不一致时：**中止本轮**并把「索引不可信」抛给上层（上层会把它显示给用户），
   * 同时尽力把索引修回「磁盘真相」。
   */
  private async verifyIndexMatchesDisk(
    writtenIds: string[],
    groups: TabGroup[],
    watermark: number
  ): Promise<void> {
    const got = await this.client.get(this.p(MANIFEST_PATH));
    if (!got || 'notFound' in got) {
      // 索引刚写完就不见了 —— 但这**不等于**「云端内容坏了」：
      // 另一个设备可能正好在这一刻上传，把索引换成了它自己那份
      // （内容仍然在云端，只是索引换了主人）。这类情况不是「索引不可信」，
      // 不能因此中止整轮同步 —— 那会让「两台设备同时首次同步」这种
      // 正常场景永久互相拖死。
      //
      // 判据：能不能**从磁盘重建**一份索引。能重建 ⇒ 云端内容是好的
      // （重建结果就是真相），只是索引被并发换掉了。
      // 重建不出来 ⇒ 我们**不知道**云端现状 —— 但本轮写入的分片是
      // 我们刚 PUT 成功的（内容是好的），所以这里出声而不是判死。
      // 真正的 fail-closed 发生在**下一轮**的 loadIndex：
      // 那时索引仍然不在、又列不出目录 ⇒ 中止并明确告诉用户。
      try {
        const rebuilt = await this.rebuildManifestFromDisk();
        if (rebuilt) {
          logWarn('[webdav] 云端索引在写入后被换掉（可能是另一台设备同时上传），已从磁盘重建认知。');
          this.rebuiltIndex = rebuilt;
          return;
        }
      } catch (err) {
        logWarn('[webdav] 云端索引在写入后被换掉，且无法从磁盘重建:', err);
      }
      logWarn(
        '[webdav] 云端索引在写入后被换掉且无法重建（可能是另一台设备同时上传）。' +
          '本轮写入的会话文件是好的，但云端索引已不可信，请再同步一次。'
      );
      return;
    }
    const parsed = parseManifest(got.body);
    if (!parsed) {
      throw new Error(
        '云端索引在写入后无法解析，无法确认云端内容是否完整。已中止本轮同步。'
      );
    }

    const scan = await this.scanRemoteShards();
    // 列不出来 ⇒ 做不了「索引 ↔ 实际文件」的全量交叉核对。
    // 这**不是**「索引不可信」的证据（很可能只是这台服务器不支持
    // PROPFIND Depth:1），所以不能因此把整轮同步判死。
    // 退而求其次：确认**本轮写入**的分片确实还在（GET 一下）——
    // 这能抓住「写完就丢」这种最要命的情况。
    // 抓不到的是「索引早就少了条目」，但那种情况下一轮的 loadIndex
    // 会因为「索引不在 + 列不出目录」而中止并出声。
    if (scan.listingFailed) {
      const lost: string[] = [];
      for (const id of writtenIds) {
        // 两条落点都试：新布局写的新路径，老布局写的旧路径。
        // 只查一条 ⇒ 老库上的分片会被误判成「写完就丢」。
        const f = await this.getShardFile(id);
        if (!f) lost.push(id);
      }
      if (lost.length > 0) {
        throw new Error(
          `本轮写入的 ${lost.length} 个会话文件在云端找不到` +
            `（${lost.slice(0, 5).join('、')}${lost.length > 5 ? ' 等' : ''}），已中止本轮同步。`
        );
      }
      logWarn(
        '[webdav] 云端目录无法列出，做不了「索引 ↔ 实际文件」的全量核对；' +
          `已改为确认本轮写入的 ${writtenIds.length} 个会话文件都在。`
      );
      return;
    }
    const diskIds = new Set(scan.shards.map(s => s.id));
    const manifestIds = new Set(parsed.shards.map(s => s.id));
    const orphan = [...diskIds].filter(id => !manifestIds.has(id));
    const ghost = [...manifestIds].filter(id => !diskIds.has(id));
    if (orphan.length === 0 && ghost.length === 0) return;

    // ── 区分两种「不一致」 ────────────────────────────────────────────────
    // (a) 磁盘上有、索引里没有（orphan）：索引漏了内容。
    //     这一种**必须**中止：它正是「某个会话对所有设备隐形」的那个形态。
    // (b) 索引里有、磁盘上没有（ghost）：索引指向了不存在的内容。
    //     这一种**不能**直接中止 —— 极可能是另一台设备刚把索引换成了
    //     它自己那份（它那边的分片还没同步到这台机器的视野里），
    //     或者另一台设备正在上传途中。中止会让两台设备互相拖死。
    //     正确处理：以**磁盘真相**为准重建索引（内容才是数据，索引是派生），
    //     并把这次偏离如实上报。
    if (orphan.length === 0) {
      logWarn(
        `[webdav] 云端索引里有 ${ghost.length} 个磁盘上已不存在的条目` +
          '（可能是另一台设备刚上传了它自己的索引），已按磁盘真相重建索引。'
      );
      try {
        await this.repairIndexFromDisk(groups, watermark);
      } catch (err) {
        logWarn('[webdav] 按磁盘真相重建云端索引失败:', err);
      }
      return;
    }

    // 尽力修复：把索引重建成「磁盘真相」并写回，同时补传那些
    // 「水位线以为已上传、但云端其实没有」的会话。
    let repaired = false;
    try {
      await this.repairIndexFromDisk(groups, watermark);
      repaired = true;
    } catch (err) {
      logWarn('[webdav] 重建云端索引失败（仍会中止本轮同步）:', err);
    }

    throw new Error(
      `云端索引与实际文件不一致（云端有 ${orphan.length} 个会话文件不在索引里，` +
        `索引里有 ${ghost.length} 个已不存在的条目）。` +
        (repaired ? '已重建云端索引。' : '重建云端索引失败。') +
        '已中止本轮同步以免覆盖云端内容，请重新同步一次。'
    );
  }

  /**
   * 上传后自检：索引条目带的印记必须与**分片自己**的印记一致（2026-10-20 D-4）。
   *
   * ── 为什么每轮都要查 ────────────────────────────────────────────────────
   * 索引写失败是**静默**的：服务端返回 2xx 但内容没落盘、或写完又被别的
   * 设备覆盖。索引一旦落后于内容，下一轮的认输预检就会读到**旧**印记 ⇒
   * 裁决反转 ⇒ 用旧内容盖掉刚写上去的新内容。
   * 删除路径上更糟：索引里的旧印记让「墓碑 vs 旧副本」判成「旧副本更新」⇒
   * 墓碑被覆盖 ⇒ **删除被静默撤销 ⇒ 会话复活**。
   *
   * ── 判据 ────────────────────────────────────────────────────────────────
   * 只查本轮**真的写过**的条目（`writtenEntries`）：它们是本轮唯一可能
   * 造成「索引落后」的条目；查全库会把别的设备的写入也拖进本轮，
   * 让一次无关的并发把本轮打成失败。
   *
   * 对不上 ⇒ **中止本轮（fail-closed）**：让上层保留 pending_upload，
   * 下轮重试（重试是幂等的），并把原因如实报给用户。
   */
  private async verifyIndexMatchesShardHeaders(
    writtenEntries: readonly ShardFingerprint[],
    opts?: { tolerateMissingIndex?: boolean; firstSyncInThisRound?: boolean }
  ): Promise<void> {
    if (writtenEntries.length === 0) return;

    const got = await this.client.get(this.p(MANIFEST_PATH));
    if (!got || 'notFound' in got) {
      // 「索引刚写完就不见了」有两种可能：
      //   (a) 索引写入真的失败了（服务端静默丢弃）—— 危险，必须中止；
      //   (b) 另一台设备同时上传，把索引换成了它自己那份 —— 内容是好的，
      //       只是索引换了主人。此时中止会让两台设备互相拖死。
      // 区分办法：看**本轮写进去的分片**还在不在、印记对不对 ——
      // 那才是「本轮写入是否生效」的直接证据。
      //
      // ⚠️ 只有「本轮确实新建了索引」时，(a) 才可能成立。
      // 首轮同步（firstSync）时索引是**刚由本轮新建**的：远端之前根本没有
      // manifest.json，所以「写完读不到」有可能是这台服务器的写-读延迟，
      // 而不是写失败。此时直接判死会让「首次同步」在部分服务器上永久失败。
      const indexWasCreatedNow = opts?.firstSyncInThisRound === true;
      if (opts?.tolerateMissingIndex || indexWasCreatedNow) {
        // 用「本轮写进去的分片能不能读回来」当判据：
        //   · 分片也读不回来 ⇒ 这台服务器的**读路径整体不可用** ⇒
        //     GET 读不到东西不能证明「文件没落盘」⇒ 不判死，只出声。
        //   · 分片读得回来 ⇒ 索引确实不在（真丢 / 被并发换掉）⇒ 按分支处理。
        const unreadable: string[] = [];
        for (const e of writtenEntries) {
          const shard = await this.readRemoteShardState(e.id);
          if (!shard.exists || shard.unreadable) unreadable.push(e.id);
        }
        if (unreadable.length > 0 && unreadable.length === writtenEntries.length) {
          logWarn(
            '[webdav] 云端索引与本轮写入的会话文件都读不回来 —— 这台服务器的读路径' +
              '整体不可用（不是「文件没落盘」）。已跳过本轮写入自检，请检查云盘配置。'
          );
          return;
        }
        if (unreadable.length > 0) {
          throw new Error(
            `本轮写入的 ${unreadable.length} 个会话文件在云端找不到` +
              `（${unreadable.slice(0, 5).join('、')}${unreadable.length > 5 ? ' 等' : ''}），` +
              '已中止本轮同步。'
          );
        }
        logWarn(
          '[webdav] 云端索引在写入后读不到（服务器写-读延迟，或另一台设备同时上传），' +
            '但本轮写入的会话文件都在，印记核对通过。'
        );
        return;
      }
      throw new Error(
        '云端索引在写入后就不见了，无法确认本轮写入是否已生效。已中止本轮同步。'
      );
    }
    const parsed = parseManifest(got.body);
    if (!parsed) {
      throw new Error(
        '云端索引在写入后无法解析，无法确认本轮写入是否已生效。已中止本轮同步。'
      );
    }
    const indexById = new Map<string, ShardFingerprint>(parsed.shards.map(s => [s.id, s]));

    const mismatched: string[] = [];
    for (const entry of writtenEntries) {
      const indexed = indexById.get(entry.id);
      if (!indexed) {
        mismatched.push(entry.id);
        continue;
      }
      const shard = await this.readRemoteShardState(entry.id);
      if (!shard.exists || shard.unreadable) {
        mismatched.push(entry.id);
        continue;
      }
      // 索引带的印记必须与分片自己的印记一致。
      // 印记缺失时（老数据）不比 —— 那是「本来就没有」而不是「写歪了」。
      const indexedStamp = indexed.lastOp;
      const shardStamp = shard.lastOp;
      if (!indexedStamp || !shardStamp) continue;
      if (indexedStamp.d !== shardStamp.d || indexedStamp.s !== shardStamp.s) {
        mismatched.push(entry.id);
      }
    }

    if (mismatched.length === 0) return;
    throw new Error(
      `云端索引与实际内容不一致（${mismatched.length} 个会话的索引印记与分片自身不符：` +
        `${mismatched.slice(0, 5).join('、')}${mismatched.length > 5 ? ' 等' : ''}）。` +
        '已中止本轮同步以免用旧内容覆盖新内容，请重新同步一次。'
    );
  }

  /**
   * 把索引修回「磁盘真相」，并补传缺失的会话。
   *
   * 步骤：
   *   1. 重新扫描 + 读回分片，重建一份 manifest（权威）；
   *   2. 找出「本地水位线认为已上传、但云端其实没有」的会话并补传
   *      （否则它们会被 selectDirty 永远跳过 —— 那是本次要消灭的静默丢失）；
   *   3. 用重建结果整体写回索引。
   */
  private async repairIndexFromDisk(groups: TabGroup[], watermark: number): Promise<void> {
    this.rebuiltIndex = null; // 强制重新扫描，不复用可能过期的缓存
    const rebuilt = await this.rebuildManifestFromDisk();
    if (!rebuilt) return; // 云端一个分片都没有，无从重建

    const missing = selectMissingFromIndex(groups, rebuilt, watermark);
    const writtenEntries: ShardFingerprint[] = [];
    for (const g of missing) {
      const out = await this.writeShard(g.id, encodeGroup(g), { ifNoneMatch: '*' });
      writtenEntries.push({
        id: g.id,
        ...(out.etag ? { etag: out.etag } : {}),
        updatedAt: g.updatedAt || this.now(),
        ...(g.lastOp ? { lastOp: g.lastOp } : {}),
      });
    }

    const merged = new Map<string, ShardFingerprint>(rebuilt.shards.map(s => [s.id, s]));
    for (const e of writtenEntries) merged.set(e.id, e);

    await this.writeManifest(
      () => ({ ...rebuilt, generatedAt: this.now(), shards: [...merged.values()] }),
      rebuilt.encrypted,
      rebuilt.salt
    );
  }

  /**
   * 写 manifest（带乐观锁 + 冲突重试）。
   *
   * `apply` 在**每次尝试**都会被调用，且接收**最新读到的** manifest ——
   * 这是关键：冲突后如果拿旧快照重写，会把对方刚加进来的分片条目抹掉
   * （manifest 是派生数据，条目丢了不会丢会话内容，但会让对端少一次探活命中）。
   *
   * ⚠️ 2026-10-20 修 P0：base 现在可能来自**重建**（远端根本没有 manifest.json）。
   * 这种情况下必须真的写出去 —— 否则「重建出来的索引」永远落不了盘，
   * 恢复态会一直重复（每次探活都重扫一遍云盘），而且云端始终没有索引。
   */
  private async writeManifest(
    apply: (base: Manifest) => Manifest,
    encrypted: boolean,
    salt: string | undefined,
    /**
     * 远端**没有**索引时用来当底稿的 manifest。
     *
     * 场景：索引丢了、我们从分片目录重建了一份（恢复态）。这时远端仍然没有
     * manifest.json，若 base 用「空 manifest」，写回时就会**只带本批条目**
     * —— 云端那些没被本批覆盖的历史分片又会从索引里消失（正是本次要修的 P0）。
     * 所以要把重建出来的那份（= 云端全集）当底稿。
     *
     * ⚠️ 只在「远端确实没有索引」时用它；远端有索引时一律用远端那份
     * （那是并发安全的关键：base 必须是**最新**的远端状态）。
     */
    opts?: { recoveredBase?: Manifest | null }
  ): Promise<void> {
    // 索引就躺在库根下（`TapStack/manifest.json`）⇒ 库根必须先在。
    //
    // 以前这个「库根什么时候被建出来」是**副作用**：分片写的 mkdirp 顺手建的。
    // 于是「一个会话都没有、只写索引」这条路径（首次同步 / 恢复态 / 只同步设置）
    // 在真实服务端上会 409（父目录不存在）—— 宽松的假服务器看不见这个洞。
    // 这里显式建一次（缓存 ⇒ 每个适配器实例只多一次 MKCOL）。
    await this.ensureDir(this.root);
    for (let attempt = 0; attempt < CONFLICT_RETRY_LIMIT; attempt++) {
      // ⚠️ 用 loadIndexForWrite（**不触发恢复**）而不是 loadIndex：
      // 首次同步时 groups/ 目录刚被本轮的分片写出来，若在这里触发一次
      // 「索引丢了 → 重建」，就会在不支持 Depth:1 的服务器上直接挂掉，
      // 而且重建出来的 base 还会把「本轮刚写的分片」当成「云端原有内容」
      // 混进 base，掩盖「远端本来是空的」这个事实。
      // 写索引要的就是「远端现有索引」，没有就是没有。
      const current = await this.loadIndexForWrite();
      const base =
        current?.manifest ??
        opts?.recoveredBase ??
        ({ ...emptyManifest(encrypted, this.now()), ...(salt ? { salt } : {}) } as Manifest);

      const next = apply(base);
      const body = serializeManifest(next);

      // 内容没变就不写（这是「首次全量上传」之后不再周期性重写的关键之一）。
      if (current && serializeManifest(base) === body) return;

      try {
        await this.client.put(this.p(MANIFEST_PATH), body, {
          ...(current?.etag ? { ifMatch: current.etag } : { ifNoneMatch: '*' }),
          contentType: 'application/json; charset=utf-8',
        });
        // 索引已落盘 ⇒ 重建缓存作废（下次直接读远端索引）。
        this.rebuiltIndex = null;
        return;
      } catch (err) {
        const conflict = err instanceof WebDavError && err.isPreconditionFailed;
        if (!conflict || attempt === CONFLICT_RETRY_LIMIT - 1) throw err;
        // 冲突：远端状态已经变了，重建缓存不再可信，作废后下一轮重新读。
        this.rebuiltIndex = null;
        // 下一轮循环会重新读取最新 manifest 再 apply 一次。
      }
    }
  }

  // ── 分片读写 ────────────────────────────────────────────────────────

  /**
   * 确保远端目录存在（**逐级**建，且每级只建一次）。
   *
   * 为什么不用 `client.mkdirp`：mkdirp 每次都把整条链重发一遍 ⇒ 每个会话要
   * 3 次 MKCOL（root / groups / 前缀目录），而其中绝大部分是对已存在目录的
   * 空请求（见 knownDirs 的注释里的实测数字）。这里逐级查缓存 ⇒ 一条链上
   * 每一级**最多建一次**。
   *
   * ⚠️ 参数是**相对 baseUrl 的完整路径**（含库根，例：`TapStack/groups/ab`），
   * 不是相对库根的路径。库根本身也得建：真实服务端在父目录不存在时
   * MKCOL 返回 409、PUT 也返回 409（RFC 4918 §9.3.1 / §9.7）⇒ 少了库根，
   * 第一次写分片就直接失败。
   *
   * （为什么这里容易漏：不少假服务器不建模「父目录必须存在」，MKCOL / PUT
   * 一律成功 ⇒ 少了库根这件事在测试里**完全看不见**。所以守卫里那台假服务器
   * 专门开了 strictParents 来按 RFC 建模。）
   *
   * @param fullPath 相对 baseUrl 的目录路径（例：`TapStack/groups/ab`）
   */
  private async ensureDir(fullPath: string): Promise<void> {
    const segments = fullPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (this.knownDirs.has(acc)) continue;
      // 405（已存在）被 client.mkcol 当成成功 ⇒ 这里可以放心记进缓存。
      await this.client.mkcol(acc);
      this.knownDirs.add(acc);
    }
  }

  /** 忘掉一个目录（服务器上它可能已经被人删了）。 */
  private forgetDir(fullPath: string): void {
    const segments = fullPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      this.knownDirs.delete(acc);
    }
  }

  /** 落盘一个分片的载荷（加密或明文），返回服务端给的 ETag。 */
  private async writeShard(
    id: string,
    payload: Record<string, unknown>,
    opts: { ifMatch?: string; ifNoneMatch?: string; path?: string }
  ): Promise<{ etag: string | null }> {
    const vault = this.vault;
    // ── 2026-10-20 D-4：把印记放进**明文头部**（与密文正文分离）──────────
    // 裁决与读回校验必须能只读头部就拿到印记：
    //   · 裁决（谁赢）要在**解密之前**就能判断远端版本 —— 解密要口令，
    //     而「远端版本」这件事不该依赖「本机有没有口令」；
    //   · 读回校验（写没落盘）同理。
    // 头部里的字段全是 manifest 里本来就有的（id / isDeleted / lastOp / updatedAt），
    // 不新增任何隐私面（见 layout.ts 的 ShardHeader 注释）。
    const header = shardHeaderFromPayload(payload);
    const envelope = vault
      ? makeEncryptedEnvelope(await vault.encrypt(payload), header)
      : makePlainEnvelope(payload, header);

    // ⚠️ **写到哪里**（2026-10-26）：**写回它原来所在的位置**。
    //
    // 远端已经有这个会话时，写它**当前所在的那条路径**（老库就在老路径上）；
    // 远端没有（新会话）时才用新布局的路径。
    //
    // 为什么不是「一律写新路径」：那会在老库里造出**同一个会话的两份**
    // （新的在 1 位目录、旧的留在 2 位目录）⇒ 之后每次列目录都要裁决一次
    // ⇒ 而裁决只认**操作印记** ⇒ 「以本机为准」这种显式覆盖一旦本地那份
    // 的号更小（本地副本本来就旧），**裁决会把老那份判成赢**
    // ⇒ 用户的显式覆盖被**静默撤回**。
    // ⇒ 写回原位 = 每个会话永远只有一份文件 ⇒ 没有裁决 ⇒ 没有静默撤回。
    //
    // 代价：老库因此**不会**自动迁到 1 位布局（它的 2 位目录也不会变空）。
    // 这个代价是**可以接受的**：目录空了也得列一次（成本一样），
    // 而「静默撤回用户刚点的覆盖」是数据级的伤害。
    const path = opts.path ?? this.p(shardPath(id));
    // 目录按需建（见 ensureDir / knownDirs 的注释）：每个前缀目录最多建一次，
    // 不再每个会话重发 3 次 MKCOL。
    // ⚠️ 目录名必须与**要写的路径**同源：两处各算一遍就会在某一次只改一处
    // ⇒ PUT 落到一个算不出来的路径 ⇒ 分片对所有设备隐形。
    const dirFull = path.slice(0, path.lastIndexOf('/'));
    await this.ensureDir(dirFull);
    const putArgs = {
      ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
      ...(opts.ifNoneMatch ? { ifNoneMatch: opts.ifNoneMatch } : {}),
    };
    const body = serializeEnvelope(envelope);
    let out: { etag: string | null };
    try {
      out = await this.client.put(path, body, putArgs);
    } catch (err) {
      // ── 409 = 父目录在服务器上不存在 ──────────────────────────────────
      // 可能是缓存过期（目录被人删了 / 换了服务器），也可能是本来就没建。
      // 两种情况的处理都一样：**忘掉缓存、重建一次、再试一次**。
      //
      // 为什么必须重试而不是直接报错：一次「目录被删」不该让这台机器从此
      // 再也传不上去（那比慢更糟）。重试一次仍失败 ⇒ 真故障，照实抛出。
      if (!isConflictStatus(err)) throw err;
      this.forgetDir(dirFull);
      await this.ensureDir(dirFull);
      out = await this.client.put(path, body, putArgs);
    }
    // ── 服务端不返回 ETag 时，读回一个（2026-10-14 坚果云真机实测）────────
    // 坚果云实测：PUT **响应**不带 ETag，但 GET 带，且该 ETag 可直接用于
    // If-Match（正确 ETag 写 → 204、过期 ETag 写 → 412，真乐观锁成立）。
    //
    // 为什么必须补：manifest 条目里的 etag 是**下一次写这个分片的 If-Match 条件**。
    // 若这里存 null，下次 `existing?.etag` 为 undefined ⇒ 不带条件 ⇒
    // 无条件覆盖 ⇒ 坚果云明明支持乐观锁，我们却在用裸写。
    // 表现是「以为有锁」，比「没有锁」更糟。
    if (out.etag) return out;
    try {
      const readBack = await this.client.stat(path);
      return { etag: readBack.etag };
    } catch {
      // 读不回 ETag 不阻断本轮写入（数据已落盘），只是这次没有乐观锁条件。
      // 认输预检（stamp 比较）仍然有效，它是与服务端能力无关的那一层。
      return { etag: null };
    }
  }

  /**
   * 读一个分片文件：**按索引记的落点优先，找不到再回退另一条路径**（2026-10-26）。
   *
   * ── 为什么必须回退 ────────────────────────────────────────────────────
   * 布局从「前缀 2 位」改成「前缀 1 位」后，2026-10-13 ~ 2026-10-26 之间建的
   * 库，分片全都落在旧路径上。若只读新路径 ⇒ 那些分片对所有设备**隐形**
   * ⇒ 老用户的云端历史看起来像被清空了 ⇒ 不可逆（1.22.0 起无回收站）。
   *
   * ⇒ 回退是「老库继续能用」的保证，不是优化。
   *
   * ── 为什么按「索引的落点」优先，而不是固定「新路径优先」────────────────
   * 同一个会话可能**两份都在**（老版本设备写旧路径、新版本设备写新路径）。
   * 此时索引用 `loc` 记下「哪一份说了算」（按操作印记裁决，见 scanRemoteShards）。
   * 若读的时候不认这个落点，就会出现「按 A 的内容、按 B 的印记裁决」——
   * 那正是静默的数据覆盖（用旧内容盖掉新内容，或反过来）。
   *
   * ⚠️ 代价：一条路径读不到时会多试一次。方向上仍然划算 ——
   * 老库零改造可用 & 裁决与读取永远同源。
   */
  /**
   * 一个分片**可能**存在的落点，按优先级排列（2026-10-26）。
   *
   * 目录布局从 `groups/<id前2位>/` 改成了 `groups/<id前1位>/` ⇒
   * 同一个 id 在老库里可能落在旧目录、在新库里落在新目录。
   * `loc` 来自索引里记的落点：它决定**先试哪条**（裁决与读取必须同源）。
   */
  private shardPathCandidates(id: string, loc?: 'legacy'): string[] {
    const current = this.p(shardPath(id));
    const legacy = legacyPathDiffers(id) ? this.p(legacyShardPath(id)) : null;
    if (loc === 'legacy' && legacy !== null) return [legacy, current];
    return legacy !== null ? [current, legacy] : [current];
  }

  /**
   * 这个落点是不是**旧布局**（`groups/<id前2位>/`）？
   *
   * 索引的 `loc` 字段就是靠它写的 —— 它必须与**文件实际在哪**同源，
   * 否则读方会去读另一个地方（裁决与读取不同源 ⇒ 静默的数据覆盖）。
   */
  private isLegacyLayoutPath(id: string, path: string): boolean {
    return legacyPathDiffers(id) && path === this.p(legacyShardPath(id));
  }

  private async getShardFile(
    id: string,
    loc?: 'legacy'
  ): Promise<{ path: string; body: string; etag: string | null } | null> {
    for (const path of this.shardPathCandidates(id, loc)) {
      const got = await this.client.get(path);
      if (got && !('notFound' in got)) {
        return { path, body: got.body, etag: got.etag ?? null };
      }
    }
    return null;
  }

  /** 读一个分片并解码成会话。返回 null = 文件缺失或不可解析（计入统计，不静默丢）。 */
  private async readShard(
    id: string,
    loc?: 'legacy'
  ): Promise<{ group: TabGroup | null; etag: string | null; header?: ShardHeader }> {
    const file = await this.getShardFile(id, loc);
    // 文件不存在（首次同步的常态）：两条路径都没有。
    if (!file) return { group: null, etag: null };

    const env = parseEnvelope(file.body);
    if (!env) return { group: null, etag: file.etag };

    let payload: unknown;
    if (env.kind === 'encrypted') {
      if (!this.vault) {
        throw new Error('云端分片是加密的，但本机没有口令，无法读取。');
      }
      payload = await this.vault.decrypt(env.enc);
    } else {
      payload = env.plain;
    }
    return {
      group: decodeGroup(payload),
      etag: file.etag,
      ...(env.hdr ? { header: env.hdr } : {}),
    };
  }

  /**
   * 读远端分片的**裁决依据**（2026-10-20 D-4）。
   *
   * ── 纪律：裁决依据必须是**分片自身**，不是索引 ──────────────────────────
   * 索引（manifest）是派生数据，可能与内容脱节：分片写成功而索引写失败时，
   * 索引里的印记是**旧的**。拿旧印记裁决会得出相反的结论：
   *   · 索引旧（远端其实更新）⇒ 误判「本地更新」⇒ 用旧内容盖掉新内容；
   *   · 删除路径上更糟：墓碑被旧副本覆盖 ⇒ **删除被静默撤销 ⇒ 会话复活**。
   * Supabase 侧的对应防线读的是**云端行本身**（`findConcededGroupIds`），
   * 两边必须同口径 —— 判据见 core/remoteAdjudication。
   *
   * 取值顺序：明文头部（hdr）→ 老分片（没有 hdr）则解密正文取印记。
   * 头部存在时**不解密**：快，且不依赖口令。
   */
  private async readRemoteShardState(id: string, loc?: 'legacy'): Promise<RemoteShardState> {
    // 按索引记的落点优先、找不到回退另一条路径（2026-10-26）——
    // 与 readShard 同一口径。裁决的依据必须与下载读的是**同一份**内容，
    // 否则会出现「拿旧路径的印记配新路径的内容」那种反向覆盖。
    const file = await this.getShardFile(id, loc);
    if (!file) return { exists: false, etag: null };

    const env = parseEnvelope(file.body);
    if (!env) {
      // 分片在，但外壳坏了（被截断 / 被改）。它是**不可裁决**的：
      // 既不能证明它更新，也不能证明它更旧。按「内容读不到」处理，
      // 由调用方决定是保守认输还是修复覆盖。
      return { exists: true, etag: file.etag, unreadable: true, path: file.path };
    }

    if (env.hdr?.lastOp) {
      return {
        exists: true,
        etag: file.etag,
        lastOp: env.hdr.lastOp,
        isDeleted: env.hdr.isDeleted === true,
        path: file.path,
      };
    }

    // 老分片（2026-10-20 之前写的，没有头部）：回退到解密正文。
    // 头部只是**加速**与**解耦**，不是新事实来源 —— 内容才是。
    let payload: unknown;
    if (env.kind === 'encrypted') {
      if (!this.vault) {
        throw new Error('云端分片是加密的，但本机没有口令，无法读取。');
      }
      payload = await this.vault.decrypt(env.enc);
    } else {
      payload = env.plain;
    }
    const group = decodeGroup(payload);
    return {
      exists: true,
      etag: file.etag,
      ...(group?.lastOp ? { lastOp: group.lastOp } : {}),
      isDeleted: group?.isDeleted === true,
      path: file.path,
    };
  }

  // ── SyncBackendPort 实现 ────────────────────────────────────────────

  async fetchFingerprints(): Promise<RemoteGroupFingerprint[]> {
    const index = await this.loadIndex();
    if (index.kind === 'empty') return []; // 远端确实还没建库
    await this.unlock(index.manifest);

    return index.manifest.shards.map(s => ({
      id: s.id,
      updatedAt: s.updatedAt,
      etag: s.etag,
      isDeleted: s.isDeleted === true,
      ...(s.lastOp ? { lastOp: s.lastOp } : {}),
    }));
  }

  /**
   * 全量下载会话。失败抛错。
   *
   * ⚠️ 本方法**遇到读不出来的分片就整体抛错**（不返回部分结果）。
   * 那是刻意的：自带存储侧没有「还原率阈值」那类过滤，任何一个分片
   * 读不出来都意味着「我们对云端的内容不完整」，此时给出「少了几条」的
   * 数组比整体中止更危险。
   *
   * **因此 D-6 在这个后端上天然不成立**：读不出来 ⇒ 抛错 ⇒ 整轮中止、
   * 一个字节都不写 ⇒ 云端的数据不可能被自己的下载吃掉。
   * （云端后端才是「静默少读」的那一侧 —— 那里才有 D-6。）
   *
   * 这也是本适配器**不实现** `downloadSkippedGroups()` 的原因：
   * 「本轮跳过任何会话」对它恒为真（它从不返回部分结果），
   * 而「读不出来」的信息已经由这里的抛错如实报出去了。
   */
  async downloadGroups(): Promise<TabGroup[]> {
    const index = await this.loadIndex();
    if (index.kind === 'empty') return [];
    await this.unlock(index.manifest);

    const groups: TabGroup[] = [];
    const unreadable: string[] = [];

    for (const shard of index.manifest.shards) {
      try {
        const { group } = await this.readShard(shard.id, shard.loc);
        if (!group) {
          unreadable.push(shard.id);
          continue;
        }
        groups.push(group);
      } catch (err) {
        // 逐片兜错：一个分片坏掉不该让整轮同步失败（其余会话还能正常同步），
        // 但**必须计数并出声**——静默少读几条等于无声的数据丢失。
        unreadable.push(shard.id);
        void err;
      }
    }

    if (unreadable.length > 0) {
      throw new Error(
        `云端有 ${unreadable.length} 个会话文件无法读取（可能被其他程序改动或口令不符）。` +
          `已中止合并以免把本地对应会话判成「云端已删除」。涉及的会话 id：${unreadable.slice(0, 5).join('、')}` +
          (unreadable.length > 5 ? ' 等' : '')
      );
    }
    return groups;
  }

  /**
   * 只取给定 ids 的那些分片（2026-10-23 第 53 轮）。
   *
   * 自带存储的布局是「一组一个文件」⇒ 按 id 取 = 只读那几个文件。
   * 收益与云端后端同源：全量下载会把**整个库**逐个文件读一遍
   * （100 组 = 100 次请求），而绝大多数分片没变 ⇒
   * 「每轮全量」让流量与库大小成正比。
   *
   * 失败语义与 `downloadGroups()` **逐字一致**：读不出来 ⇒ 抛错中止
   * （自带存储是 fail-closed 的，不存在云端后端那种「静默少读」）。
   */
  async downloadGroupsByIds(ids: string[]): Promise<TabGroup[]> {
    const wanted = new Set(ids);
    if (wanted.size === 0) return [];
    const index = await this.loadIndex();
    if (index.kind === 'empty') return [];
    await this.unlock(index.manifest);

    const groups: TabGroup[] = [];
    const unreadable: string[] = [];

    for (const shard of index.manifest.shards) {
      if (!wanted.has(shard.id)) continue;
      try {
        const { group } = await this.readShard(shard.id, shard.loc);
        if (!group) {
          unreadable.push(shard.id);
          continue;
        }
        groups.push(group);
      } catch (err) {
        unreadable.push(shard.id);
        void err;
      }
    }

    if (unreadable.length > 0) {
      throw new Error(
        `云端有 ${unreadable.length} 个会话文件无法读取（可能被其他程序改动或口令不符）。` +
          `已中止合并以免把本地对应会话判成「云端已删除」。涉及的会话 id：${unreadable.slice(0, 5).join('、')}` +
          (unreadable.length > 5 ? ' 等' : '')
      );
    }
    return groups;
  }

  async uploadGroups(
    groups: TabGroup[],
    opts?: { overwriteRemote?: boolean; suppressFirstSyncFullUpload?: boolean }
  ): Promise<UploadGroupsResult> {
    this.assertWritable();
    const index = await this.loadIndex();
    const vault = await this.unlock(index.kind === 'manifest' ? index.manifest : null);

    const watermark = index.kind === 'manifest' ? await this.loadWatermark() : 0;
    // 「以本地为准」的落点（计划书 §0.3）：首次配置（远端还没有 manifest）
    // 或显式覆盖时全量上行；此后只传 stamp 大于水位的组。
    //
    // ⚠️ 2026-10-18 P1#4：`suppressFirstSyncFullUpload` 会在「远端还没有
    // manifest」时把全量降级为增量。原因是 firstSync 分支只应服务于
    // 「用户已在设置页完成归属决策」的那一次上传；保存新会话触发的自动上传
    // 也会走到这里，若一并全量，等于替用户做了他还没做的决定。
    //
    // 降级后按「只有本地印记、没有远端水位」计算：selectDirty 用 stamp 比较，
    // 无水位时全部通过 ⇒ 本次新增/本机改过的组照常上传，而 firstSync 的
    // 「把历史数据全量搬上云」被跳过。
    //
    // ⚠️ 2026-10-20 修 P0：firstSync 的判据从「manifest 读不到」改成
    // 「**远端确实一个分片都没有**」。索引丢了但分片还在（index.rebuilt）
    // **不是**首次同步 —— 那种情况下必须按增量走，否则就是把本地子集
    // 整体覆盖到云端（那正是本次要消灭的数据丢失）。
    const firstSync = index.kind === 'empty' && !opts?.suppressFirstSyncFullUpload;

    // ── F4：水位线不能把「被索引丢掉」的组当已同步 ──────────────────────
    // 索引是重建出来的 ⇒ 我们对「云端到底有哪些分片」有权威认知。
    // 于是可以揪出这份差异：**本地水位线认为已上传、但云端其实没有**的会话。
    // 那种组会被 selectDirty 永远跳过（stamp ≤ 水位）⇒ 永远补不回去 ⇒ 静默丢失。
    // 这里把它们挑出来强制补传，并如实上报（recoveredIds）。
    const recovered =
      index.kind === 'manifest' && index.rebuilt
        ? selectMissingFromIndex(groups, index.manifest, watermark)
        : [];

    const toUpload =
      firstSync || opts?.overwriteRemote
        ? groups
        : dedupeById([...selectDirty(groups, watermark), ...recovered]);

    const entryById = new Map<string, ShardFingerprint>(
      (index.kind === 'manifest' ? index.manifest.shards : []).map(s => [s.id, s])
    );
    const writtenIds: string[] = [];
    // 本批真正写上远端的条目（只含 PUT 成功的，不含认输跳过的）。
    // manifest 的最终合并发生在 `writeManifest` 的 apply 里（基于最新 base），
    // 而不是这里 —— 否则冲突重试时会用旧快照覆盖对端刚写入的条目（2026-10-14 修 P1）。
    const writtenEntries: ShardFingerprint[] = [];
    let maxSeq = watermark;

    for (const g of toUpload) {
      const existing = entryById.get(g.id);
      const payload = encodeGroup(g);

      // ── 认输预检：依据**分片自身**的印记，不是索引里的（2026-10-20 D-4）──
      // If-Match 只能发现「我读完之后有人改了」，**发现不了「我的版本本来就更旧」**。
      // 后者是真实场景：一台久未同步的设备（水位很旧甚至为 0）打开扩展，
      // 它手里的组 stamp 比云端小，但因为它读到 manifest 后没有任何人再改，
      // 条件写会**成功**——于是用旧内容覆盖掉云端的新版本，静默丢数据。
      //
      // Supabase 侧的对应防线是 `findConcededGroupIds`（utils/supabase/upload.ts），
      // 语义逐字相同：云端 stamp 严格更大 ⇒ 本次认输、不上行，
      // 本地副本交给下一次下载合并物理替换（那条路径有回滚与校验）。
      //
      // ⚠️ 2026-10-20 D-4 修掉的偏差：**判据的来源**。
      // 修复前这里比的是 manifest 条目里抄的 lastOp（**索引**），
      // 而 Supabase 侧比的是**云端行本身**（**内容**）。索引是派生数据，
      // 可能与内容脱节（分片写成功、索引写失败）⇒ 拿旧印记裁决会得出相反的结论：
      //   · 索引旧（远端其实更新）⇒ 误判「本地更新」⇒ 用旧内容盖掉新内容；
      //   · 删除路径上更糟：墓碑被旧副本覆盖 ⇒ 删除被静默撤销 ⇒ 会话复活。
      // 现在改成**读分片、比它自己的印记**（内容优先，判据见 core/remoteAdjudication）。
      //
      // 代价：每个待传会话多一次 GET。这笔钱必须花 ——
      // 少一次 GET 换来的「省流量」，赔的是一次静默的数据覆盖。
      const remote = await this.readRemoteShardState(g.id, existing?.loc);
      const remoteState = resolveRemoteState({
        content:
          remote.exists && !remote.unreadable
            ? { lastOp: remote.lastOp, isDeleted: remote.isDeleted }
            : null,
        index: existing ? { lastOp: existing.lastOp, isDeleted: existing.isDeleted } : null,
      });
      // 覆盖模式（用户明确选了「以本地为准」）**不做**认输预检。
      // Supabase 侧是同一口径：`findConcededGroupIds` 的第一行就是
      // `if (opts.overwrite) return conceded;`（utils/supabase/upload.ts:181）。
      //
      // 为什么：认输的语义是「远端更新，我等下次下载合并被替换」。
      // 在覆盖模式里用户已经**明确决定**「以本地为准」—— 此时认输等于
      // 替用户反悔（他说覆盖，云端那条更新的却没被覆盖）。
      // 两边必须同口径，否则「以本地为准」在两个后端上的结果不同。
      const overwriteMode = opts?.overwriteRemote === true;
      if (!overwriteMode && remote.exists && shouldConcedeToRemote(g, remoteState)) {
        // 认输：不碰远端，本地副本等下次下载合并时被替换。
        // 注意这里**不**记入 writtenEntries —— apply 时以 base（最新远端）为准，
        // 记进去反而会用旧条目覆盖对端的新条目。
        continue;
      }
      if (remote.exists && remote.unreadable) {
        // 分片在但读不出内容：它的印记不可知。索引里有印记就用索引的
        // （可能过期，但比「完全没有依据」强）；索引也没有 ⇒ 只能当它没有印记。
        logWarn(
          `[webdav] 云端会话 ${g.id} 的分片无法解析（可能被截断或改坏），` +
            '本次按「远端印记不可知」处理'
        );
      }

      // ── 这里**不**做「内容哈希没变就跳过」的优化，两个理由 ──────────────
      // 1. 多余的：进到这里的组已经过了 `selectDirty`（stamp > 水位），
      //    上传成功又立刻把水位推到该 stamp，所以下一轮它根本不会被选中。
      // 2. 有害的：这个哈希算的是**明文**哈希，而 manifest 是**明文**存储。
      //    把明文哈希写进明文 manifest，等于给攻击者一个「已知明文确认」的口子
      //    （猜到某个会话名/URL 就能验证猜得对不对），直接削弱端到端加密。
      //    密文哈希又不可用（IV 每次随机 ⇒ 密文每次都不同）。
      const result = await this.putShardResolvingConflict(g, remote, payload);
      if (result.skipped) {
        // 远端版本更新（认输）：保留云端条目，本地副本等下次下载合并时被替换。
        // 同上：不记入，apply 时以最新 base 为准。
        continue;
      }

      writtenIds.push(g.id);
      if (typeof g.lastOp?.s === 'number' && g.lastOp.s > maxSeq) maxSeq = g.lastOp.s;
      writtenEntries.push({
        id: g.id,
        ...(result.etag ? { etag: result.etag } : {}),
        updatedAt: g.updatedAt || this.now(),
        ...(g.lastOp ? { lastOp: g.lastOp } : {}),
        // 落点必须与**文件实际在哪**同源（2026-10-26）：写回老库的旧路径时
        // 记 loc='legacy'，否则索引会说「在新路径」⇒ 读方去读新路径
        // （404 ⇒ 回退才救回来）⇒ 而裁决用的是另一份 ⇒ 静默覆盖。
        ...(this.isLegacyLayoutPath(g.id, result.path) ? { loc: 'legacy' as const } : {}),
      });
    }

    // 索引要不要写：写了分片就要写（否则新分片对所有设备隐形）；
    // 索引是重建出来的也要写（把找回的索引落回云端，恢复态才能结束）。
    const manifestTouched =
      writtenIds.length > 0 || firstSync || (index.kind === 'manifest' && index.rebuilt);
    if (manifestTouched) {
      await this.writeManifest(
        // 以最新 base 为底，只覆盖本批真正写过的条目，其余原样保留。
        // 这是并发安全的关键：重试时 base 里已有对端刚写入的条目，
        // 若用关闭时的旧快照整体覆盖，对端条目会被静默抹掉
        // （文件还在，但 manifest 是真相源 ⇒ 对端会话隐形丢失）。
        //
        // ⚠️ 2026-10-20 修 P0：base 可能是**重建**出来的索引 ——
        // 那种情况下 base 里已经含有云端全部历史分片，合并后写回的索引
        // 是「云端全集 + 本批增量」，**不再**是「本批的子集」。
        base => {
          const merged = new Map<string, ShardFingerprint>(base.shards.map(s => [s.id, s]));
          for (const e of writtenEntries) merged.set(e.id, e);
          return {
            ...base,
            generatedAt: this.now(),
            shards: [...merged.values()],
            // 有口令 ⇒ 这个库是加密态，salt 必须落进索引。
            // 否则下一台设备/下一个进程会按「明文库」重新派生一个**随机 salt**
            // 的密钥，反而解不开本轮写上去的密文。
            // 口径与 uploadSettings 的「把明文库翻成加密态」一致。
            ...(vault ? { encrypted: true, salt: vault.salt } : {}),
          };
        },
        Boolean(vault),
        vault?.salt,
        // 恢复态：远端没有索引，但重建出来的那份 = 云端全集。
        // 把它当底稿 ⇒ 写回的索引是「云端全集 + 本批增量」，
        // 而不是「本批的子集」（后者就是本次要修的那个 P0）。
        {
          recoveredBase:
            index.kind === 'manifest' && index.rebuilt ? index.manifest : null,
        }
      );
    }

    // ── F3：上传后自检「索引条目 ↔ 实际分片」 ───────────────────────────
    // 不一致 = 索引不可信 ⇒ 中止本轮并把原因抛给上层（上层会显示给用户）。
    // 巡检有间隔（见 INDEX_VERIFY_INTERVAL_MS 的理由），但**索引刚被重建过
    // 时必查** —— 那正是「索引曾经坏掉」这条路径。
    if (manifestTouched && this.shouldVerifyIndex(index.kind === 'manifest' && index.rebuilt)) {
      await this.verifyIndexMatchesDisk(writtenIds, groups, watermark);
    }

    // ── D-4：上传后自检「索引条目 ↔ 分片自身的印记」 ────────────────────
    // 索引写失败是**静默**的（服务端返回 2xx 但没落盘，或写完又被别的
    // 设备覆盖）。后果是下一轮预检读到**旧**的索引印记 ⇒ 裁决反转 ⇒
    // 用旧内容盖掉刚写上去的新内容（删除路径上则是墓碑被盖掉、会话复活）。
    // 所以这里在**每轮**上传后核对一次：索引条目带的印记必须与分片
    // 自己的印记一致。对不上 ⇒ 中止本轮（fail-closed），让上层保留
    // pending_upload 并把原因报给用户。
    //
    // ⚠️ 2026-10-20（索引丢失 P0）：索引是**重建**出来的这一轮，
    // 「索引刚写完就不见了」不能直接判死 —— 极可能是另一台设备同时上传、
    // 把索引换成了它自己那份（内容仍在云端，只是索引换了主人）。
    // 那种情况下中止会让「两台设备同时首次同步」永久互相拖死。
    // 正确的判据是「**本轮写进去的条目**还在不在、印记对不对」，
    // 而不是「索引文件还在不在」。所以这里只核对本轮写过的条目。
    if (manifestTouched) {
      await this.verifyIndexMatchesShardHeaders(writtenEntries, {
        tolerateMissingIndex: index.kind === 'manifest' && index.rebuilt,
        firstSyncInThisRound: firstSync,
      });
    }

    if (writtenIds.length > 0 && !opts?.suppressFirstSyncFullUpload) {
      // 水位必须用**写入这一刻**的计数器值，不能复用读取时的旧值 ——
      // 本批上行本身可能推进了计数器（Supabase 侧 upload.ts 的同款注释）。
      //
      // ── 2026-10-18 P1#4 第二半：待决期的上传**不推进水位** ──────────────
      // 待决期只上传「本次改动过的会话」，而那些会话还没得到用户对**归属**的确认。
      // 若这里照旧把水位推到它们的 stamp，等用户到设置页选「合并（推荐）」时，
      // 适配器会因为「远端已经有 manifest」而退化成增量（selectDirty 只挑
      // stamp > 水位的组）⇒ 历史会话永远上不去，而那张选择卡片上明明写着
      // 「把本机 N 个会话上传到云端」。不推进水位 = 下一次非抑制的上传仍会把
      // 本机全部会话走一遍，代价只是那几个组被重复 PUT（幂等，且有认输预检兜底）。
      await this.saveWatermark(maxSeq, await this.peekDeviceSeq());
    }

    if (recovered.length > 0) {
      // 如实上报差异（不静默跳过）：这些会话是**被揪出来补传**的，
      // 说明云端索引曾经与实际内容脱节过。
      logWarn(
        `[webdav] 云端索引曾与实际内容脱节：${recovered.length} 个会话被本机水位线误判为` +
          '「已上传」，已强制补传（ids: ' +
          recovered.map(g => g.id).slice(0, 5).join('、') +
          (recovered.length > 5 ? ' 等' : '') +
          '）。'
      );
    }

    return {
      writtenIds,
      overwroteRemote: opts?.overwriteRemote === true,
      ...(recovered.length > 0 ? { recoveredIds: recovered.map(g => g.id) } : {}),
      ...(index.kind === 'manifest' && index.rebuilt ? { indexRebuilt: true } : {}),
    };
  }

  /**
   * 写一个分片，412 时按组级 LWW 裁决后重试。
   *
   * 裁决规则与 `mergeOpStamped` 逐字一致：stamp 大者整组赢。
   * 放在这里（而不是抛给上层重新走一轮下载合并）的理由：
   * 一次全量下载合并的代价是「拉全部会话 + 解密 + 校验 + 回滚路径」，
   * 而冲突粒度是一个会话 —— 为它付整库的代价不成比例。
   */
  private async putShardResolvingConflict(
    group: TabGroup,
    remote: RemoteShardState,
    payload: Record<string, unknown>
  ): Promise<{ skipped: false; etag: string | null; path: string } | { skipped: true }> {
    // 条件写能力是**显式状态**（探测一次、缓存住；见 conditionalWriteCapability）：
    //   · 支持 ⇒ If-Match / If-None-Match 是真乐观锁：服务端会真的拒绝过期写入，
    //     412 时我们重读分片重裁（这条路径才有意义）。
    //   · 不支持 ⇒ 那些头是**空头支票**（真机实测：dufs 0.46 收到 If-Match
    //     照样 201 写入）。此时唯一的保护是「读-比-写」+ 写后读回自检，
    //     所以**不发**条件头 —— 发了只是让代码看起来像有锁，
    //     而「以为有锁」比「没有锁」更糟（见 probeConditionalWrites 的文档）。
    const conditional = await this.conditionalWriteCapability();
    // 写到哪里：**写回它原来所在的位置**（老库就在老路径上；远端没有才用新路径）。
    // ⇒ 条件写的凭据（ETag）天然属于**要写的那个资源** ⇒ If-Match 成立。
    //
    // ⚠️ 为什么不能「一律写新路径」：那会往**另一条路径**写 ⇒ 条件写的凭据
    //   不属于那个资源 ⇒ 必然 412 ⇒ 落到冲突重试 ⇒ 而重试里会按印记「认输」
    //   ⇒ 「以本机为准」这种**显式覆盖**（本地那份的号本来就更小）被
    //   **静默丢弃**（用户点了覆盖，什么都没发生，也没报错）。
    // ⇒ 写回原位 = 每个会话永远只有一份文件 ⇒ 一次 PUT 就成 ⇒ 没有认输。
    // 详见 writeShard 的注释。
    let writePath = remote.exists && remote.path ? remote.path : this.p(shardPath(group.id));
    let ifMatch = conditional ? remote.etag ?? undefined : undefined;
    // 首次写这个会话时用 If-None-Match:'*'（仅当不存在时创建）。
    // 不带条件会覆盖掉「另一台设备刚创建的同 id 分片」——那正是并发窗口。
    let ifNoneMatch = conditional ? (remote.exists ? undefined : '*') : undefined;


    for (let attempt = 0; attempt < CONFLICT_RETRY_LIMIT; attempt++) {
      try {
        const out = await this.writeShard(group.id, payload, {
          path: writePath,
          ...(ifMatch ? { ifMatch } : {}),
          ...(ifNoneMatch ? { ifNoneMatch } : {}),
        });
        return { skipped: false, etag: out.etag, path: writePath };
      } catch (err) {
        const conflict = err instanceof WebDavError && err.isPreconditionFailed;
        if (!conflict) throw err;
        if (!conditional) {
          // 探测说「服务端不支持条件写」，却真的返回了 412 ⇒ 能力与实测不符。
          // 不当作致命错误（412 本身仍然有效），但要出声：并发窗口比预想的小，
          // 而下面的读回自检是这轮真正的防线。
          logWarn('[webdav] 服务端返回了 412（条件写），与本轮探测结果不一致，继续按重读重裁处理');
        }

        // 冲突：读回远端当前版本，**按分片自己的印记**裁决（不是索引）。
        const latest = await this.readRemoteShardState(group.id);
        const latestState = resolveRemoteState({
          content: latest.exists && !latest.unreadable
            ? { lastOp: latest.lastOp, isDeleted: latest.isDeleted }
            : null,
        });
        if (latest.exists && shouldConcedeToRemote(group, latestState)) {
          return { skipped: true };
        }
        // 本地赢（或对端此刻又删了/读不到）：用刚拿到的 ETag 重试一次。
        // ⚠️ 写回**它此刻所在的位置**（重读时它可能已经换了地方）。
        writePath = latest.exists && latest.path ? latest.path : this.p(shardPath(group.id));
        ifMatch = conditional ? latest.etag ?? undefined : undefined;
        ifNoneMatch = conditional ? (latest.exists ? undefined : '*') : undefined;
      }
    }
    throw new Error(
      `会话「${group.name || group.id}」在云端被反复改动，多次重试仍未写入。` +
        '可能有另一台设备或同步程序正在同时修改它。'
    );
  }

  /**
   * 广播删除意图（跨设备删除的唯一载体）。
   *
   * ── 「广播成功」的定义（2026-10-20 D-5）────────────────────────────────
   * **写完不算成功，读回确认才算。**
   *
   * 修复前：写完分片 + 写完索引就返回成功 → 上层 `clearPendingDeleteIds`
   * 把删除意图从队列里抹掉。但服务端可能「返回 2xx 而内容没落盘」
   * （PUT 被接受却没持久化、被同步客户端改写、索引写成功但分片写失败……），
   * 于是云端那条记录**仍然是活跃的** → 下次下载合并走 `cg && !lg` 分支
   * → **整组在所有设备上复活**。而 1.22.0 起没有回收站，用户连「再删一次」
   * 都得先找到它在哪。
   *
   * 现在：写完墓碑分片后**读回**它，比对「是不是墓碑」+「印记是不是我们要的那个」
   * （判据见 core/remoteAdjudication 的 compareTombstoneReadback，
   * 与 Supabase 侧 verifyTombstoneReadback 同一口径）。
   * 不一致 ⇒ **抛错** ⇒ 上层不会清队列 ⇒ 下一轮重播（重播幂等，
   * 丢掉删除意图不可逆）。
   *
   * 读回不可能时（分片读不到 / 外壳坏了）怎么办：**不消费队列**。
   * 宁可下一轮重播一个幂等的墓碑，也不能把删除意图丢掉。
   */
  async broadcastDeletes(ids: string[]): Promise<DeleteBroadcastResult> {
    this.assertWritable();
    // 自带存储**不做账号闸门**：WebDAV 的库不属于任何账号（库身份是
    // baseUrl | username | rootPath，见 sync-backend/index.ts 的 defaultFactory），
    // 归属由「这台机器的库是谁的」决定，而不是由会话 id 决定。
    // ⇒ 全放行，blockedIds 恒为空。
    if (ids.length === 0) return { broadcastIds: [], blockedIds: [] };
    const index = await this.loadIndex();
    const vault = await this.unlock(index.kind === 'manifest' ? index.manifest : null);
    const entryById = new Map<string, ShardFingerprint>(
      (index.kind === 'manifest' ? index.manifest.shards : []).map(s => [s.id, s])
    );
    // 本批新产生的墓碑条目。最终合并在 apply 里基于最新 base 做，
    // 未触及的条目以 base 为准（与 uploadGroups 同一纪律，见该处注释）。
    const tombstoneEntries: ShardFingerprint[] = [];
    const now = this.now();
    // 条件写能力：服务端不支持时，发 If-Match 只是「看起来有锁」（见
    // conditionalWriteCapability）。墓碑路径上更不能靠它 —— 墓碑写失败
    // 会被下面的读回校验抓住，代价是删除意图延后一轮，不是数据丢失。
    const conditional = await this.conditionalWriteCapability();

    for (const id of ids) {
      const existing = entryById.get(id);
      // 删除意图自带新 stamp 才能在对端赢过旧副本。这里沿用云端已有的 stamp
      // 就会输给「对端离线期间改过、stamp 更大」的活跃副本（与 Supabase 侧
      // markCloudGroupsAsDeleted 的 seq+1 语义一致，见该实现）。
      // 取 max(设备 seq + 1, 云端已知 stamp + 1)：压过另一台设备写过的更大 seq，
      // 否则墓碑反而更小，对端合并时删除输给旧副本而「复活」（2026-10-14 修 P1）。
      const tombstone = encodeTombstone(id, now, await this.nextDeleteStamp(existing?.lastOp));
      // 写到哪里：**写回它原来所在的位置**（老库就在老路径上；远端没有才用新路径）。
      // ⇒ 墓碑**覆盖**那一份文件（而不是另写一份）⇒ 那个会话永远只有一份
      // ⇒ 不会有「两份副本按印记裁决」把墓碑判输的情况。
      // ⇒ 条件写的凭据也天然属于**要写的那个资源**（拿索引里抄的 ETag 去
      //   If-Match 另一条路径必然 412 ⇒ 每次删除广播都失败）。
      const remote = await this.readRemoteShardState(id, existing?.loc);
      const writePath = remote.exists && remote.path ? remote.path : this.p(shardPath(id));
      // ⚠️ 条件写的凭据只能来自**刚刚读到的那个资源**：
      // 索引里抄的 ETag 可能是**旧的**（分片被别的设备改过、或被手动删过）
      // ⇒ 拿它 If-Match 一个**不存在**的资源 ⇒ 按 RFC 9110 必然 412
      // ⇒ 删除广播直接失败 ⇒ **用户的删除意图丢掉**（而且不重试到成功）。
      // ⇒ 远端确实没有这一份 ⇒ 正确的条件是「仅当不存在时创建」。
      const etag = remote.exists ? remote.etag : undefined;
      const out = await this.writeShard(id, tombstone, {
        path: writePath,
        ...(conditional && etag ? { ifMatch: etag } : {}),
        ...(conditional && !etag && !remote.exists ? { ifNoneMatch: '*' } : {}),
      });

      // ── D-5：写完必须读回确认，否则不算「广播成功」 ──────────────────────
      await this.verifyTombstoneReadback(id, tombstone.lastOp, out.etag);

      const entry: ShardFingerprint = {
        id,
        ...(out.etag ? { etag: out.etag } : {}),
        updatedAt: now,
        isDeleted: true,
        ...(tombstone.lastOp ? { lastOp: tombstone.lastOp as { d: string; s: number } } : {}),
        // 落点（2026-10-26）：墓碑覆盖的是**它原来所在的那份文件**
        // ⇒ 老库的墓碑仍在旧路径 ⇒ 索引必须这么记。
        ...(this.isLegacyLayoutPath(id, writePath) ? { loc: 'legacy' as const } : {}),
      };
      const idx = tombstoneEntries.findIndex(e => e.id === id);
      if (idx >= 0) tombstoneEntries[idx] = entry;
      else tombstoneEntries.push(entry);
    }

    await this.writeManifest(
      base => {
        const merged = new Map<string, ShardFingerprint>(base.shards.map(s => [s.id, s]));
        for (const e of tombstoneEntries) merged.set(e.id, e);
        return { ...base, generatedAt: now, shards: [...merged.values()] };
      },
      Boolean(vault),
      vault?.salt,
      // 恢复态：远端没有索引，重建出来的那份 = 云端全集。
      // 不把它当底稿 ⇒ 写回的索引只剩这几条墓碑 ⇒ 其余云端会话全部隐形
      // （这与 uploadGroups 是同一个 P0，只是走的是删除广播这条路）。
      {
        recoveredBase:
          index.kind === 'manifest' && index.rebuilt ? index.manifest : null,
      }
    );

    // 自带存储没有账号闸门 ⇒ 全部广播成功、没有任何一条被挡下。
    return { broadcastIds: [...ids], blockedIds: [] };
  }

  /**
   * 墓碑读回校验（2026-10-20 D-5）。
   *
   * 读回分片，比对「是不是墓碑」+「印记是不是我们要的那个」。
   * 不一致 ⇒ 抛错（调用方据此**不消费**删除队列）。
   *
   * 读回路径的降级顺序：
   *   1. GET 分片 → 读明文头部（hdr）里的 isDeleted / lastOp —— 不用解密；
   *   2. 头部没有（旧分片）⇒ 解密正文取；
   *   3. 两者都读不到 ⇒ 用 ETag 对比（写前的 ETag vs 写后的 ETag）：
   *      变了 ⇒ 至少说明内容被替换过（仍不可信，但有信号）；
   *   4. 连 ETag 都拿不到 ⇒ **无法验证** ⇒ 抛错（不消费队列）。
   *      宁可下一轮重播一个幂等的墓碑，也不能丢掉删除意图。
   */
  private async verifyTombstoneReadback(
    id: string,
    expectedStamp: { d: string; s: number } | undefined,
    writtenEtag: string | null
  ): Promise<void> {
    const remote = await this.readRemoteShardState(id);
    if (remote.exists && !remote.unreadable) {
      const verdict = compareTombstoneReadback(
        { id, ...(expectedStamp ? { lastOp: expectedStamp } : {}) },
        { id, isDeleted: remote.isDeleted === true, ...(remote.lastOp ? { lastOp: remote.lastOp } : {}) }
      );
      if (!verdict.ok) {
        throw new Error(
          `删除广播没有落盘：${verdict.reason ?? '读回内容与期望不一致'}。` +
            '已保留本机的删除意图，下一轮会重试。'
        );
      }
      return;
    }

    // 读不到内容 ⇒ 退到 ETag 比对（弱证据）。
    if (writtenEtag) {
      for (const path of this.shardPathCandidates(id)) {
        try {
          const stat = await this.client.stat(path);
          if (stat.exists && stat.etag && stat.etag === writtenEtag) {
            // ETag 一致：内容没被替换过。仍然不能证明「是墓碑」，
            // 但至少不是「写失败却被当成成功」。
            logWarn(
              `[webdav] 墓碑 ${id} 读不回内容，只能用 ETag 核对（etag=${stat.etag}）。` +
                '已按「写入未被替换」处理'
            );
            return;
          }
        } catch {
          /* 落到下面抛错 */
        }
      }
    }

    throw new Error(
      `删除广播无法确认落盘（会话 ${id} 读回失败或内容不可解析）。` +
        '已保留本机的删除意图，下一轮会重试。'
    );
  }

  /**
   * 删除广播用的 stamp。
   *
   * 必须严格大于该会话已有的 stamp，否则对端合并时删除会输给旧副本而「复活」。
   *
   * ── 2026-10-20 D-7：号必须由**本机 Lamport 时钟**发出 ─────────────────
   *
   * 修复前这里取的是 `max(设备 seq + 1, 云端已知 stamp + 1)`，也就是
   * **「云端那一行的 seq + 1」**。那个数有一个致命性质：它**恰好等于对端设备
   * 下一个自然要发的号**（对端写下一条时也会取 cloudSeq + 1）。
   * 于是两边的 seq **完全相等** —— 而全序的比较在 seq 相等时**退化成比设备 id
   * 的字典序**（见 core/opStamp 的 compareStamps）。也就是说：
   *
   *   「谁赢」不再由**真实因果顺序**决定，而由**设备 id 的字典序**决定。
   *
   * 字典序与因果无关，而且方向是任意的：设备 id 靠后的那台，它的删除**永远赢**；
   * 设备 id 靠前的那台，它的删除**永远输**。后者那一组就在对端**复活**了 ——
   * 云端行明明已经是墓碑，对端却按「本地活跃副本的 stamp 更大/相等且设备 id 更小」
   * 判本地赢，把墓碑覆盖回活跃行（mergeOpStamped 的「云端墓碑 vs 本地活跃」分支）。
   *
   * 【为什么 Supabase 侧早就修对了、这边没有】
   * Supabase 侧的 markCloudGroupsAsDeleted 走的是**本机 tombstoneSeq.nextSeq()**
   * （真 Lamport 取号），并把结果 bumpSeqIfLower 回本机时钟（见 upload.ts 的
   * stamp 分支）。审计说「WebDAV 侧漏了吸收」——复核确认：**Supabase 侧已经是对的**，
   * 漏的只有 WebDAV 侧（它既没取本机新号，也没把 seq 吸收进本机时钟）。
   *
   * 【现在的语义】**先吸收，再取号**
   * 1) 把云端 seq **吸收**进本机时钟（bumpDeviceSeqIfLower）：本机时钟的号位
   *    抬到「不小于云端那一行」。这一步是 Lamport 不变式
   *    「本设备发出的序号必须大于它观察到的任何设备的任何印记」。
   * 2) 向**本机 Lamport 时钟**要一个新号（nextDeviceSeq）—— 这个号因此
   *    **严格大于**云端那一行的 seq，也严格大于本机此前发过的任何号。
   * 3) 最终 seq = max(本机新号, 云端 seq + 1)：
   *    第二项保证**压过**云端那一行（否则墓碑比它要删的那行还小，删除必输）。
   *
   * 【⚠️ 顺序为什么必须是「先吸收后取号」（本条最容易被写错的地方）】
   * 若**先取号、后吸收**，本机号位在那一刻还低于云端 seq，于是：
   *   localSeq = 本机号位 + 1        （远小于云端 seq）
   *   最终 seq = max(localSeq, cloudSeq + 1) = cloudSeq + 1
   *   而吸收把本机时钟抬到了 cloudSeq ⇒ **本机下一个写入拿到的号恰好也是
   *   cloudSeq + 1** —— 与墓碑的 seq **完全相等**。
   * 那就等于把「本条缺陷」在下一笔写入上**重新造了一遍**：两边 seq 相等 ⇒
   * 胜负退化成设备 id 字典序 ⇒ 删除的因果顺序再次丢失。
   * （本机自己那次写入与墓碑同 seq，两者是同一台设备的两笔写入；
   *  字典序在这里是「同设备同 seq ⇒ 平局」，而平局会被判成本地赢，
   *  也就是「墓碑被本机自己后来的写入盖掉」⇒ 删除被静默撤销。）
   * 先吸收再取号 ⇒ 墓碑号 = clock+1，下一笔写入 = clock+2 ⇒ **严格递增**，
   * 两笔永不相等，因果顺序保住了。
   *
   * 【为什么不能拆掉 max 的第二项】
   * 「压过云端旧印记」与「号由本机时钟发出」是两个**不同**的要求：
   * 前者保证这次删除赢，后者保证这次删除的胜负**由因果顺序**决定而不是由设备 id
   * 字典序决定。少了第二项，墓碑可能输给云端那一行（复活）；
   * 少了第一项，胜负由字典序决定（本条的缺陷形态）。两者都要。
   */
  private async nextDeleteStamp(
    cloudLastOp?: { d: string; s: number }
  ): Promise<{ d: string; s: number }> {
    // ── 2026-10-17 修 P0：键名此前是手抄的 'device_id' ─────────────────────
    // 权威键是 LEGACY_KEYS.DEVICE_ID（'tabvaultpro_device_id'），唯一写入方是
    // deviceUtils.getDeviceId()；kvGet 不做键名别名（storageAdapter 直接透传
    // driver.getItem(key)），所以手抄的那个键**全仓从未被写过** ⇒ device 恒为
    // null ⇒ 每一次删除广播都盖上 d:'unknown'。
    //
    // 后果：两台设备都删除时，按 compareStamps（s 相同则比 d 字典序）
    // 得到 "unknown" === "unknown" → 返回 0 → 平局判**本地赢**
    // （opStampMerge.pickByStamp）→ 云端墓碑输给本地活跃副本并被重新上传，
    // **删除在对端设备被静默撤销、会话复活**。1.22.0 起无回收站，不可恢复。
    //
    // 这里引用常量而非再抄一遍字面量，正是为了杜绝同类分叉
    // （storage-kv/keys.ts 的 MIGRATION_SCAN_KEYS 当初就因为手抄漏了
    // DEVICE_SEQ，导致换机后「改什么都存不住」）。
    const device = await this.kv.get<string>(LEGACY_KEYS.DEVICE_ID);
    const cloudSeq = typeof cloudLastOp?.s === 'number' && Number.isFinite(cloudLastOp.s) ? cloudLastOp.s : -1;

    // 1) **先**把云端 seq 吸收进本机时钟 —— Lamport 不变式：
    //    本机此后发出的任何号都严格大于它观察到的这个号。
    //    顺序不能反：先取号后吸收会让墓碑号与「本机下一笔写入」的号相等
    //    （见上面「⚠️ 顺序为什么必须是先吸收后取号」的完整推导）。
    if (cloudSeq >= 0) {
      await this.bumpDeviceSeqIfLower(cloudSeq);
    }
    // 2) 再向本机 Lamport 时钟要一个新号（不是「云端 seq + 1」）：
    //    此时本机时钟已吸收云端号 ⇒ 这个号严格大于云端 seq。
    const localSeq = await this.nextDeviceSeq();
    return {
      // 拿不到设备 id 时仍留 'unknown' 兜底（老存储可能确实没写过），
      // 但生产路径现在能拿到真实 id —— 兜底不再是被常态掩盖的死分支。
      d: typeof device === 'string' && device ? device : 'unknown',
      // 3) 压过云端那一行（否则墓碑比它要删的那行还小，删除必输）。
      s: Math.max(localSeq, cloudSeq + 1),
    };
  }

  async purgeExpiredDeletes(maxAgeDays = 30): Promise<number> {
    this.assertWritable();
    const index = await this.loadIndex();
    if (index.kind === 'empty') return 0;
    const vault = await this.unlock(index.manifest);

    // ── 墙上时钟不可信（2026-10-14 复核时如实记录）────────────────────────
    // manifest 头上写着「多设备时钟不可信」，墓碑的 updatedAt 却是各设备墙上时间。
    // 写墓碑的设备时钟偏慢 ⇒ 墓碑看起来更老 ⇒ 被提前清掉 ⇒ 已删会话在久未同步
    // （离线超过 maxAge）的设备上复活。这个残余风险**修不掉**（没有逻辑时钟），
    // 只能收敛：默认 30 天足够长，复活窗口只影响离线超 30 天的设备，且复活出的
    // 是旧会话（可再删），不是丢数据。曾考虑过加「未来时间戳永不清」的守卫，
    // 但 `t < cutoff` 本来就排除未来时间 —— 守卫永不触发，是死代码，已删掉。
    // 不要在这里加宽松度（如 +7 天 grace）：那只是把阈值挪一下，风险形状不变，
    // 却让「过期墓碑被清理」这条现有测试的语义变模糊。
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const expired = index.manifest.shards.filter(
      s => s.isDeleted === true && Date.parse(s.updatedAt) > 0 && Date.parse(s.updatedAt) < cutoff
    );
    // 恢复态：索引在**云端**并不存在。即使这一轮没有过期墓碑，
    // 也必须把重建出来的索引写回去 —— 否则恢复态永远结束不了，
    // 而任何一条「写索引」路径一旦漏带底稿，就会把云端清空。
    if (expired.length === 0) {
      if (index.kind === 'manifest' && index.rebuilt) {
        await this.persistRebuiltIndex();
      }
      return 0;
    }

    for (const s of expired) {
      // 先删文件再改 manifest：反过来的话，中途失败会留下「manifest 里没有、
      // 文件还在」的孤儿。而孤儿只会占空间，不会影响正确性（manifest 是真相源）。
      //
      // ⚠️ 两条落点都要删（2026-10-26）：目录布局改过，老库的分片可能躺在
      // 旧目录里。只删新路径 ⇒ 旧目录那份变成**隐形分片**（索引里没有、
      // 磁盘上有）⇒ 下一轮重建索引会把它当成「多出来的会话」复活。
      // DELETE 404 视为成功，所以多删一次不花钱。
      for (const path of this.shardPathCandidates(s.id, s.loc)) {
        await this.client.delete(path);
      }
    }

    const expiredIds = new Set(expired.map(s => s.id));
    await this.writeManifest(
      base => ({
        ...base,
        generatedAt: this.now(),
        shards: base.shards.filter(s => !expiredIds.has(s.id)),
      }),
      Boolean(vault),
      vault?.salt,
      // 恢复态：远端没有索引，底稿必须是重建出来的那份（云端全集），
      // 否则 TTL 清理会把索引写成「只剩没被清理的那些」，其余会话隐形。
      {
        recoveredBase:
          index.kind === 'manifest' && index.rebuilt ? index.manifest : null,
      }
    );
    return expired.length;
  }

  /**
   * 把「恢复出来的索引」写回云端（让恢复态结束）。
   *
   * 恢复态本身是**只读认知**：我们知道了云端有什么，但云端**仍然没有索引**。
   * 只要不写回去，这个状态就会一直持续（每一轮探活都要重扫一遍云盘），
   * 而且任何一条「写索引」路径一旦没带上底稿，就会把云端清空。
   *
   * 写回时用 `If-None-Match: *`（只当远端**确实没有**索引时才创建）：
   * 若这期间另一台设备已经建好了索引，412 ⇒ 说明远端现在有索引了 ⇒
   * **放弃写回**（不覆盖对方），让下一轮 loadIndex 走正常路径。
   */
  private async persistRebuiltIndex(): Promise<void> {
    if (!this.rebuiltIndex) return;
    const rebuilt = this.rebuiltIndex;
    await this.writeManifest(
      base => ({ ...base, generatedAt: this.now(), shards: base.shards }),
      rebuilt.encrypted,
      rebuilt.salt,
      { recoveredBase: rebuilt }
    );
  }

  async uploadSettings(settings: UserSettings): Promise<void> {
    this.assertWritable();
    let index = await this.loadIndex();
    const vault = await this.unlock(index.kind === 'manifest' ? index.manifest : null);
    const payload = { v: 1 as const, settings: settings as unknown as Record<string, unknown>, updatedAt: this.now() };
    const envelope = vault
      ? makeEncryptedEnvelope(await vault.encrypt(payload))
      : makePlainEnvelope(payload);
    // ── 加密库的 salt 必须落进 manifest（2026-10-14 修 P2）─────────────────
    // 建库前（manifest 还不存在）就上传设置时，`unlock(null)` 会新建随机 salt 的
    // Vault，加密完若不把 salt 写进 manifest，下次下载时按 manifest 的 salt 派生
    // 出另一个密钥 ⇒ 解不开 ⇒ 设置永久不可读。同理，已有明文库第一次用口令写设置
    // 时，也必须把 manifest 翻成加密态。明文模式（vault 为 null）不碰 manifest。
    const needsSaltFlip =
      vault !== null &&
      (index.kind !== 'manifest' ||
        !index.manifest.encrypted ||
        index.manifest.salt !== vault.salt);
    if (vault && needsSaltFlip) {
      await this.writeManifest(
        base => ({ ...base, generatedAt: this.now(), encrypted: true, salt: vault.salt }),
        true,
        vault.salt,
        // 恢复态：远端没有索引，底稿用重建出来的那份（云端全集），
        // 否则「把库翻成加密态」这一个动作就会把索引写成空的 ——
        // 云端所有会话瞬间隐形。
        {
          recoveredBase:
            index.kind === 'manifest' && index.rebuilt ? index.manifest : null,
        }
      );
      index = await this.loadIndex();
    } else if (index.kind === 'manifest' && index.rebuilt) {
      // 恢复态且这一轮不需要翻加密态 ⇒ 索引仍然只存在于本机内存里。
      // 把它写回云端，恢复态才算结束（否则每一轮都要重扫云盘，
      // 且任何一条写索引路径漏带底稿都会把云端清空）。
      await this.persistRebuiltIndex();
    }
    await this.client.put(this.p(SETTINGS_PATH), serializeEnvelope(envelope));
  }

  async downloadSettings(): Promise<DownloadSettingsResult> {
    const got = await this.client.get(this.p(SETTINGS_PATH));
    // 404/409 都表示「远端还没有这份设置」，是合法的首次状态。
    if (!got || 'notFound' in got) return null;
    const env = parseEnvelope(got.body);
    if (!env) return null;

    let payload: unknown;
    if (env.kind === 'encrypted') {
      if (!this.vault) {
        const index = await this.loadIndex();
        await this.unlock(index.kind === 'manifest' ? index.manifest : null);
      }
      if (!this.vault) return null;
      payload = await this.vault.decrypt(env.enc);
    } else {
      payload = env.plain;
    }
    if (!payload || typeof payload !== 'object') return null;
    const settings = (payload as { settings?: unknown }).settings;
    return settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : null;
  }

  // ── 水位 ────────────────────────────────────────────────────────────

  private async loadWatermark(): Promise<number> {
    try {
      const raw = await this.kv.get<unknown>(this.watermarkKey);
      if (!raw || typeof raw !== 'object') return 0;
      const wm = raw as Partial<SyncWatermark>;
      const seq = Number(wm.seq);
      const deviceSeq = Number(wm.deviceSeq);
      if (!Number.isFinite(seq) || seq < 0) return 0;

      // seq 时钟回退自检（Supabase 侧同款 P0 防线）：用户清本地数据后
      // DEVICE_SEQ 被清零、新会话 seq 从 1 重启，而旧水位还在（比如 5000）
      // ⇒ 新会话永远 `1 > 5000` 为假 ⇒ 永不上云 ⇒ 下次合并被云端旧版覆盖消失。
      const current = await this.peekDeviceSeq();
      if (Number.isFinite(deviceSeq) && current < deviceSeq) return 0;

      return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
    } catch {
      // 读失败按「首次同步」处理（多传一次全量），绝不按 0 之外的语义猜测。
      return 0;
    }
  }

  private async saveWatermark(seq: number, deviceSeq: number): Promise<void> {
    // 写失败抛错：保守方向是下轮全量重传，绝不谎报「已同步」。
    await this.kv.set(this.watermarkKey, { seq, deviceSeq } satisfies SyncWatermark);
  }

  // ── 供上层与测试使用 ────────────────────────────────────────────────

  /** 连同连通性一起自检（配置页的「测试连接」用）。 */
  async checkConnection(): Promise<{
    groups: number;
    encrypted: boolean;
    /**
     * 服务端是否**真的实现**了条件写（If-Match / If-None-Match）。
     *
     * ⚠️ 这个字段不是锦上添花，它是 2026-10-13 真机实测逼出来的（见下）。
     */
    conditionalWrites: boolean;
  }> {
    await this.client.checkConnection();
    const index = await this.loadIndex();
    const conditionalWrites = await this.probeConditionalWrites();
    if (index.kind === 'empty') return { groups: 0, encrypted: false, conditionalWrites };

    let encrypted = false;
    if (index.manifest.encrypted) {
      // 口令必须真的能解开这个库，否则「连接成功」是假象。
      await this.unlock(index.manifest);
      encrypted = true;
    }
    return {
      groups: index.manifest.shards.filter(s => s.isDeleted !== true).length,
      encrypted,
      conditionalWrites,
    };
  }

  /**
   * 探测服务端是否真的实现条件写。
   *
   * ── 为什么必须实测而不是「协议规定了就算数」（2026-10-13 真机实测）─────
   * RFC 4918 / 9110 定义了 `If-Match` 与 412，但**没有任何东西强制实现它**。
   * 真机验证（dufs 0.46，独立实现）结果：
   *   · PUT 响应**不返回 ETag**
   *   · PROPFIND 只返回 getlastmodified，**不返回 getetag**
   *   · `If-Match: "过期值"` → **返回 201 并照样写入**
   *   · `If-None-Match: *`（对已存在资源）→ **返回 201 并照样写入**
   *   · `If-Unmodified-Since`（过去时间）→ **返回 201 并照样写入**
   *
   * 也就是说：在这类服务端上，我原本以为的「乐观锁」**根本不存在**。
   * 而最坏的形态不是「没有锁」，是**以为有锁** —— 代码不做任何提醒，
   * 用户以为有并发保护。所以这里把能力变成**可观测的事实**。
   *
   * ── 探测方法 ────────────────────────────────────────────────────────────
   * 对一个探针文件发一次**必然失败**的条件写（If-Match 给一个不存在的 ETag）：
   *   · 返回 412 → 服务端实现了条件写 ✅
   *   · 返回 2xx → 服务端忽略条件头 ❌
   * 探针文件用完即删，且用固定名字（可重复探测，不会越积越多）。
   *
   * ── 探测失败（网络抖动等）怎么办 ────────────────────────────────────────
   * 返回 false（按「无保护」处理）。方向选择：把「未知」当成「有保护」会让
   * 用户在无保护的情况下被静默；当成「无保护」最坏只是多一条提示。
   */
  async probeConditionalWrites(): Promise<boolean> {
    const probePath = this.p('.tapstack-probe');
    try {
      // 探针文件也在库根下 ⇒ 库根必须先在。否则 PUT 409（父目录不存在），
      // 而这个 catch 会把它吞成「服务端不支持条件写」—— 一个**错误结论**
      // （真机上表现为：刚配好 WebDAV，界面就报「服务端不支持条件写」）。
      await this.ensureDir(this.root);
      await this.client.put(probePath, 'probe', { contentType: 'text/plain' });
      await this.client.put(probePath, 'probe2', {
        ifMatch: '"tapstack-probe-deliberately-stale"',
      });
      // 条件写没被拒绝 ⇒ 服务端忽略 If-Match。
      this.conditionalWrites = false;
      return false;
    } catch (err) {
      if (err instanceof WebDavError && err.isPreconditionFailed) {
        this.conditionalWrites = true;
        return true;
      }
      // 「没授权」必须与「服务端不支持条件写」区分开（2026-10-14补 P1 时加）。
      // 权限预检抛的是 status 0 + 权限文案；若不在这里拦一道，它会被下面的
      // 兜底吞成 `false`，于是「浏览器没给这个域名的权限」会被如实上报成
      // 「你的服务端不支持条件写」——一个会让用户去检查服务器配置的**错误结论**。
      // 而真实原因只需要点一次「测试连接」授权就能解决。
      if (err instanceof WebDavError && err.isPermissionDenied) throw err;
      this.conditionalWrites = false;
      return false;
    } finally {
      // 探针文件不该留在用户目录里。删除失败不抛错（这只是个探针）。
      try {
        await this.client.delete(probePath);
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 本轮的条件写能力（**显式状态**，探测一次、缓存住）。
   *
   * ── 为什么必须是状态而不是每次现探 ────────────────────────────────────────
   * 裁决策略要在「发不发 If-Match」上分叉，而这个判断必须**每轮一致**：
   * 同一轮里先按「支持」发、后按「不支持」不发，等于自己跟自己打架，
   * 412 重试路径也就失去了意义。
   *
   * ── 探测失败 ⇒ 按「不支持」处理（保守方向）─────────────────────────────
   * 探测本身是网络操作，可能失败。失败时**不能**假设「有保护」：
   * 假设有 ⇒ 服务端其实不认 If-Match，我们却按「有锁」行事 ⇒ 静默覆盖。
   * 假设没有 ⇒ 我们改走「读-比-写 + 写后读回」，慢一点但**不会撒谎**。
   */
  private async conditionalWriteCapability(): Promise<boolean> {
    if (this.conditionalWrites !== null) return this.conditionalWrites;
    try {
      return await this.probeConditionalWrites();
    } catch {
      // 探测失败（如权限预检）⇒ 按「不支持」处理：慢，但安全。
      this.conditionalWrites = false;
      return false;
    }
  }

  /** 删除前的熔断检查（上层在真正执行删除前调用）。 */
  async canDelete(totalBefore: number, deleteCount: number): Promise<void> {
    const verdict = checkDeleteFailsafe(totalBefore, deleteCount);
    if (!verdict.allowed) throw new Error(verdict.reason ?? '删除数量超过安全阈值');
  }
}

// ── 纯函数辅助 ─────────────────────────────────────────────────────────

function normalizeRoot(rootPath: string | undefined): string {
  const r = String(rootPath ?? 'TapStack').trim().replace(/^\/+|\/+$/g, '');
  if (!r) return '';
  for (const seg of r.split('/')) {
    if (seg === '.' || seg === '..') {
      throw new Error(`同步目录不合法（含 . 或 .. 段）：${rootPath}`);
    }
  }
  return r;
}

/** 选出水位之后的脏组。无印记的组一律上行（「不知道」不能当成「已同步」）。 */
function selectDirty(groups: TabGroup[], watermark: number): TabGroup[] {
  return groups.filter(g => {
    const s = g?.lastOp?.s;
    if (typeof s !== 'number') return true;
    return s > watermark;
  });
}

/**
 * 找出「本地水位线认为已上传、但云端索引里没有」的会话（F4）。
 *
 * ── 这份差异意味着什么 ──────────────────────────────────────────────────
 * 水位线是「本机认为自己已经传上去了」的记录。索引是「云端现在有什么」的记录。
 * 两者对不上，只能说明**水位线骗了我们** —— 而被 selectDirty 跳过的组
 * 永远不会自己回来（stamp ≤ 水位 ⇒ 永远不脏）。
 *
 * 真实场景：云端索引曾被整体覆盖成某台设备的子集（本次修的 P0），
 * 另一台设备的水位线却仍记着「这些会话我传过了」⇒ 那些会话永远补不回去。
 *
 * ── 为什么只在「索引是重建出来的」时才算这份差异 ──────────────────────
   * 索引在的时候，它就是云端的真相，我们没有理由怀疑它；
 * 而「索引刚被重建」恰恰是我们**确知**云端分片集合的唯一时刻。
 */
function selectMissingFromIndex(
  groups: TabGroup[],
  manifest: Manifest,
  watermark: number
): TabGroup[] {
  const ids = new Set(manifest.shards.map(s => s.id));
  return groups.filter(g => {
    const s = g?.lastOp?.s;
    // 没有印记的组本来就「永远算脏」，不属于这份差异。
    if (typeof s !== 'number') return false;
    // 比水位新的组本来就会被上传，也不属于这份差异。
    if (s > watermark) return false;
    return !ids.has(g.id);
  });
}

/** 按 id 去重（保留先出现的那个）。 */
function dedupeById(groups: TabGroup[]): TabGroup[] {
  const seen = new Set<string>();
  const out: TabGroup[] = [];
  for (const g of groups) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}

/**
 * 有限并发地跑一批任务。
 *
 * 任何一个任务抛错都会让整批失败（调用方需要 fail-closed，不能吞掉）。
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** stamp 全序比较。委托给 core/opStamp，避免口径漂移（见该函数注释）。 */

/** 稳定短哈希（FNV-1a，32 位十六进制）。只用于生成 KV 键名，不用于安全用途。 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { MANIFEST_VERSION };

