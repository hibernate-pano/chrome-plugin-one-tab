/**
 * WebDAV 后端的远端文件布局与编解码（2026-10-13，阶段 1）。
 *
 * ── 布局（决策依据见 docs/webdav-selfhost-sync-plan.md §4.1）──────────────
 * ```
 * {用户配置的目录}/
 *   manifest.json                  ← 清单：版本、各分片指纹、加密元信息（**明文**）
 *   groups/<id前2位>/<id>.json     ← 每个会话一个文件（**内容加密**）
 *   settings.json                  ← 用户设置（加密）
 * ```
 *
 * ── 为什么每个会话一个文件，而不是「全部塞进一个 JSON」─────────────────
 * 1. **增量**：改一个会话只 PUT 一个文件。单文件方案下改个名字也要重传整库
 *    （Floccus 的 WebDAV 适配器就是单文件，每次同步都是全量 GET + 全量 PUT）。
 * 2. **冲突粒度**：单文件时两台设备改**不同**会话也会互相冲突；
 *    分片后冲突面收敛到「同一个会话」——而这恰好与 TapStack 既有的
 *    **组级 LWW 整组覆盖**语义（opStampMerge.ts）完全对齐，不引入新语义。
 *
 * ── 为什么 groups/ 要按前两位分子目录 ────────────────────────────────────
 * 坚果云对单次 PROPFIND 有 750 条上限（官方文档），且明确警告「未实现按分页
 * 多次加载会出现文件同步不完整」。分子目录把单个目录的条目数摊薄，
 * 让「列目录」这条路在会话数增长时仍然是安全的。
 *
 * ── 为什么 manifest 明文、内容加密 ──────────────────────────────────────
 * 探活（判断「远端有没有变」）必须能读出每个分片的 ETag / 修改时间，
 * 否则每次同步都得把所有分片下载一遍 —— 那等于取消了增量。
 * 因此 manifest 里放**元信息**（不含任何标签页内容），分片文件里放**密文**。
 * 明文 manifest 泄露的信息是「有几个会话、各自何时改过、id 是什么」，
 * **不泄露**会话名、标签 URL、标签标题。
 *
 *   ⚠️ 这个取舍必须写进隐私说明：选「自带存储」时，
 *   云盘上能看到会话数量与修改时间（不是内容）。
 *
 * ── manifest 是什么、不是什么 ───────────────────────────────────────────
 * 它是**派生数据**：全部信息都能通过列出 groups/ 目录重建。
 * 因此它损坏/丢失**不是数据丢失**，而是退化成「一次全量扫描」——
 * **前提是有人真的实现了那次扫描**。
 *
 * ⚠️ 2026-10-20 修 P0 前的现实：这句话是**假的**。
 * 传输层当时只有 Depth:0（stat 一个已知路径），没有列目录的能力；
 * 于是「manifest 不存在」被当成了「远端是空库」，一次全量上传把云端
 * 索引整体换成本机的子集 —— 那些没被覆盖到的分片文件仍在磁盘上，
 * 却对所有设备隐形（manifest 是真相源），水位线还会让它们永远不再上行。
 * 现在这条承诺由 `WebDavClient.listDir`（Depth:1 PROPFIND）与
 * `WebDavBackendAdapter.rebuildManifestFromDisk` 兑现（见 adapter 的
 * 「索引丢了 ≠ 远端空了」一节）。
 */
import type { TabGroup } from '@/types/tab';
import type { EncryptedPayload } from '../crypto';

/** 当前 manifest 格式版本。解析到更高版本时拒绝，避免用旧代码读新格式。 */
export const MANIFEST_VERSION = 1;

export const MANIFEST_PATH = 'manifest.json';
export const GROUPS_DIR = 'groups';
export const SETTINGS_PATH = 'settings.json';

