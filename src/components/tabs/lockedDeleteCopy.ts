/**
 * 「删除一个锁定会话」的用户可见文案（2026-10-20 审计 A-3）。
 *
 * ── 缺陷原形 ────────────────────────────────────────────────────────────
 * 锁定（isLocked）在实现里被当成了「**不可删除**」：
 *   · `TabGroup.tsx` 的宽屏删除按钮与窄屏「更多」菜单里的「删除会话」都被
 *     `{!group.isLocked && (…)}` 包住 ⇒ 锁定后**整个删除入口消失**，
 *     用户必须先解锁才能删。
 *   · 而用户锁定的动机是「这个重要，别弄丢」⇒ 结果变成「永远删不掉」。
 * 锁定变成了「禁止删除」，而不是「防误删」。
 *
 * ── 修法：锁定的口径 ────────────────────────────────────────────────────
 * 锁定保护的是**会话内部**（不可重命名、不可逐条删其中的标签、不可拖走、
 * 不参与「清理重复标签」），保护**不是**「这张卡不许消失」。
 * 所以：锁定会话**保留删除入口**，但删除它是**更重的动作**——
 * 必须明确告诉用户「你正在删一个你自己保护过的东西」。
 *
 * 确认框因此**不受「删除会话前确认」开关约束**：那个开关管的是
 * 「日常删除要不要问一句」，而删除锁定会话是**越权动作**——
 * 关掉开关就悄悄放行，等于把「锁定」重新变回一句谎话。
 *
 * ── 为什么要抽成纯函数 ──────────────────────────────────────────────────
 * 宽屏按钮与窄屏菜单是**两个入口**，历史 bug 正是两处各写一份判据、
 * 改一处漏一处。抽出纯函数后：措辞只有一份，node 单测可以直接断言
 * （.tsx 组件在没有 DOM 环境时加载不了）。
 */
import {
  crossDeviceDeleteSentence,
  deleteReachesOtherDevices,
  type CrossDeviceDeleteInput,
} from '@/components/sync/crossDeviceDeleteCopy';

/** 删除一个会话时，确认框需要知道的最小信息。 */
export interface DeleteGroupCopyInput {
  /** 会话名（出现在标题里）。 */
  name: string;
  /** 会话里的标签页数。 */
  tabCount: number;
  /** 该会话是否被锁定。 */
  isLocked: boolean;
  /**
   * 跨设备删除的**原始事实**（有没有账号 / 跟谁同步）。
   *
   * 2026-10-24 审计 DS-3：此前**单个会话**的删除确认框一个字都不提跨设备 ——
   * 而删除意图确实会广播（墓碑上传 ⇒ 对端服从删除）。用户在按确认键的那一刻
   * 被误导成「只删本机」。
   *
   * 传**原始事实**而不是布尔值，是为了让「会不会传到其他设备」这个判断
   * **只有一处**（`components/sync/crossDeviceDeleteCopy.ts` 的
   * `deleteReachesOtherDevices`）—— 与「删除所有会话」同源。
   * 省略 = 纯本地用户（没有同步后端 ⇒ 删除只发生在本机）。
   */
  crossDevice?: CrossDeviceDeleteInput;
}

/** 确认框标题。 */
export const deleteGroupConfirmTitle = (input: DeleteGroupCopyInput): string =>
  input.isLocked
    ? `删除已锁定的「${input.name}」？`
    : `删除「${input.name}」？`;

/**
 * 删除入口的**可见文字 / 可访问名**（宽屏按钮的 title+aria-label、
 * 窄屏菜单项的文字，三处同源）。
 *
 * 抽成一处的原因：这三处历史上各写各的，改一处漏一处就会出现
 * 「按钮写「删除会话」而菜单写「删除已锁定的会话」」的分裂说法。
 * 锁定态必须能被读屏与 tooltip 区分出来 —— 用户要删的正是那个
 * 自己保护过的东西。
 */
export const deleteGroupEntryLabel = (isLocked: boolean): string =>
  isLocked ? '删除已锁定的会话' : '删除会话';

