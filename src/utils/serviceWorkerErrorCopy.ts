/**
 * Service Worker 回包错误 → 用户可见中文文案的**唯一映射**（2026-10-19 审计 F-7）。
 *
 * 【为什么需要它】SW 是跨进程边界的后端，它的 `error` 字段会一路原样透到
 * 界面上。修复前它混着两种东西：
 *   · 中文句子（「本设备无法打开这些标签…」）
 *   · **英文机器串**（`no valid URLs`、`URL scheme not allowed`）
 *
 * 全中文界面里弹出「no valid URLs」，用户完全无从行动 —— 他不知道是
 * 「网址不合法」还是「扩展坏了」。
 *
 * 【本模块的形状】与仓库里已有的两条同源先例一致：
 *   · components/sync/syncPreviewView.ts 的 resolveSyncFailureCopy（同步 reason）
 *   · components/tabs/listErrorCopy.ts 的 toListErrorCopy（列表加载失败）
 *
 * 判据纪律：**机器码只进日志，中文只进界面**。
 */

/** 已登记的机器码 → 中文文案。 */
const REASON_COPY: Record<string, string> = {
  // ── service-worker.ts 的 OPEN_TAB / OPEN_TABS ──────────────────────────
  no_valid_urls: '这些网址在当前设备都无法打开（可能是本地文件、临时链接或浏览器内部页面）',
  url_scheme_not_allowed: '这个网址的协议不允许打开（浏览器内部页面或危险链接）',

  // ── 兼容历史上曾直接出现在 error 字段里的英文原文 ──────────────────────
  'no valid URLs': '这些网址在当前设备都无法打开（可能是本地文件、临时链接或浏览器内部页面）',
  'URL scheme not allowed': '这个网址的协议不允许打开（浏览器内部页面或危险链接）',
};

/**
 * 把 SW 的 error 字段翻译成用户能据以行动的中文。
 *
 * @param raw       SW 回包里的 error 字段（可能是中文句子，也可能是机器码）
 * @param fallback  认不出来时的兜底文案
 */
export const toServiceWorkerErrorCopy = (raw: unknown, fallback: string): string => {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  // 已经是中文句子：原样透出（它通常已经写清楚了原因与后果）。
  // 判据：含中文字符。
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;

  // 机器码：查表。
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  const hit = REASON_COPY[trimmed] ?? REASON_COPY[normalized];
  if (hit) return hit;

  // 未登记的机器码：不给用户看英文原文（那等于让用户去猜），
  // 统一落到兜底。原文由调用方记进 console。
  return fallback;
};

/**
 * 人类可读的机器码清单（供诊断导出与测试断言用）。
 */
export const KNOWN_SERVICE_WORKER_REASONS = Object.keys(REASON_COPY);