/** manifest 里单个分片的指纹（**明文**，见文件头「为什么 manifest 明文」）。 */
export interface ShardFingerprint {
  /** 会话 id（= 文件名去掉 .json）。 */
  id: string;
  /** 远端 ETag（乐观锁用；服务端不返回时缺省）。 */
  etag?: string;
  /** 该会话的最后修改时刻（ISO）。探活的时间戳判据依赖它，必填。 */
  updatedAt: string;
  /** 是否处于「已删除」状态（墓碑分片）。 */
  isDeleted?: boolean;
  /** 操作印记（写入者），与 mergeOpStamped 的约定一致。 */
  lastOp?: { d: string; s: number };
}

export interface Manifest {
  v: typeof MANIFEST_VERSION;
  /** 生成时刻（ISO）。仅用于诊断展示，不作为判定依据（多设备时钟不可信）。 */
  generatedAt: string;
  /** 加密是否启用。false 时分片是明文 JSON（用户选了「不加密」）。 */
  encrypted: boolean;
  /**
   * 本库的 PBKDF2 salt（base64）。仅 `encrypted: true` 时有值。
   *
   * ── 为什么 salt 放在**明文**的 manifest 里 ─────────────────────────────
   * salt 不是秘密（它的作用是防跨库预计算，不是保密），且必须能被读到 ——
   * 否则每次同步都无法重新派生密钥。真正要保密的是口令与 IV，前者只在内存，
   * 后者随密文一起存在分片文件里。
   *
   * 让 salt 与密文分离存放的另一个好处：换口令时只需重写分片（换 salt + 重加密），
   * 不必让 manifest 参与解密链路。
   */
  salt?: string;
  shards: ShardFingerprint[];
}

/**
 * 会话 id → 分片路径。
 *
 * 用 id 的**前两位**做一级子目录。id 是 UUID（含十六进制与连字符），
 * 必须先做字符白名单校验：这个值会被拼进 URL，
 * 而 `encodePathSegments` 只能拦住 `.` 与 `..`，拦不住其他奇怪字符。
 */
export function shardPath(id: string): string {
  assertSafeId(id);
  const prefix = id.slice(0, 2);
  return `${GROUPS_DIR}/${prefix}/${id}.json`;
}

/**
 * 看一个文件名「像不像分片」，以及像的话它是不是一个**合法**的会话 id。
 *
 * ── 为什么把「不是分片」与「是分片但 id 非法」分开 ───────────────────────
 * 这两种情况在「重建索引」时的处理方式**完全不同**：
 *   · 不是分片（比如用户自己放进去的 `notes.txt`）→ 忽略即可；
 *   · 是分片但 id 非法（`a b.json`、`.json`、超长名…）→ **必须报错**。
 *     把它当「不是分片」忽略掉，等于让一个真实存在（可能装着会话内容）
 *     的文件对所有设备隐形 —— 正是本次要消灭的那类静默丢失。
 *     把它当合法分片收进索引，则会拼出错误的远端路径。
 * 所以这里返回「像不像 + id 是什么」两段信息，由调用方决定怎么判。
 */
export interface ShardFileNameInfo {
  /** 文件名是否像分片（以 `.json` 结尾）。 */
  looksLikeShard: boolean;
  /** 合法会话 id。`looksLikeShard` 为 false 或 id 非法时为 null。 */
  id: string | null;
}

export function inspectShardFileName(name: string): ShardFileNameInfo {
  if (!name.endsWith('.json')) return { looksLikeShard: false, id: null };
  const id = name.slice(0, -'.json'.length);
  try {
    assertSafeId(id);
  } catch {
    return { looksLikeShard: true, id: null };
  }
  return { looksLikeShard: true, id };
}

/**
 * 校验会话 id 可用于路径拼接。
 *
 * 白名单而不是黑名单：只允许 `[A-Za-z0-9_-]`。
 * 现有 id 是 `crypto.randomUUID()` 生成的 UUID（该字符集内），
 * 而导入路径（OneTab / JSON 备份）也复用同一生成器，因此不会误伤。
 * 拒绝而不是静默清洗：id 异常意味着上游数据有问题，静默改写会让
 * 「同一个会话在两台设备上算出不同文件名」——那是同步分裂，比报错糟得多。
 */
