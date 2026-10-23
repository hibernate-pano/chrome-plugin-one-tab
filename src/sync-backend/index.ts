/**
 * 同步后端解析入口（2026-10-13）。
 *
 * ── 这个文件经历过什么（留痕，避免下一个人重犯）────────────────────────
 * 阶段 0 时它只是「一个总是返回 Supabase 的解析器」，
 * 配套的 `setSyncPort()` 是全仓零调用的装饰性接缝。
 * 阶段 2 它才真正开始读设置、真正可能返回 WebDAV。
 *
 * **2026-10-13 事故**：做变异验证时我用了 `git checkout -- src/sync-backend/index.ts`
 * 来还原一个变异，把本文件**回退到 HEAD**，阶段 2 的全部改动（设置读取、
 * WebDAV 工厂、回落原因、primeSyncBackend）当场消失，且 git status 干净
 * ——看起来像「什么也没做」，实际是丢了一整层。
 * 这正是本仓库 `.memory/` 里那条纪律针对的失败模式：
 * **变异必须用 `cp` 备份 + `cp` 恢复，绝不能用 `git checkout`**
 * （它会把同一文件上其它人的未提交改动一起抹掉）。
 * 本文件因此被完整重写一遍，恢复到被抹掉之前的状态。
 *
 * **2026-10-14 修 P0**：选了 WebDAV 但未配置/未解锁时，旧逻辑回落 Supabase。
 * 用户重启一次浏览器（会话口令清空是常态）⇒ 自动同步把标签页传到 TapStack 云端，
 * 而他以为数据只在自己盘上。现在 fail-closed：返回锁定占位后端，所有操作抛可读错。
 * 另见 `webdav/config.ts` 的 session 存储镜像（跨 SW/popup/options 上下文）。
 */
import type { SyncBackendId, SyncBackendPort } from './ports';
import { SupabaseBackendAdapter } from './supabaseAdapter';
import { logError, logWarn } from '@/utils/log';
import { kvGet } from '@/storage-kv/storageAdapter';
import { LockedBackendError } from './lockedBackendError';
// ── 2026-10-23（首屏瘦身 + SW 可运行）────────────────────────────────────
//
// 【配置这一半是静态的】`webdav/config.ts`（gzip 约 1.8KB）**每次解析后端都要**
// （读地址/账号/解锁状态），而且它只依赖 storage-kv，不拖任何传输栈 ⇒
// 静态引入，代价可忽略，还顺手消掉了 service worker 里的一次非法 import()。
//
// 【传输栈那一半是动态的】client + adapter（源码 150KB）只有真的要建
// WebDAV 后端时才用得上 ⇒ 不能进弹窗首屏。取法见 webdavRuntime.ts：
// 页面动态加载，service worker 由入口注册静态加载器（SW 里 import() 被禁止）。
import { getSessionSecrets, loadWebDavConfig } from './webdav/config';
import type { StoredWebDavConfig } from './webdav/config';
import { buildWebDavAdapterDeps } from './webdav/factory';
import { loadWebDavTransport } from './webdavRuntime';

let activeBackend: SyncBackendPort | null = null;

/**
 * 测试/调试用的显式注入。
 *
 * 阶段 0 时它是唯一入口（且全仓零调用）；阶段 2 起它多了一个用途：
 * 「忽略设置强制用某个后端」，供测试替身与排查用。
 * 生产路径**不该**调它——生产走 `primeSyncBackend()` / `ensureBackendPrimed()` 读设置。
 */
let overrideBackend: SyncBackendPort | null = null;

