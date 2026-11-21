/**
 * 同步策略（纯判据层）—— 2026-11-21。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────
 * 这个扩展的同步是**轮询式**的：后台 alarm 每一轮问云端一次「有没有变」。
 * 每一轮的出网量 ∝ 库大小（指纹探活）⇒ 配额消耗 ∝ 用户数 × 设备数 × 库大小 × 轮数。
 * 之前唯一能拧的旋钮是「用户自己选的几分钟」，而用户**看不见**这件事的成本，
 * 于是成本被默认摊给了所有用户，直到项目被封（egress 配额是**项目级**的）。
 *
 * ⇒ 这一层把「什么时候问、问多勤、能不能问」从代码里抽出来，变成**一份可远程调整的策略**：
 *   · 开发者在不重新发版的情况下把节奏调慢 / 停掉自动同步 / 关掉预览；
 *   · 用户自己的档位（5/10/30/60 分钟）**永远不被这份策略改快**。
 *
 * ── 为什么策略不放在 settings 里（让用户自己调）────────────────────────────
 * 因为出网成本是**共享**的：100 个用户各慢 5 分钟，省下的是别人的配额。
 * 让用户自己省 = 把公共成本私有化 ⇒ 一定会有人不省 ⇒ 封禁照旧。
 * 所以这份策略由**开发者**控制（远端 JSON），用户的档位是**下限**而不是上限。
 *
 * ── 纯函数纪律 ────────────────────────────────────────────────────────────
 * 本文件**不许**碰 chrome.*、网络、时钟、随机数：
 *   · 时间的「现在」由调用方以 now 传入；
 *   · 抖动的随机量由调用方算好后作为 delay 传入（本文件不掷骰子）。
 * ⇒ 于是每一条策略都能在 node:test 里逐字断言（tests/syncPolicy.test.ts）。
 */

/** 一份同步策略。字段全部有「保守」方向上的默认值。 */
export interface SyncPolicy {
  /**
   * 自动同步总闸。false = 后台轮询与弹窗自动下载**全停**（手动同步仍可用）。
   *
   * 存在的意义：项目被封禁时、或配额逼近上限时，**不发新版本**也能止血。
   */
  autoSyncEnabled: boolean;

  /**
   * 自动同步间隔的**下限**（分钟）。只用于把间隔**拉长**。
   *
   * ⚠️ 它不是「设定值」：真正生效的间隔 = max(用户档位, 本下限) ⇒ 这份策略
   * **永远不可能让同步变快**（否则就是拿用户的数据新鲜度换开发者的流量，
   * 方向完全反了）。
   */
  minIntervalMinutes: number;

  /**
   * 空闲档的间隔（分钟）。**0 = 不启用空闲档**。
   *
   * 空闲 = 连续若干轮探活都判「云端无变更」。这时把间隔拉长，代价只是
   * 「另一台设备的改动晚一点到」；收益是**每个空闲用户的出网量按比例下降**。
   * 一旦有任何变更（有本地改动或云端有变更）立刻回到热档。
   */
  idleIntervalMinutes: number;

  /** 连续多少轮无变更算「空闲」。0 = 立刻进空闲档。 */
  idleRoundsBeforeSlowdown: number;

  /**
   * 弹窗自动下载的最小间隔（分钟）：距上次**成功同步**不足这个时间就跳过。
   *
   * 为什么需要它：自动下载没有任何间隔 ⇒ 用户一天开 50 次弹窗 = 50 轮完整周期
   * （每轮 6 个请求 + 一次指纹下载）⇒ 频繁开弹窗的用户按分钟级速度烧配额。
   */
  minAutoDownloadIntervalMinutes: number;

  /**
   * 同步弹窗预览是否允许。关掉 = 不做那次**全量**下载（预览本来就只为
   * 「破坏性操作前看一眼」，不是必须功能）。
   */
  previewEnabled: boolean;

  /**
   * 「指纹失败 ⇒ 回退全量下载」的冷却（分钟）。
   *
   * 背景：指纹探测失败（网络抖动、count 交叉校验不过）时，代码会回退成
   * **整库下载**。一次抖动多下一次全库可以接受；**持续**失败就是每轮全库
   * ⇒ 单设备出网量直接 ×8 ⇒ 这正是配额被打穿的形状之一。
   * ⇒ 冷却期内不再回退全量（本轮放弃，等指纹自己好）。
   */
  fullDownloadFallbackCooldownMinutes: number;

  /**
   * 抖动（秒）：每轮排下一轮时额外加的随机延迟。
   *
   * 为什么要抖：所有设备的 alarm 都是自己起的 ⇒ 不抖的话它们的轮次会逐渐
   * 同步（尤其在同一时刻装/升级的用户）⇒ 同一秒打一批请求 ⇒ 尖峰。
   * 抖动的代价是对齐精度下降几十秒，收益是**没有尖峰**。
   */
  jitterSeconds: number;

  /** 策略版本号（远端 JSON 里带，便于观测「用户跑的是哪一版策略」）。 */
  revision: number;
}

