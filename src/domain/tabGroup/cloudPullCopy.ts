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

/**
 * 一次「从云端拉回」的**原始回包**（同步协议 `download` 的 MutationResult）。
 *
 * 只声明界面要用到的字段 —— `payload` 的内部形状（`MergeResult`）由本模块
 * 自己读，界面不必知道它长什么样。
 */
export interface CloudPullDownloadResult {
  /** 这一轮有没有成功。 */
  ok: boolean;
  /** 失败原因（机器码或人话）。 */
  error?: string;
  /** 「服务端不可用」的机器标记（界面据此选措辞）。 */
  backendUnavailable?: boolean;
  /** 引擎的原始回包（`MergeResult`）。 */
  payload?: unknown;
}

/**
 * 引擎如实上报的「**云端这一轮读到了几个会话**」。
 *
 * ── 为什么不能拿 `payload.groups.length` 当这个数 ──────────────────────────
 * `payload.groups` 是**合并后**的列表（本机 + 云端）⇒ 拿它当「拉回 N 个」
 * 会在本机本来就有会话时**夸大**（本机 5 个 + 云端 3 个 ⇒ 报「拉回 8 个」，
 * 而实际只从云端取回 3 个，其中还有 2 个本地早就有）。
 *
 * 引擎在成功路径上如实上报 `stats.cloudCount`（= 云端这一轮读到的会话数，
 * 读不出来被整组跳过的那些不算在内）⇒ 那才是「从云端拉回」的条数。
 *
 * ── 为什么读不到就返回 `null`（而不是猜一个） ─────────────────────────────
 * `null` = **引擎没说**。这时候界面**不许**拿本地列表长度顶替（那正是
 * 本条缺陷的本体），也不许说「云端没有会话可拉回」（那是在断言一件
 * 引擎没说的事）⇒ 界面改说「已从云端拉回，会话列表已更新」（不声称条数）。
 *
 * 宁可少说，不可说错。
 *
 * @returns 云端这一轮读到的会话数；**读不到时为 null**（不是 0）。
 */
export const readCloudPullCount = (res: CloudPullDownloadResult): number | null => {
  const payload = res.payload as { stats?: { cloudCount?: number } } | undefined;
  const cloudCount = payload?.stats?.cloudCount;
  return typeof cloudCount === 'number' ? cloudCount : null;
};

/**
 * 拉回来了，但**条数读不到** ⇒ 不声称条数。
 *
 * 为什么需要这一句：`CloudPullOutcome` 只有三种（拉到 N 个 / 云端为空 /
 * 失败），没有「第 4 种：拉回来了但不知道几个」——
 * 而那一格是真的存在（引擎没上报 `stats.cloudCount` 时）。
 * 与其编一个数，不如只说「确实拉回来了，列表已更新」。
 */
export const cloudPullSuccessWithoutCountMessage = (): string =>
  '已从云端拉回，会话列表已更新';

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