/**
 * 解析当前生效的同步后端（**同步**）。
 *
 * ── 为什么这里必须保持同步，不能改成 async ─────────────────────────────
 * 读配置要碰 `chrome.storage`（异步），但本函数有 20 处调用方，且**全都在
 * 同步链路里**：SyncEngine.upload / download、mutationQueue、backgroundSync、
 * SyncButton……把它们改成 async 会波及整个同步管线，而 MV3 SW 里每多一层
 * await 就多一处被杀的可能（30s 空闲 / 单事件 5 分钟上限）。
 *
 * 折中（**预解析 + 同步读取**）：
 *   · SW 启动 / 设置变更 / 后台轮询前，由 `primeSyncBackend()` 异步完成解析；
 *   · 之后所有同步调用方继续用同步的 `getActiveSyncBackend()`。
 *   · 异步透传层（`tabGroupSyncService` / `settingsSyncService`）在调用前先
 *     `await ensureBackendPrimed()`：同一上下文首次调用时补一次解析，
 *     之后复用缓存（不重复建适配器，也就不重复跑 250k 轮 PBKDF2）。
 * 未预解析过时返回 Supabase（fail-safe：老用户路径永远可用），并**出声告警** ——
 * 因为「配了 WebDAV 却静默走 Supabase」如果不提示，就是一次无声的后端回退。
 */
export function getActiveSyncBackend(): SyncBackendPort {
  if (overrideBackend) return overrideBackend;
  if (!activeBackend) {
    void primeSyncBackend();
    logWarn(
      '[sync-backend] 后端尚未预解析，本次按 Supabase 处理。' +
        '若你配置过 WebDAV，请检查调用方是否在用之前 await primeSyncBackend()。'
    );
    return new SupabaseBackendAdapter();
  }
  return activeBackend;
}

/**
 * 显式指定后端。调用方：
 *   · 测试（注入替身，替代原先空转的 setSyncPort）
 *   · 后续阶段的设置层（用户选了 WebDAV 就传 WebDAV 适配器）
 */
export function setActiveSyncBackend(backend: SyncBackendPort): void {
  overrideBackend = backend;
}

/** 恢复默认解析（Supabase）。测试的 afterEach 用。 */
export function resetActiveSyncBackend(): void {
  overrideBackend = null;
  activeBackend = null;
}

/** 当前后端标识（UI 展示与「换后端 ⇒ 水位作废」判据用）。 */
export function getActiveSyncBackendId(): SyncBackendId {
  return getActiveSyncBackend().id;
}

/**
 * 用户**当前设置**里选的后端（直读设置，不经缓存）。
 *
 * ── 为什么需要它（2026-10-14 真机 E2E 挖到的）────────────────────────
 * `getActiveSyncBackendId()` 读的是模块级缓存 `activeBackend`，而它的值
 * 是 SW 启动那一刻解析出来的。用户改完设置、SW 未重启时，**缓存是旧的**。
 *
 *   典型场景：用户刚在设置页配好 WebDAV 就点同步。页面自己刷新了缓存，
 *   SW 那份仍是 Supabase ⇒ 门禁问「你有没有 Supabase 账号」⇒ 返回
 *   not_authenticated ⇒ WebDAV 用户永远看不到「去重新解锁」那句提示。
 *
 * 门禁要回答的是「用户现在选了什么」，这是个**设置事实**，不该绕道缓存。
 * 读一次 IndexedDB 的代价远低于「用户被卡在无法同步」的后果。
 *
 * ── 返回值契约（三态，2026-10-18 B 组）──────────────────────────────
 * `'supabase' | 'webdav'` = **读到了**，用户现在确实选的是这个后端。
 *   「键缺失」也落在这里：raw 取不到对象时 settings = {}，syncBackend
 *   取不到 ⇒ 读成 `DEFAULT_SETTINGS.syncBackend = 'supabase'`
 *   （storage.ts 的默认值）—— 那是**合法的默认值、不是故障**，
 *   新用户从未存过设置时就是它。
 * `null` = **读不到**，本轮无法回答「用户选了什么」。唯一来源是下面
 *   的 catch：死句柄看门狗 abort / 事务 abort / quota。
 *
 * 为什么 null 不能伪装成 'supabase'：调用点据此决定「查不查 Supabase
 * 账号」与「要不要保守抑制全量上传」，两个猜错方向都出过事故 ——
 * 猜成 supabase 会让自带存储用户去查他根本没有的账号（2026-10-14 症状：
 * 「用户未登录」，且永远走不到锁定后端那句「去重新解锁」）；
 * 猜成 webdav 会把本机数据传到用户没选的盘上。读不到就**回答不了**，
 * 上层据此中止本轮，而不是替用户猜一个。
 */