export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`会话 id 不合法，拒绝拼进远端路径：${JSON.stringify(id)}`);
  }
}

/** settings 文件的载荷（加密前）。 */
export interface SettingsFile {
  v: 1;
  settings: Record<string, unknown>;
  updatedAt: string;
  lastOp?: { d: string; s: number };
}

/**
 * 分片文件的**明文头部**（2026-10-20 D-4）。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────
 * 裁决（谁赢谁输）必须依据**分片自身**的印记，而不是索引（manifest）里抄的
 * 那一行。索引可能与内容脱节：分片写成功而索引写失败（网络抖动、进程被杀、
 * 服务端「返回 2xx 但没落盘」）时，索引里的印记是**旧的**。
 * 拿旧印记做裁决 ⇒ 把「远端更新」误判成「本地更新」⇒ 用旧内容盖掉新内容；
 * 删除路径上更糟：墓碑被旧副本覆盖 ⇒ **删除被静默撤销、会话复活**。
 *
 * ── 为什么头部能放在密文之外 ──────────────────────────────────────────────
 * 外壳（`{v, enc|plain}`）本来就是**明文 JSON**，密文只在 `enc.data` 里
 * （salt 也在明文外壳里，因为它是密钥派生参数、不是秘密）。
 * 所以头部与密文正文天然可以分离：头部在明文区，正文在密文区。
 *
 * ── 隐私边界没有变 ────────────────────────────────────────────────────────
 * 头部里只有 `id` / `isDeleted` / `lastOp`（设备号 + 序号）/ `updatedAt` ——
 * 这些**manifest（明文）里本来就有**（每个分片一行同样的字段）。
 * 也就是说：头部没有泄露 manifest 之外的新信息类别，
 * 仍然**不泄露**会话名、标签 URL、标签标题。
 * 隐私说明里「云盘上能看到会话数量与修改时间」那句仍然成立且不需要改写。
 *
 * ── 老分片怎么办 ──────────────────────────────────────────────────────────
 * 老分片没有头部 ⇒ `hdr` 缺省 ⇒ 读方回退到「解密正文取印记」。
 * 头部是**可选增强**，不是新格式的硬要求：v1 外壳的解析规则
 * （`enc` 与 `plain` 恰好有一个）保持不变，老版本客户端读新分片也不受影响
 * （它们只认 `enc`/`plain`，会忽略多出来的 `hdr`）。
 */
export interface ShardHeader {
  /** 会话 id（= 文件名去掉 .json）。 */
  id: string;
  /** 是否是墓碑（已删除）。 */
  isDeleted?: boolean;
  /** 操作印记 —— 裁决的唯一依据。 */
  lastOp?: { d: string; s: number };
  /** 内容修改时刻（ISO）。 */
  updatedAt?: string;
}

/** 分片文件与设置文件的落盘外壳。 */
export interface SecureFileEnvelope {
  v: 1;
  /** 密文载荷。`encrypted: true` 时存在。 */
  enc?: EncryptedPayload;
  /**
   * 明文载荷。`encrypted: false` 时存在（用户显式选择了「不加密」）。
   *
   * ── 为什么两种形态共用一个外壳而不是各自独立格式 ──────────────────────
   * 读取方必须能只看外壳就判断「这是哪种」，否则就得靠「先试解密、失败再当明文」
   * 这种猜测式解析 —— 而那会把「口令输错」与「文件本来就是明文」混成同一件事，
   * 用户会得到「口令错误」提示却怎么改都不对。
   *
   * 只有 `enc` 与 `plain` **恰好有一个**是合法的：
   * 两个都有 / 都没有 ⇒ 解析失败（见 parseEnvelope）。
   */
  plain?: unknown;
  /**
   * 明文头部（2026-10-20 D-4）。**可选**：老分片没有它。
   * 与密文正文分离 ⇒ 裁决与读回校验不必先解密。
   */
  hdr?: ShardHeader;
}

export function makeEncryptedEnvelope(
  enc: EncryptedPayload,
  hdr?: ShardHeader
): SecureFileEnvelope {
  return { v: 1, enc, ...(hdr ? { hdr } : {}) };
}

