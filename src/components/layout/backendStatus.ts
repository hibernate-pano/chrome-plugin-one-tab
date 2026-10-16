/**
 * 同步后端状态 → UI 展示的映射（2026-10-16，Wave 2B 缺陷 1 / 3）。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────────
 * 菜单里的同步状态行曾是一个**写死的绿点 + 「自带存储」**（无任何判据），
 * 于是未配置 / 未解锁 / 后端解析失败的用户也看到「已连接」。设置页的
 * 「自动同步」开关同样可以在从未配置云盘时被打开，并弹出一句
 * 「每 10 分钟同步一次」——而它永远不会跑。
 *
 * 真值只有一个：`src/sync-backend` 的 `getLastBackendResolution()`。
 * 本模块把它翻译成 UI 状态（颜色 / 文案 / 是否可行动），**不做任何网络探测**：
 * 解析成功只证明「配置在、本次会话已解锁」，不证明云盘可达或口令正确——
 * 所以 ready 态只说「已配置并解锁」，不使用「连接正常」这类未经检查的措辞。
 *
 * ── 为什么按 lockedKind 机器字段分类（2026-10-16 审查 L4 升级）──────────
 * `getLastBackendResolution()` 的公开形状含 `lockedReason?: string` 与
 * `lockedKind?: 'unconfigured' | 'locked' | 'error'`。分类**优先读机器字段**：
 * 未配置与未解锁的区分在 sync-backend 的产生点标注，不依赖中文措辞。
 * 正则匹配只作兜底（对没有 lockedKind 的历史形状/测试桩生效），且分类规则
 * 故意**保守**：任何没见过的原因一律按 error（红色）展示——宁可说
 * 「状态不可读」，也不把未知状态猜成「已解锁」或「未配置」。
 */
import type { getLastBackendResolution } from '@/sync-backend';

/** 最近一次后端解析结果（`null` = 尚未解析）。 */
export type BackendResolution = ReturnType<typeof getLastBackendResolution>;

export type BackendStatusKind = 'ready' | 'locked' | 'unconfigured' | 'error' | 'unknown';

export interface BackendStatus {
  kind: BackendStatusKind;
  /** 圆点色档：ok=绿，warn=琥珀（需要用户动作），muted=灰（还没配置），error=红。 */
  tone: 'ok' | 'warn' | 'muted' | 'error';
  /** 「自带存储 · 」之后的状态短语。 */
  label: string;
  /** 未就绪时是否应提供「去设置」入口。 */
  actionable: boolean;
  /** 原始锁定原因（排查用；不要整段当用户文案渲染）。 */
  lockedReason?: string;
}

/** 未解析时的保守值：不显示绿点、不声称任何状态。 */
export const UNKNOWN_BACKEND_STATUS: BackendStatus = {
  kind: 'unknown',
  tone: 'muted',
  label: '状态未知',
  actionable: true,
};

/** 色档 → Tailwind 圆点类（集中一处，避免状态与颜色各改各的）。 */
export const BACKEND_STATUS_DOT_CLASS: Record<BackendStatus['tone'], string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  muted: 'bg-gray-400',
  error: 'bg-red-500',
};

/** 状态 → 悬浮说明（读屏/悬停都能拿到「为什么是这个颜色」）。 */
export const BACKEND_STATUS_TITLE: Record<BackendStatusKind, string> = {
  ready: '云盘已配置，且本次浏览器会话已解锁；实际网络连通性不在这里检查',
  locked: '云盘已配置，但本次浏览器会话还没有解锁：重新输入应用密码与加密口令后同步才会继续',
  unconfigured: '还没有配置云盘：到设置里填写 WebDAV 地址并保存后才会开始同步',
  error: '读不到云盘配置或解锁状态，同步暂不可用',
  unknown: '尚未确认云盘状态',
};