export async function readConfiguredBackendId(): Promise<SyncBackendId | null> {
  try {
    const raw = await kvGet<unknown>('user_settings');
    const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return settings.syncBackend === 'webdav' ? 'webdav' : 'supabase';
  } catch (err) {
    // ⚠️ 兜底**不能**等于「修复前的行为」——见
    // .memory/fallback-catch-must-not-equal-pre-fix-behavior.md。
    //
    // 2026-10-14 踩过一次：兜底写成 `return 'supabase'`（恰好等于修复前），
    // 于是动态 import 在 SW 里抛 `document is not defined` 时被吞掉，
    // 症状与「根本没修」一模一样，从症状上不可区分。
    // 2026-10-18 再修一次：同一行改成「本轮按 Supabase 处理」，
    // 仍然是拿**猜**冒充**读到了** —— 读失败与「用户选了 supabase」
    // 从此不可区分，而这两者的正确动作正好相反（一个该中止，一个该查账号）。
    //
    // 现在的兜底值是「无法回答」（null）：它不等于任何一种「读到了」的值，
    // 调用点必须显式判它并中止本轮（syncEngine 的 download/upload、
    // backgroundSync 的轮询、设置页的推送闸门）。
    logError('[sync-backend] 读不到本机设置，本轮无法判断同步后端（上层应中止本轮）:', err);
    return null;
  }
}

export type {
  SyncBackendPort,
  SyncBackendId,
  RemoteGroupFingerprint,
  UploadGroupsResult,
  // 覆盖被跳过的原因（2026-10-23 R-1）。
  OverwriteSkipReason,
  // D-6：「读不出来而被整组跳过」的会话清单（端口的可选能力）。
  DownloadSkippedGroup,
  DownloadSkipReason,
} from './ports';
export { SupabaseBackendAdapter } from './supabaseAdapter';
export { LockedBackendError, isLockedBackendError } from './lockedBackendError';

/**
 * 锁定态的机器可读分类（与 lockedReason 成对出现）。
 *   · unconfigured —— 确认没配（用户去设置里填地址）；
 *   · locked      —— 配了但本次会话未解锁（重新输入应用密码与口令）；
 *   · error       —— 读不到配置/解锁状态（存储故障，重试或重新保存）。
 *
 * 定义位置：slim 上放在 index.ts（与 ResolutionOutcome 相关）；本文件沿用。
 * 注意它不是 lockedBackendError.ts 的成员 —— 那两个成员是错误类与判据，
 * 这个类型是解析结果的分类。
 */
export type LockedKind = 'unconfigured' | 'locked' | 'error';

// ── 阶段 2：按设置解析后端 ─────────────────────────────────────────────

/**
 * 默认适配器工厂（测试可替换）。
 *
 * ── 为什么允许返回 Promise ──────────────────────────────────────────────
 * 2026-10-23（首屏瘦身）：工厂要造的是 **WebDAV 适配器**，而 WebDAV 那条栈
 * （client + adapter + permission + config，合计约 170KB 源码）**只有真的要
 * 同步时才用得上** —— 弹窗首屏只想看本机会话列表，不该为此下载它。
 * 于是构造动作改成 `await import()`。
 *
 * 代价：工厂从「同步」变成「可能异步」。所有调用点只有一个（下面的
 * `resolveBackendOutcome`，它本来就是 async）⇒ 行为面没有扩大。
 * 注入的测试替身（`setBackendFactory`）仍可返回同步对象 —— 联合类型
 * `SyncBackendPort | Promise<SyncBackendPort>` 兼容原来的写法。
 */
type BackendFactory = (
  cfg: StoredWebDavConfig,
  secrets: { password: string; passphrase: string | null }
) => SyncBackendPort | Promise<SyncBackendPort>;

let factory: BackendFactory | null = null;

/** 替换适配器工厂（测试用）。 */
export function setBackendFactory(f: BackendFactory | null): void {
  factory = f;
  activeBackend = null;
}