export function makePlainEnvelope(plain: unknown, hdr?: ShardHeader): SecureFileEnvelope {
  return { v: 1, plain, ...(hdr ? { hdr } : {}) };
}

/**
 * 从分片载荷（会话 / 墓碑）生成明文头部。
 *
 * 头部只抄**已经在载荷里**的字段 —— 它是索引的复制品，不是新数据源。
 */
export function shardHeaderFromPayload(payload: Record<string, unknown>): ShardHeader {
  const id = typeof payload.id === 'string' ? payload.id : '';
  return {
    id,
    ...(payload.isDeleted === true ? { isDeleted: true } : {}),
    ...(isStamp(payload.lastOp) ? { lastOp: payload.lastOp } : {}),
    ...(typeof payload.updatedAt === 'string' ? { updatedAt: payload.updatedAt } : {}),
  };
}

/** 解析外壳里的头部。形状不对就当没有（旧分片走「解密正文」的回退路径）。 */
function parseShardHeader(v: unknown): ShardHeader | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return undefined;
  return {
    id: o.id,
    ...(o.isDeleted === true ? { isDeleted: true } : {}),
    ...(isStamp(o.lastOp) ? { lastOp: o.lastOp } : {}),
    ...(typeof o.updatedAt === 'string' ? { updatedAt: o.updatedAt } : {}),
  };
}

/**
 * 解析落盘外壳。
 *
 * 返回 `{ kind: 'encrypted', enc, hdr? }` 或 `{ kind: 'plain', plain, hdr? }`；
 * 无法解析（JSON 坏 / 版本不符 / enc 与 plain 同时有或同时无）→ **null**。
 *
 * 与 `parseManifest` 同一条纪律：**null 表示「不可用」，不表示「空」**。
 * 把坏文件当成空会话会让对端把这一条会话合并成「已被删除」。
 *
 * `hdr` 是**可选**的（2026-10-20 D-4）：老分片没有头部 ⇒ 读方回退到
 * 「解密正文取印记」。头部的缺失**不**让外壳变成不可用。
 */
export function parseEnvelope(
  text: string
):
  | { kind: 'encrypted'; enc: EncryptedPayload; hdr?: ShardHeader }
  | { kind: 'plain'; plain: unknown; hdr?: ShardHeader }
  | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;

  const hasEnc = o.enc !== undefined && o.enc !== null;
  const hasPlain = o.plain !== undefined;
  if (hasEnc === hasPlain) return null; // 恰好一个才合法

  const hdr = parseShardHeader(o.hdr);

  if (hasEnc) {
    const enc = o.enc as Record<string, unknown>;
    if (enc.v !== 1 || typeof enc.salt !== 'string' || typeof enc.data !== 'string') return null;
    return { kind: 'encrypted', enc: enc as unknown as EncryptedPayload, ...(hdr ? { hdr } : {}) };
  }
  return { kind: 'plain', plain: o.plain, ...(hdr ? { hdr } : {}) };
}

export function serializeEnvelope(env: SecureFileEnvelope): string {
  return JSON.stringify(env, null, 2);
}

/**
 * 会话 → 落盘载荷。
 *
 * 刻意**不做字段裁剪**：写出去的就是内存里的形状（去掉了纯 UI 态字段）。
 * 这里唯一的取舍是丢掉 `unopenable`（types/tab.ts 明写「本设备的判断，
 * 不上云」——换一台设备同一个 URL 可能能打开，把它传出去会污染对端）。
 *
 * ── 2026-10-20 审计 A-10：`displayOrder` 不再进分片 ───────────────────────
 * 它曾被写进分片、又被 `decodeGroup` 读回来，而**没有任何东西读它来排序**
 * （列表排序一律按 `createdAt` 倒序；会话组级拖拽排序早已下线）。
 * 更糟的是形状不一致：Supabase 侧从不上传这个字段（数据库里也没有
 * `display_order` 列）⇒ 同一份数据在两条后端路径上解出来的形状不同。
 * 现在两条后端的会话形状对齐：**都不带** `displayOrder`。
 *
 * ⚠️ 老分片（已经写上云盘的）里可能还留着这个键：解码时它被**忽略**
 * （多余字段无害），不会让任何一条会话读不出来。
 */
