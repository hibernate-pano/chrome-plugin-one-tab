/**
 * 写操作（mutation）失败的用户可见文案（2026-10-19 审计 F-8）。
 *
 * 【为什么需要它】写路径的失败原本直接把底层异常原文拼给用户：
 *
 *   「更新会话失败: 操作超时（超过 30 秒无响应）：removeTab」
 *   「移动标签失败: SW 无响应」
 *
 * 用户看到的是**内部 op 名**（removeTab / updateGroup）与实现细节
 * （SW、协议超时），既读不懂也不知道下一步该做什么。排障的人却会被
 * 引到错误的方向（去查那个 op 的实现，而不是查存储或网络）。
 *
 * 【本仓库已有的同源先例】components/tabs/listErrorCopy.ts（列表加载失败）
 * 与 components/sync/syncPreviewView.ts（同步 reason）—— 它们的纪律完全
 * 一样：**原始异常只进日志，界面只说「发生了什么 + 下一步」**。
 * 写路径此前漏接了这条纪律，本模块把它补上。
 *
 * 【判据】按**操作语义**分类，而不是按错误文本：
 *   · 超时 → 「响应超时，请重试」
 *   · 存储不可用 → 「浏览器存储不可用（可能是空间不足或扩展无写入权限）」
 *   · 其它 → 「操作未能完成，请重试」
 * 原文由调用方记进 console（logError），不进界面。
 */

/** 一次写操作失败后，展示给用户的那句话。 */
export interface MutationFailureCopy {
  /** 界面上显示的完整句子（已含「什么操作失败了」）。 */
  message: string;
  /** 供日志使用的原始原因（不进界面）。 */
  raw: string;
}

/** 从任意异常里取出可读的原因文本（只用于日志与分类判据）。 */
const reasonOf = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
};

/**
 * 生成写操作失败的文案。
 *
 * @param operation 操作的**用户可读名**（「删除会话」「移动标签」…），
 *                  它是句子的主语，必须是用户懂的话。
 * @param error     原始异常（只用于分类与日志，不进界面）
 */
export const toMutationErrorCopy = (operation: string, error: unknown): MutationFailureCopy => {
  const raw = reasonOf(error);

  // 分类判据（只匹配少数几个稳定特征，不做泛化猜测）：
  if (/超时|timeout|timed out/i.test(raw)) {
    return {
      message: `${operation}失败：扩展没有及时响应，请稍后重试`,
      raw,
    };
  }
  if (/quota|storage|存储|ENOSPC/i.test(raw)) {
    return {
      message: `${operation}失败：浏览器存储不可用，请检查扩展存储空间后重试`,
      raw,
    };
  }
  if (/无响应|no response/i.test(raw)) {
    return {
      message: `${operation}失败：扩展后台没有响应，请重新打开扩展后重试`,
      raw,
    };
  }
  return {
    message: `${operation}失败，请重试`,
    raw,
  };
};

/**
 * 只取界面文案（多数调用点的用法）。
 */
export const mutationErrorMessage = (operation: string, error: unknown): string =>
  toMutationErrorCopy(operation, error).message;