async function defaultFactory(
  cfg: StoredWebDavConfig,
  secrets: { password: string; passphrase: string | null }
): Promise<SyncBackendPort> {
  // ⚠️ 这三块是 **WebDAV 传输栈**（client 40KB + adapter 108KB 源码）。
  // 它们只在「用户真的选了自带存储并要同步」时才需要 ⇒ 不进弹窗首屏。
  //
  // 取法分两种（见 webdavRuntime.ts）：
  //   · 页面：动态加载（首屏不下载，真同步时才下）；
  //   · service worker：**静态** import（SW 里 import() 被 Chrome 禁止）——
  //     由 SW 入口注册静态加载器。
  //
  // ⚠️ 依赖（client / config / kv / 三项 seq 能力）由 **webdav/factory.ts** 装配
  // ——那是全仓唯一的装配点（2026-10-23 第 50 轮）。原来这段代码自己抄了一份，
  // 于是「设置页那两处」抄的时候漏了三项 seq 能力（D-7 的缺陷形态，只差一次
  // 写操作就会发作）。收口之后，调用方没有机会漏。
  const { WebDavBackendAdapter } = await loadWebDavTransport();
  return new WebDavBackendAdapter(
    await buildWebDavAdapterDeps({
      baseUrl: cfg.baseUrl,
      username: cfg.username,
      password: secrets.password,
      rootPath: cfg.rootPath,
      // 选「不加密」时传 null；选「必须加密」但这次没给口令 ⇒ passphrase 为 null
      // 且 requireEncryption=true ⇒ 适配器**报错中止**，而不是静默明文上云
      // （这是「静默明文」与「合法不加密」两种状态必须分开的原因）。
      passphrase: secrets.passphrase,
      encryption: cfg.encryption,
    })
  );
}

interface ResolutionOutcome {
  backend: SyncBackendPort;
  /** 实际解析到的后端 id（锁定占位后端的 id 也是 'webdav'，不算回落）。 */
  resolvedId: SyncBackendId;
  /** 用户想要的后端 id。 */
  requestedId: SyncBackendId;
  /** 回落原因（仅当 resolvedId !== requestedId 且非锁定）。给用户看的中文说明。 */
  fallbackReason?: string;
  /**
   * 锁定原因（仅当 requestedId === resolvedId === 'webdav' 但后端被锁定）。
   * 有它 ⇒ 后端是占位，任何同步操作都会抛这句错。UI 据此展示「去解锁」。
   */
  lockedReason?: string;
  /**
   * 锁定的机器可读分类（2026-10-17 从 slim 适配，双模式）。
   *  · unconfigured —— 确认没配（用户去设置里填地址）；
   *  · locked      —— 配了但本次会话未解锁（重新输入应用密码与口令）；
   *  · error       —— 读不到配置/解锁状态（存储故障，重试或重新保存）。
   * 与 lockedReason 成对出现；UI（backendStatus.ts）优先读它，文案只作兜底。
   */
  lockedKind?: 'unconfigured' | 'locked' | 'error';
}

/**
 * 锁定占位后端（2026-10-14 修 P0）。
 *
 * 用户选了 WebDAV 但本会话不可用（没配好 / 没解锁 / 配置读失败）时的返回值。
 * id 仍是 'webdav'：水位键、UI 展示都不会把它当成 Supabase。
 * 每个方法都抛同一句错 —— 「失败要出声」，且出的是用户能行动的话。
 */
class LockedWebDavBackend implements SyncBackendPort {
  readonly id = 'webdav' as const;
  readonly label = '自带存储（WebDAV）';

  constructor(private readonly reason: string) {}

  private fail(): never {
    // LockedBackendError 而不是普通 Error：下游据此把「未配置/未解锁」
    // 与真实网络/服务端故障分机器识别，避免把用户还没配置的正常状态
    // 计入失败退避阶梯（连续 8 次后自动同步被静默停掉）。
    throw new LockedBackendError(this.reason);
  }

  async fetchFingerprints(): Promise<never> {
    this.fail();
  }

  async downloadGroups(): Promise<never> {
    this.fail();
  }

  async uploadGroups(): Promise<never> {
    this.fail();
  }

  async broadcastDeletes(): Promise<never> {
    this.fail();
  }

  async purgeExpiredDeletes(): Promise<never> {
    this.fail();
  }

