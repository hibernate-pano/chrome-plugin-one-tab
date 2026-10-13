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
 */
import type { SyncBackendId, SyncBackendPort } from './ports';
import { SupabaseBackendAdapter } from './supabaseAdapter';
import { logWarn } from '@/utils/log';
import { WebDavClient } from './webdav/client';
import { WebDavBackendAdapter } from './webdav/adapter';
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
    client: new WebDavClient({ baseUrl: cfg.baseUrl, username: cfg.username, password: secrets.password }),
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
 * ── 失败一律回落 Supabase，绝不抛错 ──────────────────────────────────────
 * 「同步配置读不到」不该让整个扩展打不开——同步只是附加功能。
 * 回落方向是 Supabase：老用户配置异常时，至少他原来的同步路径还在。
 *
 * ⚠️ **回落 = 静默把用户切回 Supabase**，这在「用户明明选了 WebDAV」时很糟。
 * 所以调用方（primeSyncBackend）会把「回落发生且用户选的是 webdav」
 * 记进 `lastResolution`，由 UI/日志显式说出来 —— 不允许无声降级。
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
  /** 实际解析到的后端 id（可能与用户选择不同 —— 那就意味着发生了回落）。 */
  resolvedId: SyncBackendId;
  /** 用户想要的后端 id。 */
  requestedId: SyncBackendId;
  /** 回落原因（仅当 resolvedId !== requestedId）。给用户看的中文说明。 */
  fallbackReason?: string;
}

async function resolveBackendOutcome(): Promise<ResolutionOutcome> {
  const { kvGet } = await import('@/storage-kv/storageAdapter');
  const raw = await kvGet<unknown>('user_settings');
  const settings = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const requestedId: SyncBackendId = settings.syncBackend === 'webdav' ? 'webdav' : 'supabase';
  const supabase = () => ({ backend: new SupabaseBackendAdapter(), resolvedId: 'supabase' as const, requestedId });

  if (requestedId === 'supabase') return supabase();

  const cfg = await loadWebDavConfig();
  if (!cfg) {
    return {
      ...supabase(),
      fallbackReason: '你选择了「自带存储」，但还没有填写云服务信息。请到设置里完成配置。',
    };
  }
  const secrets = getSessionSecrets(cfg.username);
  if (!secrets) {
    return {
      ...supabase(),
      fallbackReason: '你选择了「自带存储」，但本次还没有解锁云服务（需要重新输入应用密码与加密口令）。',
    };
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
 * 最近一次解析的结果（含是否发生回落）。
 *
 * UI 用它把「回落」说给用户听；诊断面板也用它回答
 * 「我明明配了 WebDAV，为什么同步日志里全是 Supabase」。
 */
export function getLastBackendResolution(): (ResolutionOutcome & { at: string }) | null {
  return lastResolution;
}
