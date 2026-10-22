/**
 * 「恢复即消费」的撤销文案（2026-10-22 审计 P0-4）。
 *
 * 单独成文件的原因与 restoreFeedbackCopy 一样：列表页、搜索页、撤销成功/
 * 失败三处都要说同一件事，**两处各写一遍迟早漂** —— 而漂出来的是用户
 * 读到的措辞（「撤销失败」与「撤销成功」在同一个 toast 上先后出现，
 * 顺序反了就是「先说成功再说失败」）。
 */

/** 撤销按钮上的字。必须是一个**动作**（动词），不是一个状态。 */
export const consumeUndoActionLabel = '撤销';

/**
 * 带撤销的提示停留多久（毫秒）—— **不在这里定**。
 *
 * 2026-10-22 前这里有一个 `consumeUndoDurationMs = 8000`。它是个**写死的数**，
 * 而且还与 Toast 组件内部自己用的 3 秒**各说各话** ⇒ 同一个「退路」有两个
 * 时长出处，早晚会漂（漂出来的后果：一边以为有 8 秒、实际 3 秒就没了）。
 *
 * 现在只有一个出处：`@/components/common/toastPolicy` 的
 * `TOAST_ACTION_DURATION_MS` / `resolveToastDuration` —— 判据是
 * **「有没有动作」**，不是「这是不是撤销」。
 *
 * 顺带补上原先没写清的一条：带动作的提示**悬停/聚焦时倒计时会暂停**
 * （见 toastPolicy 的倒计时状态机）。「用户伸手去够那个按钮」这件事本身
 * 要花时间，提示在伸手的过程中消失 ⇒ 退路等于不存在。
 */

/** 一个会话被撤销后。 */
export const consumeUndoSuccessMessage = (sessionName: string): string =>
  `已撤销，「${sessionName}」已回到列表中。`;

/** 多个会话被撤销后（批量恢复）。 */
export const consumeUndoSuccessMessageMany = (count: number): string =>
  `已撤销，${count} 个会话已回到列表中。`;

/** 撤销失败：必须说清**为什么**，不能只说「失败」。 */
export const consumeUndoFailedMessage = (reason: string): string =>
  `撤销失败：${reason}`;

/** 撤销已完成（幂等）：这条不是失败，是「本来就在」。 */
export const consumeUndoAlreadyRestoredMessage = (sessionName: string): string =>
  `「${sessionName}」已经在列表里了，无需重复撤销。`;

/** 撤销已完成（幂等，多会话）。 */
export const consumeUndoAlreadyRestoredMessageMany = (count: number): string =>
  `${count} 个会话已经在列表里了，无需重复撤销。`;
