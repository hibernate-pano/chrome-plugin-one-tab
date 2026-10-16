/**
 * 同步后端解析入口（2026-10-13；2026-10-16 Supabase 下线后只剩 WebDAV）。
 *
 * ── 这个文件经历过什么（留痕，避免下一个人重犯）────────────────────────
 * 2026-10-13 建它时是「一个总是返回 Supabase 的解析器」，
 * 配套的 `setSyncPort()` 是全仓零调用的装饰性接缝。
 * 之后它才真正开始读设置、真正可能返回 WebDAV。
 *
 * **2026-10-13 事故**：做变异验证时我用了 `git checkout -- src/sync-backend/index.ts`
 * 来还原一个变异，把本文件**回退到 HEAD**，当时的全部改动（设置读取、
 * WebDAV 工厂、回落原因、primeSyncBackend）当场消失，且 git status 干净
 * ——看起来像「什么也没做」，实际是丢了一整层。
 * 这正是本仓库 `.memory/` 里那条纪律针对的失败模式：
 * **变异必须用 `cp` 备份 + `cp` 恢复，绝不能用 `git checkout`**
 * （它会把同一文件上其它人的未提交改动一起抹掉）。
 *
 * **2026-10-14 修 P0**：选了 WebDAV 但未配置/未解锁时，旧逻辑回落 Supabase。
 * 用户重启一次浏览器（会话口令清空是常态）⇒ 自动同步把标签页传到 TapStack 云端，
 * 而他以为数据只在自己盘上。现在 fail-closed：返回锁定占位后端，所有操作抛可读错。
 * 另见 `webdav/config.ts` 的 session 存储镜像（跨 SW/popup/options 上下文）。
 *
 * **2026-10-16：云端后端删除后的口径 —— 每个 fallback 都重新判过一遍。**
 * 旧的 5 个「回落 Supabase」分支全部消失，**没有任何一处被机械替换**：
 *   · 既然 TapStack 云端已不存在，「回落到云端」这个动作本身已无意义；
 *   · 剩下的唯一正确终态就是「WebDAV，但可能未配置/未解锁」。
 *     未配置/未解锁时返回 **LockedWebDavBackend**（不是真适配器），让每次
 *     操作抛一句用户能行动的话，而不是静默用空配置发请求。
 *   · 每一种失败原因都在 `resolveBackendOutcome()` 里**分类出声**，不再混成
 *     同一句静默的锁定：
 *       - 配置存储读抛错 / 解锁状态存储读抛错 → **logError**
 *         （最深的一层：「我连它配没配都不知道」）；
 *       - 确认没配 / 确认未解锁 → **logWarn**
 *         （「我知道了，是用户可行动的状态」）。
 *     三者 severity 不同，排查时能直接区分是存储故障还是配置/解锁问题。
 *   · `resolveConfiguredBackend()` / `primeSyncBackend()` 外层的 catch 只兜
 *     工厂/构造器抛错这类预期外情况，保持 logError 不变。
 */
import type { SyncBackendId, SyncBackendPort } from './ports';
import { LockedBackendError } from './lockedBackendError';
import { logWarn, logError } from '@/utils/log';
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
 * 生产路径**不该**调它——生产走 `primeSyncBackend()` 读设置。
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
 * 未预解析过时返回**锁定占位后端**（fail-closed），并**出声告警** ——
 * 「配好 WebDAV 却因为没 await primeSyncBackend() 而本轮中止」必须被看见，
 * 而不是变成一轮无解释的失败。
 */
export function getActiveSyncBackend(): SyncBackendPort {
  if (overrideBackend) return overrideBackend;
  if (!activeBackend) {
    void primeSyncBackend();
    logWarn(
      '[sync-backend] 后端尚未预解析，本次按「未配置/未解锁」处理。' +
        '若你配置过 WebDAV，请检查调用方是否在用之前 await primeSyncBackend()。'
    );
    return lockedBackend('同步后端尚未就绪，本次同步已中止。请稍后重试，或到设置里重新填写云盘信息。');
  }
  return activeBackend;
}

/**
 * 显式指定后端。调用方：
 *   · 测试（注入替身，替代原先空转的 setSyncPort）
 *   · 后续阶段的设置层（用户改完云盘配置后重解析）
 */
export function setActiveSyncBackend(backend: SyncBackendPort): void {
  overrideBackend = backend;
}

/** 恢复默认解析（读设置重建）。测试的 afterEach 用。 */
export function resetActiveSyncBackend(): void {
  overrideBackend = null;
  activeBackend = null;
}