  async uploadSettings(): Promise<never> {
    this.fail();
  }

  async downloadSettings(): Promise<never> {
    this.fail();
  }
}

async function resolveBackendOutcome(): Promise<ResolutionOutcome> {
  const raw = await kvGet<unknown>('user_settings');
  const settings = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const requestedId: SyncBackendId = settings.syncBackend === 'webdav' ? 'webdav' : 'supabase';
  const supabase = () => ({ backend: new SupabaseBackendAdapter(), resolvedId: 'supabase' as const, requestedId });

  if (requestedId === 'supabase') return supabase();

  const locked = (lockedReason: string, lockedKind: 'unconfigured' | 'locked' | 'error'): ResolutionOutcome => ({
    backend: new LockedWebDavBackend(lockedReason),
    resolvedId: 'webdav',
    requestedId,
    lockedReason,
    lockedKind,
  });

  let cfg: StoredWebDavConfig | null;
  try {
    // 读配置失败也走这一档：读不到配置 ⇒ 本轮中止（fail-closed），而不是
    // 猜一个后端继续同步。
    cfg = await loadWebDavConfig();
  } catch (err) {
    // 2026-10-18：这两条 catch 原先**不打任何日志**，只返锁定占位。
    // 分档口径是「存储读不出来 ⇒ logError」，此处正是该档；不出声等于把
    // 最严重的一类失败降成静默——用户报「同步不动」时日志里空无一物。
    // err 原样带上，否则只剩一句无法归因的中文文案。
    logError('[sync-backend] 自带存储配置读取失败，已中止本轮同步:', err);
    return locked('自带存储的配置读取失败，已中止本次同步以免数据传到错误的后端。请稍后重试。', 'error');
  }
  if (!cfg) {
    return locked('你选择了「自带存储」，但还没有填写云服务信息。请到设置里完成配置。', 'unconfigured');
  }
  let secrets: { password: string; passphrase: string | null } | null;
  try {
    secrets = await getSessionSecrets(cfg.username);
  } catch (err) {
    logError('[sync-backend] 自带存储解锁状态读取失败，已中止本轮同步:', err);
    return locked('自带存储的解锁状态读取失败，已中止本次同步。请重新输入应用密码与加密口令。', 'error');
  }
  if (!secrets) {
    return locked('你选择了「自带存储」，但本次还没有解锁云服务。请到设置里重新输入应用密码与加密口令。', 'locked');
  }

  return {
    // 工厂可能是异步的（默认工厂要动态加载 WebDAV 全栈）⇒ 必须 await。
    backend: await (factory ?? defaultFactory)(cfg, secrets),
    resolvedId: 'webdav',
    requestedId,
  };
}

/**
 * 清掉缓存的后端实例（设置变更后调用）。
 *
 * 为什么必须有：模块级 `activeBackend` 是按「一次会话」缓存的，
 * 用户改了后端/配好云盘之后不失效它，就会继续用旧实例——
 * 而这个 bug 的表现是「我明明切换了设置却没生效」，极难自查。
 */
export function invalidateActiveSyncBackend(): void {
  if (!overrideBackend) activeBackend = null;
}

/**
 * 预解析后端（**异步**）。必须在任何同步动作之前 await 一次。
 *
 * 调用方（三处，缺一不可）：
 *   · SW 启动（service-worker.ts 模块顶层）
 *   · 用户改完同步设置（HeaderDropdown 保存成功之后）
 *   · 后台轮询闹钟触发时（backgroundSync.handleAlarm 开头）
 *   · 异步透传层首调用（`ensureBackendPrimed`，覆盖 popup/options 上下文首次调用）
 */
let lastResolution: (ResolutionOutcome & { at: string }) | null = null;

