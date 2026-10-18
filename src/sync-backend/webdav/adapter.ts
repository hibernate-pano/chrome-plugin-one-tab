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
 */
import type { TabGroup, UserSettings } from '@/types/tab';
import type {
  DownloadSettingsResult,
  RemoteGroupFingerprint,
  SyncBackendPort,
  UploadGroupsResult,
} from '../ports';
import { WebDavClient, WebDavError } from './client';
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
  isManifestUsable,
  makeEncryptedEnvelope,
  makePlainEnvelope,
  parseEnvelope,
  parseManifest,
  serializeEnvelope,
  serializeManifest,
  shardPath,
  type Manifest,
  type ShardFingerprint,
} from './layout';
import { createVault, openVault, type Vault } from '../crypto';
import { checkDeleteFailsafe } from '../failsafe';
import { compareStampsLoose } from '@/core/opStamp';

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
}

/** 水位值形状。与 Supabase 侧同构（含 deviceSeq 基线）。 */
interface SyncWatermark {
  seq: number;
  deviceSeq: number;
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

export class WebDavBackendAdapter implements SyncBackendPort {
  readonly id = 'webdav' as const;
  readonly label = '自带存储（WebDAV）';

  private readonly client: WebDavClient;
  private readonly config: WebDavBackendConfig;
  private readonly kv: AdapterKv;
  private readonly now: () => string;
  private readonly peekDeviceSeq: () => Promise<number>;
  private readonly root: string;