/**
 * 默认策略 —— **发布时的口径**。
 *
 * ⚠️ 每一项都要能回答「为什么是这个数」：
 *  · autoSyncEnabled=true：默认不停（停自动同步会毁掉跨设备体验，用户不会同意）。
 *  · minIntervalMinutes=5：等于用户可选档位的最小值 ⇒ 默认**不改变**任何用户的选择。
 *  · idleIntervalMinutes=30 + idleRoundsBeforeSlowdown=3：连续 3 轮（约 30 分钟）无变更后
 *    切到 30 分钟档 ⇒ 空闲用户（绝大多数时间）的自动出网降到 1/3；有变更立刻回热档。
 *  · minAutoDownloadIntervalMinutes=5：同一分钟里反复开弹窗不再重复拉云端。
 *  · previewEnabled=true：默认保留预览（它是破坏性操作前的安全闸）。
 *  · fullDownloadFallbackCooldownMinutes=60：抖动导致的偶发失败仍会回退全量，
 *    但**持续**失败最多每小时回退一次。
 *  · jitterSeconds=45：把同一分钟内的设备摊开到 45 秒内。
 */
export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  autoSyncEnabled: true,
  minIntervalMinutes: 5,
  idleIntervalMinutes: 30,
  idleRoundsBeforeSlowdown: 3,
  minAutoDownloadIntervalMinutes: 5,
  previewEnabled: true,
  fullDownloadFallbackCooldownMinutes: 60,
  jitterSeconds: 45,
  revision: 0,
};

/** 允许的区间（越界即视为非法 ⇒ 退回默认值）。 */
const LIMITS = {
  minIntervalMinutes: [5, 1440] as const,
  idleIntervalMinutes: [0, 1440] as const,
  idleRoundsBeforeSlowdown: [0, 100] as const,
  minAutoDownloadIntervalMinutes: [0, 1440] as const,
  fullDownloadFallbackCooldownMinutes: [0, 1440] as const,
  jitterSeconds: [0, 300] as const,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
};

/**
 * 把远端 JSON（形状未知、可能被人手改坏）并成一份**合法**策略。
 *
 * 纪律：
 *  · 非法字段**逐项**退回默认，而不是整份丢弃 —— 半份好策略好过没策略；
 *  · 布尔字段只认 `true`/`false`（字符串 'false' 不算 false：那种写法来自
 *    手改 JSON，而「把 'false' 当成 true」会把总闸打开 ⇒ 方向危险）；
 *  · **不能把间隔改小**：minIntervalMinutes 的下限是 5（用户可选档位的最小值），
 *    而真正生效的间隔还会再取 max(用户档位, 本值) ⇒ 双重保险。
 */
export const mergeSyncPolicy = (raw: unknown, base: SyncPolicy = DEFAULT_SYNC_POLICY): SyncPolicy => {
  if (!raw || typeof raw !== 'object') return { ...base };
  const r = raw as Record<string, unknown>;
  const autoSyncEnabled =
    typeof r.autoSyncEnabled === 'boolean' ? r.autoSyncEnabled : base.autoSyncEnabled;
  const revision = clampInt(r.revision, 0, 1_000_000, base.revision);
  return {
    autoSyncEnabled,
    minIntervalMinutes: clampInt(
      r.minIntervalMinutes,
      LIMITS.minIntervalMinutes[0],
      LIMITS.minIntervalMinutes[1],
      base.minIntervalMinutes,
    ),
    idleIntervalMinutes: clampInt(
      r.idleIntervalMinutes,
      LIMITS.idleIntervalMinutes[0],
      LIMITS.idleIntervalMinutes[1],
      base.idleIntervalMinutes,
    ),
    idleRoundsBeforeSlowdown: clampInt(
      r.idleRoundsBeforeSlowdown,
      LIMITS.idleRoundsBeforeSlowdown[0],
      LIMITS.idleRoundsBeforeSlowdown[1],
      base.idleRoundsBeforeSlowdown,
    ),
    minAutoDownloadIntervalMinutes: clampInt(
      r.minAutoDownloadIntervalMinutes,
      LIMITS.minAutoDownloadIntervalMinutes[0],
      LIMITS.minAutoDownloadIntervalMinutes[1],
      base.minAutoDownloadIntervalMinutes,
    ),
    previewEnabled:
      typeof r.previewEnabled === 'boolean' ? r.previewEnabled : base.previewEnabled,
    fullDownloadFallbackCooldownMinutes: clampInt(
      r.fullDownloadFallbackCooldownMinutes,
      LIMITS.fullDownloadFallbackCooldownMinutes[0],
      LIMITS.fullDownloadFallbackCooldownMinutes[1],
      base.fullDownloadFallbackCooldownMinutes,
    ),
    jitterSeconds: clampInt(
      r.jitterSeconds,
      LIMITS.jitterSeconds[0],
      LIMITS.jitterSeconds[1],
      base.jitterSeconds,
    ),
    revision,
  };
};