export function encodeGroup(group: TabGroup): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    isLocked: group.isLocked,
    ...(group.lastOp === undefined ? {} : { lastOp: group.lastOp }),
    tabs: group.tabs.map(t => ({
      id: t.id,
      url: t.url,
      title: t.title,
      ...(t.favicon === undefined ? {} : { favicon: t.favicon }),
      createdAt: t.createdAt,
      lastAccessed: t.lastAccessed,
      pinned: t.pinned ?? false,
      ...(t.lastOp === undefined ? {} : { lastOp: t.lastOp }),
    })),
  };
}

/**
 * 落盘载荷 → 会话。
 *
 * **宽容解析的必要性**：云盘上的文件可能被用户手动编辑过、被同步客户端截断过、
 * 或被旧版本扩展写过。这里对每个字段做类型校验并回落到安全默认，
 * 但**绝不**凭空造数据：
 *   · 缺 id / 非法 id → 返回 null（该分片跳过，不是整个下载失败）
 *   · tabs 不是数组 → 视为空数组并保留该会话（会话本身丢失比标签少更糟）
 * 返回 null 的分片会被上层计入「无法解析」并**明确报给用户**，
 * 不允许静默丢弃（无回收站模型下静默丢弃 = 数据消失且无人知道）。
 */
export function decodeGroup(raw: unknown): TabGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const id = typeof o.id === 'string' ? o.id : '';
  try {
    assertSafeId(id);
  } catch {
    return null;
  }

  // 墓碑：删除广播的载体。它必须能被解码成一条「已删除的会话」而不是被丢弃——
  // mergeOpStamped 靠 `cloud.isDeleted === true` 判断「云端要我删掉这条」，
  // 把它当垃圾过滤掉等于删除意图从未传达（本地副本永不消失）。
  if (o.isDeleted === true) {
    return {
      id,
      name: '',
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date(0).toISOString(),
      isLocked: false,
      isDeleted: true,
      ...(typeof o.deletedAt === 'string' ? { deletedAt: o.deletedAt } : {}),
      ...(isStamp(o.lastOp) ? { lastOp: o.lastOp } : {}),
      tabs: [],
    };
  }

  const tabsRaw = Array.isArray(o.tabs) ? o.tabs : [];
  const tabs = tabsRaw
    .map(t => {
      if (!t || typeof t !== 'object') return null;
      const tab = t as Record<string, unknown>;
      if (typeof tab.url !== 'string' || tab.url.length === 0) return null;
      return {
        id: typeof tab.id === 'string' && tab.id ? tab.id : `${id}-${Math.random().toString(36).slice(2, 10)}`,
        url: tab.url,
        title: typeof tab.title === 'string' ? tab.title : '',
        ...(typeof tab.favicon === 'string' ? { favicon: tab.favicon } : {}),
        createdAt: typeof tab.createdAt === 'string' ? tab.createdAt : new Date(0).toISOString(),
        lastAccessed: typeof tab.lastAccessed === 'string' ? tab.lastAccessed : new Date(0).toISOString(),
        pinned: tab.pinned === true,
        ...(isStamp(tab.lastOp) ? { lastOp: tab.lastOp } : {}),
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  return {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : 'Untitled',
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date(0).toISOString(),
    isLocked: o.isLocked === true,
    // ⚠️ `displayOrder` 不再被解出来（2026-10-20 审计 A-10）：它从来没有读取方，
    // 留着它只会让 WebDAV 侧解出来的形状与 Supabase 侧不一致。老分片里若还留着
    // 这个键，它被**忽略**（多余字段无害）。
    ...(isStamp(o.lastOp) ? { lastOp: o.lastOp } : {}),
    tabs,
  };
}

function isStamp(v: unknown): v is { d: string; s: number } {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { d?: unknown }).d === 'string' &&
    typeof (v as { s?: unknown }).s === 'number'
  );
}