export type { SyncBackendPort, SyncBackendId, RemoteGroupFingerprint, UploadGroupsResult } from './ports';
export { LockedBackendError, isLockedBackendError } from './lockedBackendError';

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
 * ── 失败语义（2026-10-16 云端下线后的最终口径）──────────────────────────
 * 唯一的失败语义现在只剩一种：「自带存储本轮不可用（存储读失败 / 未配置 /
 * 未解锁）」⇒ 返回**锁定占位后端**，绝不抛错。
 *
 *   · 不抛错：同步是附加功能，不该让整个扩展打不开。
 *   · 不兜底到别的后端：云端后端已删除，**没有第二个可去的地方**。
 *     旧代码这里兜底 Supabase，而那在 P0 修复后就已经是错的语义
 *     （详见 .memory/fallback-catch-must-not-equal-pre-fix-behavior.md）。
 *   · 这条 catch 只是**预期外异常**的兜底（工厂/构造器抛错等）：
 *     「设置/凭据读不到」三类原因已由 `resolveBackendOutcome()` 内部按
 *     起因分级出声并返回锁定占位，不会走到这里。走到这里则用 logError。
 */
export async function resolveConfiguredBackend(): Promise<SyncBackendPort> {
  try {
    const outcome = await resolveBackendOutcome();
    activeBackend = outcome.backend;
    return outcome.backend;
  } catch (err) {
    logError('[sync-backend] 解析后端失败（读不到设置存储），本轮中止同步:', err);
    activeBackend = lockedBackend(
      '读不到同步设置，已中止本次同步。请关闭扩展后重试，或到设置里重新填写云盘信息。'
    );
    return activeBackend;
  }
}

interface ResolutionOutcome {
  backend: SyncBackendPort;
  /** 实际解析到的后端 id（锁定占位后端的 id 也是 'webdav'，不算回落）。 */
  resolvedId: SyncBackendId;
  /** 用户想要的后端 id。云端下线后恒为 'webdav'。 */
  requestedId: SyncBackendId;
  /**
   * 回落原因（2026-10-16 起**恒为 undefined**：已无第二个后端可回落）。
   * 保留字段是为了 UI / 日志的读取点不用改；生产代码不应再依赖它。
   */
  fallbackReason?: string;
  /**
   * 锁定原因（resolvedId === requestedId === 'webdav' 但后端被锁定）。
   * 有它 ⇒ 后端是占位，任何同步操作都会抛这句错。UI 据此展示「去解锁」。
   */
  lockedReason?: string;
  /**
   * 锁定的**机器可读分类**（2026-10-16 审查 L4 新增）。
   *
   * 为什么不能只靠 lockedReason 的文案：UI（backendStatus.ts）要区分
   * 「未配置 / 未解锁 / 状态不可读」三种下一步动作，而这三个事实只存在于
   * 中文文案里。用正则匹配文案 = 改一处文案静默改变 UI 分类（且方向不可控：
   * 可能把存储故障显示成「未配置」，让用户去填一个已经填过的表单）。
   * 分类在**产生点**标注，读取方优先信它；文案只作 fallback 与展示。
   */
  lockedKind?: LockedKind;
}

/**
 * 锁定态的机器可读分类（与 lockedReason 成对出现，见其注释）。
 *   · unconfigured —— 确认没配（用户去设置里填地址）；
 *   · locked      —— 配了但本次会话未解锁（重新输入应用密码与口令）；
 *   · error       —— 读不到配置/解锁状态（存储故障，重试或重新保存）。
 */
export type LockedKind = 'unconfigured' | 'locked' | 'error';

/**
 * 锁定占位后端（2026-10-14 修 P0；2026-10-16 成为唯一的失败终态）。
 *
 * 自带存储本轮不可用（没配好 / 没解锁 / 设置读失败）时的返回值。
 * id 仍是 'webdav'：水位键、UI 展示都不会把它误认成别的东西。
 * 每个方法都抛同一句错 —— 「失败要出声」，且出的是用户能行动的话。
 */
class LockedWebDavBackend implements SyncBackendPort {
  readonly id = 'webdav' as const;
  readonly label = '自带存储（WebDAV）';

  constructor(private readonly reason: string) {}