/** 轮询间隔的裁决结果。 */
export interface PollIntervalDecision {
  /** 真正用掉的周期（分钟）。 */
  periodMinutes: number;
  /** 这一轮是不是「空闲档」。 */
  cold: boolean;
  /** 一句话原因，落日志。 */
  reason: string;
}

/**
 * 决定下一轮后台同步的周期。
 *
 * 规则（顺序即语义）：
 *  1. 用户的档位是**下限**：period ≥ userIntervalMinutes（策略只能更慢）。
 *  2. 空闲档：连续空闲轮数 ≥ idleRoundsBeforeSlowdown 且 idleIntervalMinutes > 0
 *     ⇒ period = max(用户档位, 空闲档间隔)。
 *  3. 否则（热档）：period = max(用户档位, 策略下限)。
 */
export const decidePollInterval = (input: {
  userIntervalMinutes: number;
  policy: SyncPolicy;
  consecutiveIdleRounds: number;
}): PollIntervalDecision => {
  const user = Math.max(1, Math.round(input.userIntervalMinutes));
  const { policy, consecutiveIdleRounds } = input;
  const floor = Math.max(user, policy.minIntervalMinutes);
  const idleEnabled = policy.idleIntervalMinutes > 0;
  const idleReached = consecutiveIdleRounds >= policy.idleRoundsBeforeSlowdown;
  if (idleEnabled && idleReached) {
    const period = Math.max(floor, policy.idleIntervalMinutes);
    return {
      periodMinutes: period,
      cold: true,
      reason: `连续 ${consecutiveIdleRounds} 轮无变更 → 空闲档 ${period} 分钟（用户档位 ${user} 分钟）`,
    };
  }
  return {
    periodMinutes: floor,
    cold: false,
    reason: `热档 ${floor} 分钟（用户档位 ${user} 分钟）`,
  };
};

/** 弹窗自动下载的裁决结果。 */
export interface AutoDownloadDecision {
  allowed: boolean;
  reason: string;
}

/**
 * 弹窗自动下载能不能跑。
 *
 * ⚠️ **手动同步不走这里** —— 用户点的「同步」必须立刻执行。
 */
export const decideAutoDownload = (input: {
  policy: SyncPolicy;
  /** 上次成功同步的时间戳（毫秒）；null = 从没成功过。 */
  lastSyncAt: number | null;
  now: number;
}): AutoDownloadDecision => {
  if (!input.policy.autoSyncEnabled) {
    return { allowed: false, reason: '远程策略已停用自动同步' };
  }
  const minGapMs = input.policy.minAutoDownloadIntervalMinutes * 60_000;
  if (input.lastSyncAt != null && minGapMs > 0) {
    const since = input.now - input.lastSyncAt;
    if (since >= 0 && since < minGapMs) {
      return {
        allowed: false,
        reason: `距上次成功同步不足 ${input.policy.minAutoDownloadIntervalMinutes} 分钟`,
      };
    }
  }
  return { allowed: true, reason: '允许自动下载' };
};

/** 指纹失败后能否回退全量下载。 */
export interface FullDownloadFallbackDecision {
  allowed: boolean;
  reason: string;
}

/**
 * 「指纹探测失败 ⇒ 回退整库下载」能不能做。
 *
 * 首次同步与覆盖下载**必须**走全量（它们没有增量可言），不受冷却限制。
 * 其余情况下，冷却期内**不再**回退全量：本轮放弃，等指纹自己好。
 */
export const decideFullDownloadFallback = (input: {
  policy: SyncPolicy;
  /** 上次全量下载的时间戳（毫秒）；null = 从没发生过。 */
  lastFullDownloadAt: number | null;
  now: number;
  isFirstSync: boolean;
  forceRemote: boolean;
}): FullDownloadFallbackDecision => {
  if (input.isFirstSync) return { allowed: true, reason: '首次同步必须全量' };
  if (input.forceRemote) return { allowed: true, reason: '覆盖下载必须全量' };
  const cooldownMs = input.policy.fullDownloadFallbackCooldownMinutes * 60_000;
  if (input.lastFullDownloadAt != null && cooldownMs > 0) {
    const since = input.now - input.lastFullDownloadAt;
    if (since >= 0 && since < cooldownMs) {
      return {
        allowed: false,
        reason:
          `距上次全量下载不足 ${input.policy.fullDownloadFallbackCooldownMinutes} 分钟，` +
          '本轮不回退全量（持续回退 = 每轮整库 = 配额被打穿的形状）',
      };
    }
  }
  return { allowed: true, reason: '允许回退全量' };
};

/** 同步弹窗预览能不能做。 */
export const decidePreview = (policy: SyncPolicy): { allowed: boolean; reason: string } => {
  if (!policy.previewEnabled) {
    return {
      allowed: false,
      reason: '远程策略已停用同步预览（预览要整库下载）',
    };
  }
  return { allowed: true, reason: '允许预览' };
};
