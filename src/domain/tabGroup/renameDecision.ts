/**
 * 重命名会话的提交决策 —— 纯函数（可单测，不碰 React）。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────────
 * 修复前 `handleNameSubmit` 的守卫是 `if (trimmed !== '' && trimmed !== group.name)`，
 * **没有 else 分支** ⇒ 三种输入里有两种会让输入框**卡在编辑态出不来**：
 *
 *   · 名字没改（点进去又没改）→ 整个函数什么都不做，`setIsEditing(false)`
 *     只写在异步成功回调里 ⇒ 永远不会执行 ⇒ **卡住**；
 *   · 清空后按 Enter → 同上（`trimmed === ''` 短路）⇒ 输入框空了还出不去，
 *     用户只能按 Esc。
 *
 * 这不是「小瑕疵」：重命名是键盘用户的核心动作，卡在编辑态意味着
 * 「我改不了名字」。
 *
 * ── 决策口径 ─────────────────────────────────────────────────────────────
 * · **没改动** → 直接退出编辑态，不写盘（不产生无意义的 version bump，
 *   也避免 Enter + blur 双触发时发两次 rename）。
 * · **清空** → 回滚到原名并退出编辑态。
 *   选它而不是「留在编辑态 + 提示『名称不能为空』」的理由：
 *   名称为空会让卡片**没有可读的名字**（读屏播报「区域」、列表里两行同名），
 *   而产品已经给了一个自动生成的默认名（域名或时间戳）⇒ 留空没有用户价值；
 *   静默回滚到原名则是「撤销」语义 —— 用户清空后按 Enter，得到的是
 *   「改不动」这一事实，而不是「名字被清空了」这个更糟的结果。
 *   同时必须**出声**：静默回滚等于「我明明改了却没反应」，
 *   与项目「按了键没反应必须有一句话解释」的第一性原则冲突。
 * · **改名** → 写盘；失败保持编辑态（草稿还在，可直接重试）。
 */

/** 重命名提交的三种决策。 */
export type RenameDecision =
  /** 名字没变：退出编辑态，不写盘。 */
  | { kind: 'unchanged' }
  /** 名字被清空：回滚到原名并退出编辑态。 */
  | { kind: 'empty' }
  /** 改名：写盘。 */
  | { kind: 'rename'; name: string };

/**
 * 决定一次重命名提交该做什么。
 *
 * @param draft 输入框里的当前草稿（未 trim）
 * @param currentName 当前已保存的会话名
 */
export const resolveRenameDecision = (
  draft: string,
  currentName: string
): RenameDecision => {
  const trimmed = draft.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (trimmed === currentName) return { kind: 'unchanged' };
  return { kind: 'rename', name: trimmed };
};