/**
 * 删除入口的**可访问名**（读屏播报的那一句）。
 *
 * ── 为什么不能只靠 Tooltip（2026-10-23 审计 DS-43-17）────────────────────
 * 「删除后无法恢复」原先只写在 Tooltip 的 `content` 里。而 Tooltip 的接线
 * （V-15）是「**提示条可见时**才把它挂到触发元素的 `aria-describedby` 上」——
 * 提示条本身也只在 `isVisible` 时才渲染。于是：
 *   焦点落到按钮上 ⇒ 读屏先念按钮名（「删除会话」）
 *   300ms 后提示条出现、`aria-describedby` 被挂上 ⇒ **多数读屏不会重新播报**
 * ⇒ 读屏用户**从头到尾听不到**「删除后无法恢复」。
 *
 * 而这个动作是**不可逆**的（v1.22.0 起无回收站）⇒ 后果必须进**可访问名**。
 *
 * ⚠️ WCAG 2.5.3（Label in Name）：可访问名必须**包含**可见文字 ——
 * 「删除会话（删除后无法恢复）」包含「删除会话」⇒ 合规。
 * 锁定态同理：「删除已锁定的会话（删除后无法恢复）」包含可见文字。
 */
export const deleteGroupEntryAriaLabel = (isLocked: boolean): string =>
  `${deleteGroupEntryLabel(isLocked)}（删除后无法恢复）`;

/**
 * 确认框正文。
 *
 * 锁定会话必须**点名**「已锁定」：用户锁它是为了防误删，
 * 此刻要删的正是那个被保护的东西 —— 不说清楚，用户会以为在删一个普通会话。
 *
 * 跨设备那句（2026-10-24 审计 DS-3）与「删除所有会话」**同源**
 * （`components/sync/crossDeviceDeleteCopy.ts`）：删除会广播到其他设备，
 * 对方离线期间改过也一样会被删（云端墓碑一律赢，见 `core/opStampMerge.ts`）。
 */
export const deleteGroupConfirmMessage = (input: DeleteGroupCopyInput): string => {
  // ── 2026-10-23 审计 H-10：同一个东西不许有三种叫法 ────────────────────
  // 「会话里的一条 URL」在本仓曾有三种叫法：标签页（保存提示、aria-label）
  // / 标签（顶栏计数、卡头徽章）/ **标签记录**（此处）。
  // 同一个东西三个名字 ⇒ 用户在三个界面看到三个词，会以为是三样东西。
  // ⇒ 统一成「标签页」（与 `saveActionCopy` / `saveFeedbackCopy` / TabGroup
  //   的 aria-label / 卡头徽章同源）。
  const records = `将永久删除该会话内的 ${input.tabCount} 个标签页，删除后无法恢复。`;
  const crossDevice =
    input.crossDevice && deleteReachesOtherDevices(input.crossDevice)
      ? crossDeviceDeleteSentence(input.crossDevice)
      : '';
  if (!input.isLocked) {
    return `${records}${crossDevice}确认继续吗？`;
  }
  return `该会话已锁定，本来用于防止误删。${records}${crossDevice}确认仍要删除它吗？`;
};

/**
 * 锁定会话的删除是否必须弹确认框。
 *
 * 锁定 ⇒ **必须**确认，与「删除会话前确认」开关无关。
 * 未锁定 ⇒ 听开关（保持既有行为，不给普通删除凭空加噪音）。
 */
export const deleteGroupRequiresConfirm = (input: {
  isLocked: boolean;
  confirmBeforeDelete: boolean;
}): boolean => input.isLocked || input.confirmBeforeDelete;

/**
 * 试图删除**锁定会话里的一条标签页**时的错误提示（2026-10-23 审计 DS-9）。
 *
 * ── 为什么抽出来 ────────────────────────────────────────────────────────
 * 同一个错误在两个入口各写一份，措辞还不一样：
 *   · 列表页（`TabGroup.tsx`）：「会话已锁定，解锁后才能删除其中的**标签**」
 *   · 搜索页（`SearchResultList.tsx`）：「该会话已锁定，解锁后才能删除其中的**标签页**」
 * 两处都是「锁定 ⇒ 逐条删被拒」这一条契约，却用两种叫法（标签 / 标签页）
 * 和两个开头（会话已锁定 / 该会话已锁定）—— 用户跨页面时会以为是两回事，
 * 而 H-10 早就定了「同一样东西只许一种叫法」。
 *
 * ⇒ 措辞只有一份，两处同源。
 * 「标签页」用 H-10 的统一叫法；「该会话已锁定」这个开头保留搜索页的说法，
 * 因为它点名了**是哪个会话**被锁定 —— 搜索结果来自多个会话时，
 * 用户需要知道被拒的是哪一张卡。
 */
export const lockedTabDeleteMessage = (): string =>
  '该会话已锁定，解锁后才能删除其中的标签页';