  private fail(): never {
    // LockedBackendError 而不是普通 Error：下游据此把「未配置/未解锁」
    // 与真实网络故障分开（见 ./lockedBackendError.ts 的完整论证）。
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

/**
 * 建一个锁定占位后端（2026-10-16）。
 *
 * 抽成工厂而不是到处 `new LockedWebDavBackend(reason)`：锁定后端是
 * 「不可用」这一事实的**唯一**表示，而它现在出现在 4 个失败分支里。
 * 散着 new 的时候没人能一眼数清「到底有几处会返回占位后端」——
 * 而这正是这次改造最需要被审的那条不变量。
 */
function lockedBackend(reason: string): SyncBackendPort {
  return new LockedWebDavBackend(reason);
}

async function resolveBackendOutcome(): Promise<ResolutionOutcome> {
  const requestedId: SyncBackendId = 'webdav';

  const locked = (lockedReason: string, lockedKind: LockedKind): ResolutionOutcome => ({
    backend: lockedBackend(lockedReason),
    resolvedId: 'webdav',
    requestedId,
    lockedReason,
    lockedKind,
  });

  let cfg: StoredWebDavConfig | null;
  try {
    cfg = await loadWebDavConfig();
  } catch (err) {
    // logError：连配置存储都读不到 ≠ 「确认没配」。前者要排查存储故障，
    // 后者去设置里填一下就好 —— 两种下一步动作完全不同，severity 必须分开。
    logError('[sync-backend] 读取云盘配置失败（存储不可读），已中止本次同步:', err);
    return locked(
      '自带存储的配置读取失败，已中止本次同步以免数据传到未知的地址。请稍后重试。',
      'error'
    );
  }
  if (!cfg) {
    // logWarn：读到了、确认没配 —— 用户可行动的已知状态，不是存储故障。
    logWarn('[sync-backend] 尚未配置云盘，已中止本次同步（到设置里填写云服务信息即可恢复）。');
    return locked('你还没有填写云服务信息，已中止本次同步。请到设置里完成配置。', 'unconfigured');
  }
  let secrets: { password: string; passphrase: string | null } | null;
  try {
    secrets = await getSessionSecrets(cfg.username);
  } catch (err) {
    // logError：与「确认未解锁」同层但不同因 —— 这是解锁状态**读不出来**，
    // 不是「读到了、没有凭据」。存储故障要按故障排查（日志里有 error 级）。
    logError('[sync-backend] 读取云盘解锁状态失败（会话存储不可读），已中止本次同步:', err);
    return locked(
      '自带存储的解锁状态读取失败，已中止本次同步。请重新输入应用密码与加密口令。',
      'error'
    );
  }
  if (!secrets) {
    // logWarn：读到了、确认这次会话还没解锁 —— 用户重新输入口令即可恢复。
    logWarn('[sync-backend] 云盘尚未解锁（本次会话没有口令），已中止同步（重新输入应用密码与加密口令即可恢复）。');
    return locked('本次还没有解锁云服务，已中止同步。请到设置里重新输入应用密码与加密口令。', 'locked');
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
 * 用户配好云盘 / 重新解锁之后不失效它，就会继续用旧实例——
 * 而这个 bug 的表现是「我明明填了却没生效」，极难自查。
 */
export function invalidateActiveSyncBackend(): void {
  if (!overrideBackend) activeBackend = null;
}

/**
 * 预解析后端（**异步**）。必须在任何同步动作之前 await 一次。
 *
 * 调用方（缺一不可）：
 *   · SW 启动（service-worker.ts 模块顶层）
 *   · 用户改完同步设置（WebDavSettings 保存成功之后）
 *   · 后台轮询闹钟触发时（backgroundSync.handleAlarm 开头）
 *   · 异步透传层首调用（`ensureBackendPrimed`，覆盖 popup/options 上下文首次调用）
 */
let lastResolution: (ResolutionOutcome & { at: string }) | null = null;

export async function primeSyncBackend(): Promise<ResolutionOutcome> {
  const outcome = await resolveBackendOutcome().catch(err => {
    // 最后一道网：resolveBackendOutcome 内部的读失败已按起因分级出声；
    // 这里兜的是工厂/构造器抛错这类「预期外」异常，保持 logError。
    logError('[sync-backend] 预解析后端失败，本轮中止同步:', err);
    const backend = lockedBackend('读不到同步设置，已中止本次同步。请稍后重试。');
    // ⚠️ lockedReason/lockedKind 必须一起带上（2026-10-16 审查 L4 连带修复）：
    // 修复前这个 outcome 两者都缺，getLastBackendResolution() 的读者
    // （backendStatus.classifyBackendResolution）看到「无锁定原因」会判成
    // **ready 绿点** —— 存储故障时 UI 宣称「已配置并解锁」，正是这层分类
    // 要防的假绿灯。任何走到这条 catch 的结果都是「状态不可读」。
    return {
      backend,
      resolvedId: 'webdav' as SyncBackendId,
      requestedId: 'webdav' as SyncBackendId,
      lockedReason: '读不到同步设置，已中止本次同步。请稍后重试。',
      lockedKind: 'error' as LockedKind,
    };
  });
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
 * 最近一次解析的结果（含是否处于锁定态）。
 *
 * 读者：HeaderDropdown 的同步状态行、OptionsPage 的自动同步开关（都经
 * `components/layout/backendStatus.ts` 的 classifyBackendResolution），
 * 以及 tests/webdavWiring.test.ts。它们优先读 `lockedKind`（机器分类），
 * `lockedReason` 作文案与 fallback（论证见 ResolutionOutcome.lockedKind）。
 * 云端后端已删除，`fallbackReason` 现在恒为 undefined。
 */
export function getLastBackendResolution(): (ResolutionOutcome & { at: string }) | null {
  return lastResolution;
}
