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
 * 因此它损坏/丢失**不是数据丢失**，只是退化成「一次全量扫描」（见 downloader）。
 * 这个性质是下面 `parseManifest` 选择「宽容解析、坏则返回 null」的依据。
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
}

export function makeEncryptedEnvelope(enc: EncryptedPayload): SecureFileEnvelope {
  return { v: 1, enc };
}

export function makePlainEnvelope(plain: unknown): SecureFileEnvelope {
  return { v: 1, plain };
}

/**
 * 解析落盘外壳。
 *
 * 返回 `{ kind: 'encrypted', enc }` 或 `{ kind: 'plain', plain }`；
 * 无法解析（JSON 坏 / 版本不符 / enc 与 plain 同时有或同时无）→ **null**。
 *
 * 与 `parseManifest` 同一条纪律：**null 表示「不可用」，不表示「空」**。
 * 把坏文件当成空会话会让对端把这一条会话合并成「已被删除」。
 */
export function parseEnvelope(
  text: string
): { kind: 'encrypted'; enc: EncryptedPayload } | { kind: 'plain'; plain: unknown } | null {
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

  if (hasEnc) {
    const enc = o.enc as Record<string, unknown>;
    if (enc.v !== 1 || typeof enc.salt !== 'string' || typeof enc.data !== 'string') return null;
    return { kind: 'encrypted', enc: enc as unknown as EncryptedPayload };
  }
  return { kind: 'plain', plain: o.plain };
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
 */
export function encodeGroup(group: TabGroup): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    isLocked: group.isLocked,
    ...(group.displayOrder === undefined ? {} : { displayOrder: group.displayOrder }),
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
    ...(typeof o.displayOrder === 'number' ? { displayOrder: o.displayOrder } : {}),
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
): Record<string, unknown> {
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

