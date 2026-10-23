/**
 * 「等到期限」的等待（IO 层的小工具）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 2026-10-23（第 51 轮）：`@supabase/auth-js` 的刷新失败会**连打 8 次、
 * 退避 25.4 秒**（`_refreshAccessToken` 的 `retryable()`）⇒ 云端一挂，
 * 任何「等它回来」的调用都会把界面卡住 25 秒 ⇒
 * 用户看到的是「转圈 25 秒」，而**我们连一句「云端暂时不可用」都来不及说**。
 *
 * ⇒ 凡是「等它回来只是为了多知道一件事」的调用，都必须有一个**上限**：
 * 到了上限就是「**不知道**」（而不是「没有」）——
 * 这与本仓「不知道 ≠ 没有」那条纪律同源。
 *
 * ── 为什么**不取消**底层任务 ────────────────────────────────────────────
 * `Promise.race` 的性质：输的那条路**继续跑**。这里要的就是「不等了」，
 * 不是「中止」—— 中止会让我们自己的请求逻辑变得难以推理。
 * ⇒ 但底层任务**后来失败**时必须有人接住，否则会变成 unhandled rejection
 * （MV3 的 service worker 里会刷一串红字，看起来像崩溃）。
 */

/** 「等到期限了」的标记错误（区别于任何其它失败）。 */
export class DeadlineExceededError extends Error {
  /** 稳定的机器码（跨层识别用，不解析 message）。 */
  readonly code: string = 'deadline_exceeded';

  constructor(label: string, ms: number) {
    super(`等待「${label}」超过 ${Math.round(ms / 1000)} 秒`);
    this.name = 'DeadlineExceededError';
  }
}

/** 这个错误是「等到期限了」吗？（跨 realm 安全：既认类也认 `code` 字段） */
export const isDeadlineExceeded = (err: unknown): boolean => {
  if (err instanceof DeadlineExceededError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === 'deadline_exceeded';
};

/**
 * 给一个 Promise 套一层等待上限。
 *
 * ⚠️ **不会取消底层任务**（见文件头）⇒ 它的失败必须被接住（见下）。
 *
 * @param p     底层 Promise
 * @param ms    上限（毫秒）
 * @param label 出现在错误消息里的名字（诊断用）
 */
export const withDeadline = async <T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<T> => {
  // 底层任务继续跑；它后来的失败在这里被接住（否则是 unhandled rejection）。
  void p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineExceededError(label, ms)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