/**
 * 把一次真实解析结果翻译成 UI 状态。
 *
 * 2026-10-16（审查 L4）：判据从「lockedReason 文案正则」升级为
 * **lockedKind 机器字段优先**（sync-backend 的 ResolutionOutcome 在产生点
 * 标注分类），正则降级为兜底 —— 只对「没有 lockedKind 的解析结果」
 * （历史形状 / 测试构造的桩）生效。为什么必须这样：文案匹配让 UI 分类
 * 取决于另一处文件里的中文措辞，改一句文案就能把「存储故障」显示成
 * 「未配置」，把用户指向一个他已经做过的动作。
 *
 * 顺序有意为之：**先判「读失败」再判「未配置/未解锁」**（兜底路径同样遵守）。
 * `'自带存储的解锁状态读取失败…'` 同时含有「解锁」与「读取失败」两个词，
 * 先判解锁会把它误报成「确认未解锁」——那是把存储故障说成用户可自行解决的
 * 配置问题，方向刚好反了。
 */
export function classifyBackendResolution(res: BackendResolution): BackendStatus {
  if (!res) return UNKNOWN_BACKEND_STATUS;

  const reason = res.lockedReason;
  if (!reason) {
    // 有解析结果且没有锁定原因 ⇒ 解析出了真实适配器（配置在 + 已解锁）。
    return {
      kind: 'ready',
      tone: 'ok',
      label: '已配置并解锁',
      actionable: false,
    };
  }

  // ── 机器字段优先（2026-10-16 L4）─────────────────────────────────────
  // lockedKind 由 sync-backend 在锁定原因的产生点标注，不经过文案，是稳的。
  if (res.lockedKind === 'unconfigured') {
    return { kind: 'unconfigured', tone: 'muted', label: '未配置', actionable: true, lockedReason: reason };
  }
  if (res.lockedKind === 'locked') {
    return { kind: 'locked', tone: 'warn', label: '未解锁', actionable: true, lockedReason: reason };
  }
  if (res.lockedKind === 'error') {
    return { kind: 'error', tone: 'error', label: '状态不可读', actionable: true, lockedReason: reason };
  }

  // ── 兜底：没有机器字段时才匹配文案（顺序：先读失败，再未配置，再解锁）──
  if (/读取失败|读不到|尚未就绪/.test(reason)) {
    return { kind: 'error', tone: 'error', label: '状态不可读', actionable: true, lockedReason: reason };
  }
  if (/还没有填写|未配置/.test(reason)) {
    return { kind: 'unconfigured', tone: 'muted', label: '未配置', actionable: true, lockedReason: reason };
  }
  if (/解锁|应用密码|口令/.test(reason)) {
    return { kind: 'locked', tone: 'warn', label: '未解锁', actionable: true, lockedReason: reason };
  }
  // 没见过的原因：如实说「不可读」，不猜。
  return { kind: 'error', tone: 'error', label: '状态不可读', actionable: true, lockedReason: reason };
}

/**
 * 「自动同步」开关是否允许打开。判据只有一条：后端已配置且本次会话已解锁。
 *
 * 为什么抽成函数而不是留在 OptionsPage 的 handler 里：本仓库没有 DOM 测试
 * 环境，内联判断只能在源码里「看着对」；把判据抽出来后，测试可以拿真实的
 * `primeSyncBackend()` 结果（未配置 / 未解锁 / 已解锁）直接验证三种状态
 * 下放行与否——证伪「无论后端怎样都放行」的常量实现。
 */
export function canEnableAutoSync(status: BackendStatus): boolean {
  return status.kind === 'ready';
}

/**
 * 格式化「上次成功同步」的相对时间。
 *
 * 数据源是 `storage.getLastSyncTime()`（LAST_SYNC_TIME 键）。该键由
 * syncEngine 在**三类成功路径**写入：下载探活命中（云端无变更）、下载合并
 * 完成、上传成功。它不区分手动/后台，所以文案是「上次成功同步」，
 * **不能**再说「最后手动同步」——后台轮询也会刷新它。
 *
 * 非法日期返回 null（调用方据此不渲染整行）：宁可没有这一行，
 * 也不显示 `Invalid Date` 这种由坏数据编出来的「事实」。
 */
export function formatLastSyncTime(iso: string, now: Date = new Date()): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const diffMs = now.getTime() - then.getTime();
  // 时钟回拨 / 未来时间戳：不显示负数，按「刚刚」处理（比编一个负分钟数诚实）。
  if (diffMs < 60_000) return '刚刚';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
