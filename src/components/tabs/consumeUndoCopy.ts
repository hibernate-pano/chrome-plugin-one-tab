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
 * 带撤销的提示停留多久（毫秒）。
 *
 * 8 秒的依据：这是一个**不可逆操作**的退路，3 秒（普通提示的时长）不够用户
 * 读完「卡片不见了」再决定退不退回；Chrome 自己的「重新打开已关闭的标签」
 * 给 8 秒。给 30 秒则会让提示变成常驻噪音。
 */
export const consumeUndoDurationMs = 8000;

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
