/**
 * 「云端现在在不在服务」—— **问一句**（IO 层，2026-10-23，第 51 轮）。
 *
 * ── 为什么必须先问，而不是直接让 SDK 去问 ────────────────────────────────
 * 2026-10-23 生产实测：整个 Supabase 项目被限制（`exceed_egress_quota`），
 * **所有**端点都返回 402，包括 `/auth/v1/health`。
 *
 * 而 auth SDK 读会话时，若本地会话已过期，它会**去刷新**（POST /auth/v1/token）。
 * 刷新撞上 402 时的后果（本轮实测，见 tests/guards/authSessionSurvivesOutage.test.ts）：
 *   ① SDK 认定「刷新令牌被拒」⇒ **删掉用户存储里的会话**（一次云端故障 = 全员被登出）；
 *   ② SDK 把它当「瞬时故障」⇒ **连打 8 次、退避 25.4 秒**（`_refreshAccessToken` 的
 *      `retryable()`：200/400/…/12800ms，直到下一次退避会越过 30 秒的 tick 窗口）。
 *
 * ⇒ 这两件事都发生在**我们的代码之外** ⇒ 我们唯一能提前躲开它们的办法是：
 * **在碰 SDK 之前，先自己问一句「云端在吗」**。
 *
 * ── 为什么问 `/auth/v1/health` ───────────────────────────────────────────
 * · 它**不需要用户会话**（只要 apikey）⇒ 没登录也能问；
 * · 它**不受项目限制的影响**地返回 402（实测）⇒ 「项目被限制」这一档判得出来；
 * · 它**极轻**（几十字节）⇒ 问一句的代价远小于「打 8 次、拖 25 秒」。
 *
 * ── 判据只看状态码，不看文案 ─────────────────────────────────────────────
 * 402/503/52x = 「服务端现在不服务」；401/403 = 「**网关拒了我们的 key**」
 * （生产实测：apikey 缺失或不对 ⇒ 401「Invalid API key」；见
 * core/cloudAvailability.ts 的 PROBE_KEY_REJECTED_STATUSES）⇒ 同样不可用；
 * 其余任何应答 = 「它在服务」（哪怕是 404：那说明**它答了**）；
 * 连不上（断网/超时）= **不知道**（不许读成「不可用」，也不许读成「在服务」）。
 */
import {
  BackendUnavailableError,
} from '@/core/backendUnavailable';
import {
  classifyAvailabilityStatus,
  type CloudAvailability,
} from '@/core/cloudAvailability';
import { getSupabaseConfig } from './config';
import { outageTracker } from './outageTracker';

export type { CloudAvailability };

/** 探活端点（要 apikey，不要用户会话）。 */
const PROBE_PATH = '/auth/v1/health';

/**
 * 问一句的上限（毫秒）。
 *
 * ⚠️ 必须**短于**读会话的上限（5 秒，见 sessionRead.ts）：探活是为了**早失败**，
 * 不是为了把等待拉长。总等待 = 探活 + 读会话，两段都有界。
 */
const PROBE_TIMEOUT_MS = 3_000;

/** 一次探活的结果：结论 + 拿到的状态码（诊断用）。 */
export interface CloudProbeResult {
  /** 结论。 */
  kind: CloudAvailability;
  /** 探活拿到的 HTTP 状态码（连不上时为 null）。 */
  status: number | null;
}

/**
 * 问云端一句「你在服务吗」。
 *
 * ⚠️ **只发一个请求，不重试**：问的就是「你还活着吗」，重问一遍不会让死人活过来，
 * 只会把用户的等待拉长（与本仓「重试无用就别说重试」同源）。
 */
export const probeCloudAvailability = async (): Promise<CloudProbeResult> => {
  const config = getSupabaseConfig();
  // 没配 ⇒ 不是「不可用」，是「不知道」（让下游按自己的方式处理）。
  if (!config) return { kind: 'unknown', status: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.url}${PROBE_PATH}`, {
      method: 'GET',
      headers: { apikey: config.anonKey },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (classifyAvailabilityStatus(res.status) === 'unavailable') {
      // 「服务端项目被限制」这一档是**项目级**的（网关中间件拦的）⇒
      // 它对所有端点一视同仁 ⇒ 凭这一句就够判「整个云端不服务」。
      outageTracker.noteUnavailable();
      return { kind: 'unavailable', status: res.status };
    }

    // 其它状态码（含 2xx / 404 / 429）：**它答了** ⇒ 它在服务。
    outageTracker.noteAvailable();
    return { kind: 'available', status: res.status };
  } catch {
    // 断网 / 超时 / 被拦 ⇒ **不知道**（不许读成「不可用」）。
    return { kind: 'unknown', status: null };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 「云端在吗」的前置闸门：**不可用就不许往下走**。
 *
 * 走不下去的原因很实在：往下的那一步是 **SDK 去刷新会话**，而刷新撞上 402
 * 会把用户的会话删掉（一次云端故障 = 一次全员登出）。
 *
 * ⚠️ 只在**明确不可用**时拦；「不知道」**放行** ——
 * 探活失败可能只是这一句被网络挡了，而会话本身还读得到
 * （本地会话没过期时，SDK 读它**根本不需要联网**）⇒ 拦住反而会丢信息。
 *
 * ⚠️ 抛的是 **BackendUnavailableError**（带机器标记 `code`）而不是普通 Error：
 * 这条错误要穿过好几层（探活 → 读会话 → 同步引擎 → 界面），
 * 而每一层都只透传 message 的话，机器判据到不了最后一层
 * （与 core/backendUnavailable.ts 的注释同源）。
 *
 * ⚠️ **状态码不许写死**（2026-10-23，第 51 轮）：探活明明知道真实状态
 * （402 / 503 / 52x / 401），却一律报 402 ⇒ 诊断导出与后台日志里，
 * 503 会被写成 402 ⇒ 排查时会被带偏。
 */
export const requireCloudAvailable = async (label: string): Promise<void> => {
  // ── 记忆窗口（5 秒）：一轮同步里读会话有 6-8 个点 ⇒ 别问 6-8 次 ─────────
  // 这个项目刚因 egress 配额被封过 ⇒ 往一个正在计配额的项目上加请求是加伤口。
  const observed = outageTracker.recentObservation();
  if (observed === 'unavailable') {
    // 刚刚观测到「不在服务」⇒ 直接报错（省掉一次往返，也**不等**它恢复）。
    throw new BackendUnavailableError(`云端项目暂时不可用（${label}）`);
  }
  if (observed === 'available') {
    // 刚刚问过、它答了 ⇒ 不再问（省掉往返）。
    return;
  }

  const probe = await probeCloudAvailability();
  if (probe.kind === 'unavailable') {
    throw new BackendUnavailableError(
      `云端项目暂时不可用（${label}）`,
      probe.status ?? undefined,
    );
  }
};
