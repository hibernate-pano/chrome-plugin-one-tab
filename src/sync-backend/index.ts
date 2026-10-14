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
import { logWarn } from '@/utils/log';
import { kvGet } from '@/storage-kv/storageAdapter';
import { WebDavClient } from './webdav/client';
import { WebDavBackendAdapter } from './webdav/adapter';
import { hasHostPermission } from './webdav/permission';
import {
  chromeKvAdapter,
  getSessionSecrets,
  loadWebDavConfig,
  type StoredWebDavConfig,
} from './webdav/config';

let activeBackend: SyncBackendPort | null = null;

/**
 * 测试/调试用的显式注入。
 *
 * 阶段 0 时它是唯一入口（且全仓零调用）；阶段 2 起它多了一个用途：
 * 「忽略设置强制用某个后端」，供测试替身与排查用。
 * 生产路径**不该**调它——生产走 `resolveConfiguredBackend()` 读设置。
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
 * 读失败按 supabase 处理：读不到设置时最安全的假设是老用户的既有路径。
 * （与 `resolveBackendOutcome` 里 kvGet 失败的回落方向一致。）
 */
export async function readConfiguredBackendId(): Promise<SyncBackendId> {
  try {
    const raw = await kvGet<unknown>('user_settings');
    const settings = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return settings.syncBackend === 'webdav' ? 'webdav' : 'supabase';
  } catch (err) {
    // ⚠️ 这里的兜底**不能**等于「修复前的行为」——见
    // .memory/fallback-catch-must-not-equal-pre-fix-behavior.md。
    //
    // 2026-10-14 踩过一次：兜底写成 `return 'supabase'`（恰好等于修复前），
    // 于是动态 import 在 SW 里抛 `document is not defined` 时被吞掉，
    // 症状与「根本没修」一模一样，从症状上不可区分。
    //
    // 现在已改静态 import，那条触发路径没了；但**形态**仍在：
    // 任何未来的读取失败都会把 WebDAV 用户悄悄变成「查 Supabase 账号」，
    // 于是他又被挡在门外 —— 正是这次修掉的 bug。
    //
    // 因此这里**出声**：读不到设置就说读不到，让上层和日志能区分
    // 「读失败」与「用户真的选了 supabase」。
    logWarn('[sync-backend] 读取设置失败，本轮按 Supabase 处理（若你选了自带存储，请检查设置存储）:', err);
    return 'supabase';
  }
}

export type { SyncBackendPort, SyncBackendId, RemoteGroupFingerprint, UploadGroupsResult } from './ports';
export { SupabaseBackendAdapter } from './supabaseAdapter';

// ── 阶段 2：按设置解析后端 ─────────────────────────────────────────────

/** 默认适配器工厂（测试可替换）。 */
type BackendFactory = (
  cfg: StoredWebDavConfig,
  secrets: { password: string; passphrase: string | null }
) => SyncBackendPort;

let factory: BackendFactory | null = null;

/** 替换适配器工厂（测试用）。 */
export function setBackendFactory(f: BackendFactory | null): void {
  factory = f;
  activeBackend = null;
}

function defaultFactory(
  cfg: StoredWebDavConfig,
  secrets: { password: string; passphrase: string | null }
): SyncBackendPort {
  return new WebDavBackendAdapter({
    client: new WebDavClient(
      { baseUrl: cfg.baseUrl, username: cfg.username, password: secrets.password },
      // 第二个参数留空 = 用全局 fetch（真实运行路径）。
      fetch,
      // ── 权限预检接线（2026-10-14 补 P1）────────────────────────────────
      // 为什么在这里注入而不在 client.ts 里直接调 permission.ts：
      // 传输层要能在 Node 测试环境独立跑（那里没有 chrome.permissions），
      // 注入的方式让「不注入 = 不检查」成为显式选择。
      //
      // 用 `hasHostPermission`（只 contains、不 request）而非
      // `ensureHostPermission`：后者会调 `chrome.permissions.request()`，
      // 而该调用**必须有用户手势**，在 service worker 的定时任务里会直接失败
      // （permission.ts:52-54已注明）。授权只发生在配置面板的按钮点击里。
      () => hasHostPermission(cfg.baseUrl)
    ),
    config: {
      baseUrl: cfg.baseUrl,
      username: cfg.username,
      password: secrets.password,
      rootPath: cfg.rootPath,
      // 选「不加密」时传 null；选「必须加密」但这次没给口令 ⇒ passphrase 为 null
      // 且 requireEncryption=true ⇒ 适配器**报错中止**，而不是静默明文上云
      // （这是「静默明文」与「合法不加密」两种状态必须分开的原因）。
      passphrase: secrets.passphrase,
      requireEncryption: cfg.encryption === 'required',
    },
    kv: chromeKvAdapter,
  });
}

/**
 * 读设置，决定用哪个后端。
 *
 * ── 失败语义（2026-10-14 修 P0 后的最终口径）────────────────────────────
 * 「连用户想要哪个后端都读不到」（存储异常）⇒ 回落 Supabase，绝不抛错：
 * 同步只是附加功能，不该让整个扩展打不开；且读不到时默认 supabase 对存量用户最安全。
 *
 * 「用户明确选了 webdav，但配置缺失/未解锁/配置读失败」⇒ 返回锁定占位后端，
 * **绝不回落 Supabase**。回落等于把用户数据传到他没选的后端，且毫无提示 ——
 * 重启浏览器（会话口令清空）是常态，回落会让每次重启后都发生一次无声的后端切换。
 * 锁定后端的每个方法都抛同一句可读错（去设置页解锁），调用方据此中止本轮。
 */
export async function resolveConfiguredBackend(): Promise<SyncBackendPort> {
  try {
    const outcome = await resolveBackendOutcome();
    activeBackend = outcome.backend;
    return outcome.backend;
  } catch {
    activeBackend = new SupabaseBackendAdapter();
    return activeBackend;
  }
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
    throw new Error(this.reason);
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

  const locked = (lockedReason: string): ResolutionOutcome => ({
    backend: new LockedWebDavBackend(lockedReason),
    resolvedId: 'webdav',
    requestedId,
    lockedReason,
  });

  let cfg: StoredWebDavConfig | null;
  try {
    cfg = await loadWebDavConfig();
  } catch {
    return locked('自带存储的配置读取失败，已中止本次同步以免数据传到错误的后端。请稍后重试。');
  }
  if (!cfg) {
    return locked('你选择了「自带存储」，但还没有填写云服务信息。请到设置里完成配置。');
  }
  let secrets: { password: string; passphrase: string | null } | null;
  try {
    secrets = await getSessionSecrets(cfg.username);
  } catch {
    return locked('自带存储的解锁状态读取失败，已中止本次同步。请重新输入应用密码与加密口令。');
  }
  if (!secrets) {
    return locked('你选择了「自带存储」，但本次还没有解锁云服务。请到设置里重新输入应用密码与加密口令。');
  }

  return {
    backend: (factory ?? defaultFactory)(cfg, secrets),
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
  const outcome = await resolveBackendOutcome().catch(() => ({
    backend: new SupabaseBackendAdapter(),
    resolvedId: 'supabase' as SyncBackendId,
    requestedId: 'supabase' as SyncBackendId,
  }));
  if (!overrideBackend) activeBackend = outcome.backend;
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
