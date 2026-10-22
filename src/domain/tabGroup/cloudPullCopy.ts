/**
 * 「从云端拉回会话」这个动作的**唯一措辞出处**（2026-10-22 审计 WC-13）。
 *
 * ── 为什么这个词必须换（缺陷本体） ──────────────────────────────────────
 *
 * 本产品里「**恢复**」已经有明确且唯一的含义：
 * **打开某个会话的标签，并把那条记录消费掉**（列表页的「恢复整个会话」、
 * `restoreOutcomePhrase` 的「从列表移除」）。用户学会了这个动词。
 *
 * 而空态那个出口原先叫「**从云端恢复会话**」—— 它做的却是**另一件事**：
 * 把云端的会话列表拉到本机（一次 download + merge），**不打开任何标签**、
 * **不消费任何记录**。
 *
 * ⇒ 学过「恢复 = 打开并消费」的用户点它，期待的是「打开」，而它只是下载了一份
 * 列表。两个不同的动作用同一个动词，是**承诺与事实不符**。
 *
 * ⇒ 统一改说「**拉回**」：仓库文档里本来就在用这个说法
 * （README「登录成功时立即从云端拉回一次」），它只描述「把列表取回来」，
 * 不与「打开并消费」撞车。
 *
 * ── 为什么放在 domain 层 ───────────────────────────────────────────────────
 *
 * 这段文案出现在**四个**地方：空态出口按钮、它的悬停说明、它的成功/失败回执、
 * 登录成功后的 toast。后两者分别在 `components/auth/` 与 `components/tabs/` ——
 * 放在 components 层就得让 auth 反向依赖 tabs。⇒ 放 domain 层，四处共用一份。
 *
 * ── 措辞只写一处 ──────────────────────────────────────────────────────────
 *
 * 同一个动作在四个出口各写一遍，迟早漂成四个说法（本仓反复修过的同一类问题，
 * 见 `restoreFeedbackCopy` / `saveFeedbackCopy` 的文件头）。
 */

/**
 * 这个动作在界面上的**共同动词**。
 *
 * 判据钉的是**它**（一个词），不是某一句文案：
 * 出口标签、补充说明、成功回执、失败回执都必须用它 ——
 * 同一个动作在不同出口必须是**同一个说法**。
 */
export const CLOUD_PULL_VERB = '拉回';

/** 空态出口按钮上的可见文字。 */
export const CLOUD_PULL_ACTION_LABEL = '从云端拉回会话';

/** 空态出口按钮的补充说明（悬停 / 读屏）。 */
export const CLOUD_PULL_ACTION_HINT = '把云端会话拉回本机并合并，不会清掉本地内容';

/** 空态出口按钮在途时的文字。 */
export const CLOUD_PULL_BUSY_LABEL = '拉回中…';

/** 拉到了东西：按真实条数说话，不谎报。 */
export const cloudPullSuccessMessage = (count: number): string =>
  `已从云端拉回 ${count} 个会话`;

/** 云端本来就是空的（拉回成功，但一条都没有）。 */
export const cloudPullEmptyMessage = (): string => '云端没有会话可拉回';

/** 拉失败。 */
export const cloudPullFailureMessage = (): string => '从云端拉回失败，请稍后重试';

/** 一次「从云端拉回」的三种结果。 */
export type CloudPullOutcome =
  /** 拉到了 N 个会话。 */
  | { kind: 'pulled'; count: number }
  /** 拉回成功，但云端本来就是空的。 */
  | { kind: 'empty' }
  /**
   * 拉回失败。
   *
   * `reason` 是**机器码或人话**（由同步层给出），`backendUnavailable` 是
   * 「服务端不可用」的机器标记 —— 界面据此选措辞，但**原始串只进日志**。
   */
  | { kind: 'failed'; reason?: string | null; backendUnavailable?: boolean };

/**
 * 三种结果 → 一句回执（**单源**）。
 *
 * 「拉到 N 个」「云端本来就是空的」「拉失败」是**三件不同的事**，
 * 必须有**三句不同的话** —— 混成一句就是「零反馈」与「谎报成功」的温床。
 */
export const cloudPullOutcomeMessage = (outcome: CloudPullOutcome): string => {
  switch (outcome.kind) {
    case 'pulled':
      return cloudPullSuccessMessage(outcome.count);
    case 'empty':
      return cloudPullEmptyMessage();
    case 'failed':
      return cloudPullFailureMessage();
  }
};