export async function primeSyncBackend(): Promise<ResolutionOutcome> {
  // 2026-10-17（B1 连带修复，原为 slim 的 L4 修复）：catch 必须留下
  // lockedReason/lockedKind，否则 UI 读到「无锁定原因」会判成 ready 绿点 ——
  // 存储故障时面板宣称「已配置并解锁」。
  //
  // 双模式适配点：slim 上没有第二个后端可回落，这里的 catch 是
  // lockedBackend('读不到同步设置…')。main 上保留 Supabase 回落语义的
  // 前提是「已知用户要 Supabase」；但 catch 住的是**预期外异常**，连
  // requestedId 是谁都读不出来，回落 Supabase 等于在「不知道用户要哪」
  // 的情况下猜一个 —— 显式失败（锁定占位 + error）比猜更诚实。
  const outcome = await resolveBackendOutcome().catch(() => ({
    backend: new LockedWebDavBackend('读不到同步设置，已中止本次同步。请关闭扩展后重试，或到设置里重新填写云盘信息。'),
    resolvedId: 'webdav' as SyncBackendId,
    requestedId: 'webdav' as SyncBackendId,
    lockedReason: '读不到同步设置，已中止本次同步。请关闭扩展后重试，或到设置里重新填写云盘信息。',
    lockedKind: 'error' as LockedKind,
  }));
  if (!overrideBackend) activeBackend = outcome.backend;
  lastResolution = { ...outcome, at: new Date().toISOString() };
  return outcome;
}

/**
 * 只重算「解析状态」，**不重建后端实例**（2026-10-18 P2-6）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * UI 要回答的是「现在到底能不能同步」，而 `lastResolution` 是进程内缓存：
 * 用户在另一个窗口改完配置后，本窗口读到的是旧答案。原先 UI 的做法是
 * `invalidateActiveSyncBackend()` + `primeSyncBackend()` 两者都调 ——
 * 但后者会**重新构造适配器**，WebDAV 适配器的 `unlock()` 因此要重跑
 * PBKDF2 密钥派生（250k 轮，见 adapter.ts）。
 *
 * 「每次打开菜单 / 每次窗口聚焦」触发一次可测的密钥派生，是纯开销：
 * 注释原先写「代价只有一次本地存储读」，那**不成立**。
 *
 * ── 语义边界（重要）──────────────────────────────────────────────────────
 * 本函数**只用于 UI 读状态**。任何**要真的同步**的路径仍必须走
 * `invalidateActiveSyncBackend()` + `primeSyncBackend()` 或
 * `ensureBackendPrimed()` —— 因为设置真的变了（地址/账号/目录）时，
 * 旧实例持有的 Vault 与连接就是错的，必须重建。
 *
 * 一句话：**读状态可以偷懒，写数据不能。**
 */
export async function refreshBackendResolutionOnly(): Promise<ResolutionOutcome> {
  const outcome = await resolveBackendOutcome().catch(() => ({
    backend: new LockedWebDavBackend('读不到同步设置。请关闭扩展后重试，或到设置里重新填写云盘信息。'),
    resolvedId: 'webdav' as SyncBackendId,
    requestedId: 'webdav' as SyncBackendId,
    lockedReason: '读不到同步设置。请关闭扩展后重试，或到设置里重新填写云盘信息。',
    lockedKind: 'error' as LockedKind,
  }));
  // 刻意**不写** activeBackend：这里只是重算状态，实例保持不变。
  lastResolution = { ...outcome, at: new Date().toISOString() };
  return outcome;
}

/**
 * 异步透传层的统一预解析（2026-10-14 修 P0 时加）。
 *
 * 每个执行上下文（SW / popup / options）的 `activeBackend` 是独立的：
 * SW 启动时的 prime 管不到 popup 里第一次点同步。透传层在真正调用后端之前
 * 先调它：已有缓存 ⇒ 直接返回（零开销，不重建适配器、不重跑 PBKDF2）；
 * 无缓存 ⇒ 补一次 `primeSyncBackend()`。
 */
export async function ensureBackendPrimed(): Promise<void> {
  if (overrideBackend || activeBackend) return;
  await primeSyncBackend();
}

/**
 * 最近一次解析的结果（含是否发生回落）。
 *
 * UI 用它把「回落」说给用户听；诊断面板也用它回答
 * 「我明明配了 WebDAV，为什么同步日志里全是 Supabase」。
 */
export function getLastBackendResolution(): (ResolutionOutcome & { at: string }) | null {
  return lastResolution;
}