/**
 * 生成墓碑载荷。
 *
 * 删除在 WebDAV 侧是**覆盖同一个分片文件**（而不是删文件）：
 * 删文件会让对端无法区分「这条被删了」与「这条我还没同步过」，
 * 后者会被合并成「本地新增 → 推回云端」——删除被静默撤销。
 * 用墓碑覆盖则保留了 stamp，让 mergeOpStamped 能按全序裁决
 * （云端墓碑 vs 本地更新 → 本地赢；本地更旧 → 服从删除）。
 */
export function encodeTombstone(
  id: string,
  deletedAt: string,
  lastOp?: { d: string; s: number }
): Record<string, unknown> & { lastOp?: { d: string; s: number } } {
  assertSafeId(id);
  return {
    id,
    isDeleted: true,
    deletedAt,
    createdAt: deletedAt,
    updatedAt: deletedAt,
    ...(lastOp ? { lastOp } : {}),
  };
}

/** 生成一份新的空 manifest。 */
export function emptyManifest(encrypted: boolean, now: string): Manifest {
  return { v: MANIFEST_VERSION, generatedAt: now, encrypted, shards: [] };
}

/**
 * 解析 manifest。
 *
 * **返回 null 表示「这份 manifest 不可用」**，而不是「远端是空的」——
 * 这个区别是数据安全的关键：
 *   · null        → 调用方必须走「列目录重建」或「放弃本轮」，**不得**当成空库
 *   · shards: []  → 确实是空库（用户还没有任何会话）
 * 把 null 当成空库会让一次文件损坏或格式变更变成「云端清空 → 本地被清空」。
 * 这在无回收站模型下不可逆（见计划书 §9 R1 与 §4.4 熔断）。
 */
export function parseManifest(text: string): Manifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  // 版本高于本代码认识的版本 → 拒绝。
  // 用「不等于」而不是「大于」：读到 v:0 或 v:"1" 这类畸形值同样不可信。
  if (o.v !== MANIFEST_VERSION) return null;
  if (typeof o.generatedAt !== 'string') return null;
  if (!Array.isArray(o.shards)) return null;

  const shards: ShardFingerprint[] = [];
  for (const s of o.shards) {
    if (!s || typeof s !== 'object') continue;
    const row = s as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    try {
      assertSafeId(row.id);
    } catch {
      continue; // 非法 id 的分片跳过（它会拼进 URL）
    }
    shards.push({
      id: row.id,
      ...(typeof row.etag === 'string' ? { etag: row.etag } : {}),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
      ...(row.isDeleted === true ? { isDeleted: true } : {}),
      ...(isStamp(row.lastOp) ? { lastOp: row.lastOp } : {}),
    });
  }

  return {
    v: MANIFEST_VERSION,
    generatedAt: o.generatedAt,
    encrypted: o.encrypted === true,
    ...(typeof o.salt === 'string' ? { salt: o.salt } : {}),
    shards,
  };
}

/**
 * 加密开着但没有 salt ⇒ 这份 manifest 自相矛盾，不可用。
 *
 * 单独检查而不是塞进 parseManifest：`decrypted` 与 `salt` 的一致性属于
 * **语义**问题（要报给用户「这个库缺少密钥参数」），而 parseManifest 只负责
 * **形状**问题（报「文件损坏」）。两者对用户的下一步动作不同，不该混成一条错误。
 */
export function isManifestUsable(m: Manifest): boolean {
  return !m.encrypted || typeof m.salt === 'string';
}

export function serializeManifest(m: Manifest): string {
  // 稳定输出：shards 按 id 排序。这让「内容没变」时生成的字符串**逐字相同**，
  // 从而可以用「序列化结果是否相同」作为「要不要 PUT」的廉价判据。
  const sorted: Manifest = { ...m, shards: [...m.shards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  return JSON.stringify(sorted, null, 2);
}

