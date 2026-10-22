/**
 * Toast **队列**的准入策略：谁可以被挤掉，谁不能。
 *
 * ── 这个模块在防什么（2026-10-23 审计 DS-43-12）──────────────────────────
 *
 * 队列原本是这么写的（`src/contexts/ToastContext.tsx`）：
 *
 * ```ts
 * setQueue(prev => [
 *   ...prev.slice(-2),      // ← 只保留最近 2 条
 *   { id, visible: true, message, type, duration, action },
 * ]);
 * ```
 *
 * `slice(-2)` 意味着**队列超过 3 条时，最老的那条被直接丢掉 —— 没有任何提示。**
 *
 * 这在「只有成功提示」的世界里无所谓（一条 3 秒后就自己没了的提示，
 * 被下一条顶掉没有任何损失）。但本产品有**两种提示不能被静默顶掉**：
 *
 *   ① **带动作的提示**（`action` = 「撤销」按钮）。它承载的是
 *      「恢复即消费」这条**不可逆删除的唯一退路**。
 *      被顶掉 ⇒ 用户连「原来这里可以撤销」都不知道 ⇒
 *      那次消费事实上没有退路 ⇒ 与「对外承诺的有退路」直接冲突。
 *   ② **错误提示**（`type === 'error'`，且没有动作 ⇒ 常驻，需用户手动关）。
 *      「失败提示始终会通知」是本仓既有的承诺
 *      （见 `tests/guards/failureNotificationsAlwaysSend.test.ts`）。
 *      错误提示被静默挤掉 ⇒ 用户以为操作成功了。
 *
 * ⇒ 这两类提示**不该被自动挤掉**。
 *
 * ── 为什么不是「把上限调大」───────────────────────────────────────────
 *
 * 上限 3 条是 2026-10-14 有意定的（error 常驻 + 其余 3s 自动退场）。
 * 单纯调大上限只是把「挤掉退路」变成「挤掉退路」的概率变小 ——
 * 丢数据这件事不该靠概率来防。
 *
 * ── 判据钉的是**性质**，不是字面量 ────────────────────────────────────
 *
 * 「队列最多几条」是**可以调的**（改文案、改视觉密度都可能动它）⇒
 * 守卫不该钉「长度 = 3」。真正的不变式是：
 *
 *   · **带动作的提示不会被静默丢弃**（退路不许因拥挤而消失）；
 *   · **错误提示不会被静默丢弃**（失败不许因拥挤而消失）。
 *
 * 允许它们被**用户自己**关掉、允许它们各自到期 —— 「静默丢弃」是唯一
 * 被禁止的结局。
 *
 * ── 挤掉的顺序：先挤「最不重要的」────────────────────────────────────
 *
 * 当队列超限时，先挤掉**既没有动作、又不是错误**的那条（普通成功/提示），
 * 因为它是**信息量最低、且自带倒计时**的那一类。
 * 如果全都不能挤（全是错误或都带动作）⇒ 队列**允许变长**
 * ⇒ 宁可屏幕上多堆几条，也不能丢掉一条「失败」或「退路」。
 */

/** 队列里一条提示的**准入性质**（不关心它的具体文案）。 */
export interface ToastQueueItem {
  /** 有没有动作按钮（「撤销」这类退路）。 */
  hasAction: boolean;
  /** 是不是错误提示。 */
  isError: boolean;
}

/**
 * 一条待入队的提示：**值** + 它的**准入性质**。
 *
 * 为什么把「值」和「性质」分开：队列里存的是完整的提示对象（消息、类型、
 * 时长、动作…），而准入策略只需要知道「有没有动作」「是不是错误」。
 * 把两个派生字段塞回队列项会污染那个对象的形状（它还被 Toast 组件消费）。
 */
export interface ToastQueueEntry<T> {
  value: T;
  hasAction: boolean;
  isError: boolean;
}

/** 队列默认最多同时堆叠几条。 */
export const TOAST_QUEUE_MAX = 3;

/**
 * 这条提示**能不能被自动挤掉**。
 *
 * false = 不可挤掉（带动作的退路 / 错误提示）。
 * true  = 可挤掉（普通信息类提示）。
 */
export const isEvictable = (item: ToastQueueItem): boolean =>
  !item.hasAction && !item.isError;

/**
 * 往队列里加一条新提示后的**准入结果**。
 *
 * @param existing  加之前已经在队列里的提示（旧的在前）。
 * @param incoming  新加的那条。
 * @param max       队列最多同时堆叠几条（默认 TOAST_QUEUE_MAX）。
 * @returns 保留后的提示**值**（顺序不变：旧的在前，新的在后）。
 */
export const admitToast = <T>(
  existing: readonly ToastQueueEntry<T>[],
  incoming: ToastQueueEntry<T>,
  max: number = TOAST_QUEUE_MAX,
): T[] => {
  const next = [...existing, incoming];
  if (next.length <= max) {
    return next.map(entry => entry.value);
  }
  // 超限 ⇒ 逐条挤掉**最早的可挤掉项**，直到回到上限。
  //
  // 为什么从最早的开始挤：队列是「先进先出」的语义 ——
  // 最新的那条刚出现，最不该被挤；最老的那条已经存在最久。
  //
  // ⚠️ 若一条都挤不掉（全是错误 / 全带动作）⇒ **允许超限**。
  //   宁可屏幕多堆几条，也不能静默丢掉一条「失败」或「退路」。
  const result: T[] = [];
  let overflow = next.length - max;
  for (const entry of next) {
    if (overflow > 0 && isEvictable(entry)) {
      overflow -= 1;
      continue;
    }
    result.push(entry.value);
  }
  return result;
};