  constructor(deps: WebDavAdapterDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.kv = deps.kv;
    this.now = deps.now ?? (() => new Date().toISOString());
    // 默认 0：没有发号器时水位基线的自检退化为「不检测」，
    // 这在真实运行时不会发生（写作路径总会注入），测试里则让断言更简单。
    this.peekDeviceSeq = deps.peekDeviceSeq ?? (async () => 0);
    this.root = normalizeRoot(deps.config.rootPath);
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
   * 读 manifest。
   *
   * @returns null = 远端还没有这个库（**合法状态**，首次同步就是从这里开始）
   * @throws 文件存在但解析不了 / 加密库缺 salt —— 「坏了」必须与「空」分开
   */
  private async loadManifest(): Promise<{ manifest: Manifest; etag: string | null } | null> {
    const got = await this.client.get(this.p(MANIFEST_PATH));
    // 'notFound' in got = 404 或 409（父目录不存在）。两者对「清单还不存在」等价：
    // 坚果云等按 RFC 4918 对不存在的父目录回 409 而不是 404，语义上仍是「没有」。
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
   * 写 manifest（带乐观锁 + 冲突重试）。
   *
   * `apply` 在**每次尝试**都会被调用，且接收**最新读到的** manifest ——
   * 这是关键：冲突后如果拿旧快照重写，会把对方刚加进来的分片条目抹掉
   * （manifest 是派生数据，条目丢了不会丢会话内容，但会让对端少一次探活命中）。
   */
  private async writeManifest(
    apply: (base: Manifest) => Manifest,
    encrypted: boolean,
    salt: string | undefined
  ): Promise<void> {
    for (let attempt = 0; attempt < CONFLICT_RETRY_LIMIT; attempt++) {
      const current = await this.loadManifest();
      const base =
        current?.manifest ??
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
        return;
      } catch (err) {
        const conflict = err instanceof WebDavError && err.isPreconditionFailed;
        if (!conflict || attempt === CONFLICT_RETRY_LIMIT - 1) throw err;
        // 冲突：下一轮循环会重新读取最新 manifest 再 apply 一次。
      }
    }
  }

  // ── 分片读写 ────────────────────────────────────────────────────────

  /** 落盘一个分片的载荷（加密或明文），返回服务端给的 ETag。 */
  private async writeShard(
    id: string,
    payload: Record<string, unknown>,
    opts: { ifMatch?: string; ifNoneMatch?: string }
  ): Promise<{ etag: string | null }> {
    const vault = this.vault;
    const envelope = vault
      ? makeEncryptedEnvelope(await vault.encrypt(payload))
      : makePlainEnvelope(payload);

    const path = this.p(shardPath(id));
    await this.client.mkdirp(this.p(`${GROUPS_DIR}/${id.slice(0, 2)}`));
    const out = await this.client.put(path, serializeEnvelope(envelope), {
      ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
      ...(opts.ifNoneMatch ? { ifNoneMatch: opts.ifNoneMatch } : {}),
    });
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

  /** 读一个分片并解码成会话。返回 null = 文件缺失或不可解析（计入统计，不静默丢）。 */
  private async readShard(id: string): Promise<{ group: TabGroup | null; etag: string | null }> {
    const got = await this.client.get(this.p(shardPath(id)));
    // 'notFound' in got = 404/409，即这个分片在远端不存在（首次同步的常态）。
    if (!got || 'notFound' in got) return { group: null, etag: null };

    const env = parseEnvelope(got.body);
    if (!env) return { group: null, etag: got.etag };

    let payload: unknown;
    if (env.kind === 'encrypted') {
      if (!this.vault) {
        throw new Error('云端分片是加密的，但本机没有口令，无法读取。');
      }
      payload = await this.vault.decrypt(env.enc);
    } else {
      payload = env.plain;
    }
    return { group: decodeGroup(payload), etag: got.etag };
  }

  // ── SyncBackendPort 实现 ────────────────────────────────────────────

  async fetchFingerprints(): Promise<RemoteGroupFingerprint[]> {
    const loaded = await this.loadManifest();
    if (!loaded) return []; // 远端确实还没建库
    await this.unlock(loaded.manifest);

    return loaded.manifest.shards.map(s => ({
      id: s.id,
      updatedAt: s.updatedAt,
      etag: s.etag,
      isDeleted: s.isDeleted === true,
      ...(s.lastOp ? { lastOp: s.lastOp } : {}),
    }));
  }

  async downloadGroups(): Promise<TabGroup[]> {
    const loaded = await this.loadManifest();
    if (!loaded) return [];
    await this.unlock(loaded.manifest);

    const groups: TabGroup[] = [];
    const unreadable: string[] = [];

    for (const shard of loaded.manifest.shards) {
      try {
        const { group } = await this.readShard(shard.id);
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

  async uploadGroups(
    groups: TabGroup[],
    opts?: { overwriteRemote?: boolean; suppressFirstSyncFullUpload?: boolean }
  ): Promise<UploadGroupsResult> {
    const loaded = await this.loadManifest();
    const vault = await this.unlock(loaded?.manifest ?? null);

    const watermark = loaded ? await this.loadWatermark() : 0;
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
    const firstSync = loaded === null && !opts?.suppressFirstSyncFullUpload;
    const toUpload =
      firstSync || opts?.overwriteRemote ? groups : selectDirty(groups, watermark);

    const entryById = new Map<string, ShardFingerprint>(
      (loaded?.manifest.shards ?? []).map(s => [s.id, s])
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

      // ── 认输预检（2026-10-13 测试抓到的真 bug，别删）─────────────────────
      // If-Match 只能发现「我读完之后有人改了」，**发现不了「我的版本本来就更旧」**。
      // 后者是真实场景：一台久未同步的设备（水位很旧甚至为 0）打开扩展，
      // 它手里的组 stamp 比云端小，但因为它读到 manifest 后没有任何人再改，
      // 条件写会**成功**——于是用旧内容覆盖掉云端的新版本，静默丢数据。
      //
      // Supabase 侧的对应防线是 `findConcededGroupIds`（upload.ts:595-611），
      // 语义逐字相同：云端 stamp 严格更大 ⇒ 本次认输、不上行，
      // 本地副本交给下一次下载合并物理替换（那条路径有回滚与校验）。
      //
      // 只比 `lastOp`，不请求网络：manifest 条目里已经带着它。
      if (existing && compareStamps(existing.lastOp, g.lastOp) > 0) {
        // 认输：不碰远端，本地副本等下次下载合并时被替换。
        // 注意这里**不**记入 writtenEntries —— apply 时以 base（最新远端）为准，
        // 记进去反而会用旧条目覆盖对端的新条目。
        continue;
      }

      // ── 这里**不**做「内容哈希没变就跳过」的优化，两个理由 ──────────────
      // 1. 多余的：进到这里的组已经过了 `selectDirty`（stamp > 水位），
      //    上传成功又立刻把水位推到该 stamp，所以下一轮它根本不会被选中。
      // 2. 有害的：这个哈希算的是**明文**哈希，而 manifest 是**明文**存储。
      //    把明文哈希写进明文 manifest，等于给攻击者一个「已知明文确认」的口子
      //    （猜到某个会话名/URL 就能验证猜得对不对），直接削弱端到端加密。
      //    密文哈希又不可用（IV 每次随机 ⇒ 密文每次都不同）。
      const result = await this.putShardResolvingConflict(g, existing, payload);
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
      });
    }

    if (writtenIds.length > 0 || firstSync) {
      await this.writeManifest(
        // 以最新 base 为底，只覆盖本批真正写过的条目，其余原样保留。
        // 这是并发安全的关键：重试时 base 里已有对端刚写入的条目，
        // 若用关闭时的旧快照整体覆盖，对端条目会被静默抹掉
        // （文件还在，但 manifest 是真相源 ⇒ 对端会话隐形丢失）。
        base => {
          const merged = new Map<string, ShardFingerprint>(base.shards.map(s => [s.id, s]));
          for (const e of writtenEntries) merged.set(e.id, e);
          return { ...base, generatedAt: this.now(), shards: [...merged.values()] };
        },
        Boolean(vault),
        vault?.salt
      );
    }

    if (writtenIds.length > 0) {
      // 水位必须用**写入这一刻**的计数器值，不能复用读取时的旧值 ——
      // 本批上行本身可能推进了计数器（Supabase 侧 upload.ts 的同款注释）。
      await this.saveWatermark(maxSeq, await this.peekDeviceSeq());
    }

    return {
      writtenIds,
      overwroteRemote: opts?.overwriteRemote === true,
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
    existing: ShardFingerprint | undefined,
    payload: Record<string, unknown>
  ): Promise<{ skipped: false; etag: string | null } | { skipped: true }> {
    let ifMatch = existing?.etag;
    // 首次写这个会话时用 If-None-Match:'*'（仅当不存在时创建）。
    // 不带条件会覆盖掉「另一台设备刚创建的同 id 分片」——那正是并发窗口。
    let ifNoneMatch = existing ? undefined : '*';

    for (let attempt = 0; attempt < CONFLICT_RETRY_LIMIT; attempt++) {
      try {
        const out = await this.writeShard(group.id, payload, {
          ...(ifMatch ? { ifMatch } : {}),
          ...(ifNoneMatch ? { ifNoneMatch } : {}),
        });
        return { skipped: false, etag: out.etag };
      } catch (err) {
        const conflict = err instanceof WebDavError && err.isPreconditionFailed;
        if (!conflict) throw err;

        // 冲突：读回远端当前版本，按 stamp 裁决。
        const remote = await this.readShard(group.id);
        if (remote.group) {
          const remoteWins = compareStamps(remote.group.lastOp, group.lastOp) > 0;
          if (remoteWins) return { skipped: true };
        }
        // 本地赢（或对端此刻又删了/读不到）：用刚拿到的 ETag 重试一次。
        ifMatch = remote.etag ?? undefined;
        ifNoneMatch = remote.etag ? undefined : '*';
      }
    }
    throw new Error(
      `会话「${group.name || group.id}」在云端被反复改动，多次重试仍未写入。` +
        '可能有另一台设备或同步程序正在同时修改它。'
    );
  }

  async broadcastDeletes(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const loaded = await this.loadManifest();
    const vault = await this.unlock(loaded?.manifest ?? null);
    const entryById = new Map<string, ShardFingerprint>(
      (loaded?.manifest.shards ?? []).map(s => [s.id, s])
    );
    // 本批新产生的墓碑条目。最终合并在 apply 里基于最新 base 做，
    // 未触及的条目以 base 为准（与 uploadGroups 同一纪律，见该处注释）。
    const tombstoneEntries: ShardFingerprint[] = [];
    const now = this.now();

    for (const id of ids) {
      const existing = entryById.get(id);
      // 删除意图自带新 stamp 才能在对端赢过旧副本。这里沿用云端已有的 stamp
      // 就会输给「对端离线期间改过、stamp 更大」的活跃副本（与 Supabase 侧
      // markCloudGroupsAsDeleted 的 seq+1 语义一致，见该实现）。
      // 取 max(设备 seq + 1, 云端已知 stamp + 1)：压过另一台设备写过的更大 seq，
      // 否则墓碑反而更小，对端合并时删除输给旧副本而「复活」（2026-10-14 修 P1）。
      const tombstone = encodeTombstone(id, now, await this.nextDeleteStamp(existing?.lastOp));
      const out = await this.writeShard(id, tombstone, {
        ...(existing?.etag ? { ifMatch: existing.etag } : {}),
        ...(existing?.etag ? {} : { ifNoneMatch: '*' } as object),
      });

      const entry: ShardFingerprint = {
        id,
        ...(out.etag ? { etag: out.etag } : {}),
        updatedAt: now,
        isDeleted: true,
        ...(tombstone.lastOp ? { lastOp: tombstone.lastOp as { d: string; s: number } } : {}),
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
      vault?.salt
    );
  }

  /**
   * 删除广播用的 stamp。
   *
   * 必须严格大于该会话已有的 stamp，否则对端合并时删除会输给旧副本而「复活」。
   * 取 `max(设备 seq + 1, 云端已知 stamp + 1)`：这样既保持本设备单调，
   * 也能压过「另一台设备写了更大 seq」的云端副本。
   */
  private async nextDeleteStamp(
    cloudLastOp?: { d: string; s: number }
  ): Promise<{ d: string; s: number }> {
    const deviceSeq = await this.peekDeviceSeq();
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
    return {
      // 拿不到设备 id 时仍留 'unknown' 兜底（老存储可能确实没写过），
      // 但生产路径现在能拿到真实 id —— 兜底不再是被常态掩盖的死分支。
      d: typeof device === 'string' && device ? device : 'unknown',
      s: Math.max(deviceSeq + 1, cloudSeq + 1),
    };
  }

  async purgeExpiredDeletes(maxAgeDays = 30): Promise<number> {
    const loaded = await this.loadManifest();
    if (!loaded) return 0;
    const vault = await this.unlock(loaded.manifest);

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
    const expired = loaded.manifest.shards.filter(
      s => s.isDeleted === true && Date.parse(s.updatedAt) > 0 && Date.parse(s.updatedAt) < cutoff
    );
    if (expired.length === 0) return 0;

    for (const s of expired) {
      // 先删文件再改 manifest：反过来的话，中途失败会留下「manifest 里没有、
      // 文件还在」的孤儿。而孤儿只会占空间，不会影响正确性（manifest 是真相源）。
      await this.client.delete(this.p(shardPath(s.id)));
    }

    const expiredIds = new Set(expired.map(s => s.id));
    await this.writeManifest(
      base => ({
        ...base,
        generatedAt: this.now(),
        shards: base.shards.filter(s => !expiredIds.has(s.id)),
      }),
      Boolean(vault),
      vault?.salt
    );
    return expired.length;
  }

  async uploadSettings(settings: UserSettings): Promise<void> {
    let loaded = await this.loadManifest();
    const vault = await this.unlock(loaded?.manifest ?? null);
    const payload = { v: 1 as const, settings: settings as unknown as Record<string, unknown>, updatedAt: this.now() };
    const envelope = vault
      ? makeEncryptedEnvelope(await vault.encrypt(payload))
      : makePlainEnvelope(payload);
    // ── 加密库的 salt 必须落进 manifest（2026-10-14 修 P2）─────────────────
    // 建库前（manifest 还不存在）就上传设置时，`unlock(null)` 会新建随机 salt 的
    // Vault，加密完若不把 salt 写进 manifest，下次下载时按 manifest 的 salt 派生
    // 出另一个密钥 ⇒ 解不开 ⇒ 设置永久不可读。同理，已有明文库第一次用口令写设置
    // 时，也必须把 manifest 翻成加密态。明文模式（vault 为 null）不碰 manifest。
    if (vault && (!loaded || !loaded.manifest.encrypted || loaded.manifest.salt !== vault.salt)) {
      await this.writeManifest(
        base => ({ ...base, generatedAt: this.now(), encrypted: true, salt: vault.salt }),
        true,
        vault.salt
      );
      loaded = await this.loadManifest();
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
        const loaded = await this.loadManifest();
        await this.unlock(loaded?.manifest ?? null);
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
    const loaded = await this.loadManifest();
    const conditionalWrites = await this.probeConditionalWrites();
    if (!loaded) return { groups: 0, encrypted: false, conditionalWrites };

    let encrypted = false;
    if (loaded.manifest.encrypted) {
      // 口令必须真的能解开这个库，否则「连接成功」是假象。
      await this.unlock(loaded.manifest);
      encrypted = true;
    }
    return {
      groups: loaded.manifest.shards.filter(s => s.isDeleted !== true).length,
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
      await this.client.put(probePath, 'probe', { contentType: 'text/plain' });
      await this.client.put(probePath, 'probe2', {
        ifMatch: '"tapstack-probe-deliberately-stale"',
      });
      // 条件写没被拒绝 ⇒ 服务端忽略 If-Match。
      return false;
    } catch (err) {
      if (err instanceof WebDavError && err.isPreconditionFailed) return true;
      // 「没授权」必须与「服务端不支持条件写」区分开（2026-10-14补 P1 时加）。
      // 权限预检抛的是 status 0 + 权限文案；若不在这里拦一道，它会被下面的
      // 兜底吞成 `false`，于是「浏览器没给这个域名的权限」会被如实上报成
      // 「你的服务端不支持条件写」——一个会让用户去检查服务器配置的**错误结论**。
      // 而真实原因只需要点一次「测试连接」授权就能解决。
      if (err instanceof WebDavError && err.isPermissionDenied) throw err;
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

/** stamp 全序比较。委托给 core/opStamp，避免口径漂移（见该函数注释）。 */
function compareStamps(
  a: { d: string; s: number } | undefined,
  b: { d: string; s: number } | undefined
): number {
  return compareStampsLoose(a, b);
}

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

