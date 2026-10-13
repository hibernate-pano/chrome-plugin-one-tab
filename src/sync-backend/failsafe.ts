/**
 * 删除熔断（2026-10-13，WebDAV 自带存储改造 · 阶段 2；判据抄 Floccus 的
 * failsafe，见 docs/webdav-selfhost-sync-plan.md §4.4）。
 *
 * ── 为什么必须有（这是文件后端上线的前置，不是增强）────────────────────
 * 文件后端引入两条「远端看起来变空了」的路径：
 *   · 用户在云盘里清空/移动了 groups 目录 ⇒ 远端读回 0 个组
 *   · manifest 损坏 / 分页只读到一半 ⇒ 远端读回少了一半组
 * 若同步把「远端少了」直接理解为「用户删了这些组」并照做，用户本机的会话
 * 会被一起清掉；而本产品没有回收站，不可逆。
 * 人类不会在一次同步里删掉两成以上的库，所以「要删的量异常大」本身就是
 * 「读取链路出了问题」的证据 —— 此时正确的动作是中止并发一条可读错误，
 * 而不是猜用户的意图继续删。
 *
 * ── 数字从哪来（不是拍脑袋）──────────────────────────────────────────
 * 20% 是 Floccus 常规书签档的事实值；minTotal 给比例判断设下限
 * （否则 3 条的库删 1 条就是 33% 熔断，正常使用寸步难行）；maxChanged
 * 给绝对量设上限（大库的 20% 可能上万条，远超任何人类一次操作）。
 * 判据原式（**严格大于**：恰好等于阈值不算熔断）：
 *   (totalBefore > minTotal && deleteCount / totalBefore > ratio) || deleteCount > maxChanged
 */

/** 熔断判据的参数（默认值对齐 Floccus 的常规书签档） */
export interface FailsafeLimits {
  /** 低于这个总数不做比例判断（避免小库误报） */
  minTotal: number;
  /** 比例阈值：删除占比 > ratio 即熔断 */
  ratio: number;
  /** 绝对上限：删除数 > maxChanged 即熔断（无论比例） */
  maxChanged: number;
}

export const DEFAULT_FAILSAFE_LIMITS: FailsafeLimits = {
  minTotal: 5,
  ratio: 0.2,
  maxChanged: 1000,
};

export interface FailsafeVerdict {
  allowed: boolean;
  /** 不允许时的可读原因（中文，直接给用户看） */
  reason?: string;
}

/**
 * 判断「本次同步打算删除 N 条」是否允许。
 *
 * deleteCount <= 0 直接放行：没有删除就没有误删风险，不必给「什么都没删」
 * 的正常同步再加一道判定。
 */
export function checkDeleteFailsafe(
  totalBefore: number,
  deleteCount: number,
  limits?: Partial<FailsafeLimits>
): FailsafeVerdict {
  const { minTotal, ratio, maxChanged } = { ...DEFAULT_FAILSAFE_LIMITS, ...limits };

  if (deleteCount <= 0) return { allowed: true };

  const overRatio = totalBefore > minTotal && deleteCount / totalBefore > ratio;
  const overAbsolute = deleteCount > maxChanged;
  if (!overRatio && !overAbsolute) return { allowed: true };

  // 文案必须说清「删了多少」与「相对什么量」：用户才能判断这是自己删的
  // 还是同步读错了。只说「已熔断」的错误信息无法指导下一步动作。
  if (overRatio) {
    const percent = Math.round((deleteCount / totalBefore) * 100);
    return {
      allowed: false,
      reason: `本次同步将删除 ${deleteCount} 个会话，占同步前 ${totalBefore} 个会话的 ${percent}%，超过安全阈值（${Math.round(ratio * 100)}%），已中止以避免误删`,
    };
  }
  return {
    allowed: false,
    reason: `本次同步将删除 ${deleteCount} 个会话，超过单次删除上限 ${maxChanged} 个，已中止以避免误删`,
  };
}
