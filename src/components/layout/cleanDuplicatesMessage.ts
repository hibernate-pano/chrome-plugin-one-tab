/**
 * 清理重复标签的结果文案。
 *
 * 清理是有成效的操作，但此前成功后完全静默（项目早期的「成功静默」约定），
 * 用户无法区分「点了一下没反应」与「真的没有重复可清」。这里把服务端已经算好的
 * 两个计数转成一句具体的反馈。
 *
 * 抽成纯函数：文案是纯拼接，单测直接钉死边界（无重复、只删标签、只删空组、两者都有）。
 */
export function cleanDuplicatesResultMessage(removedTabs: number, removedGroups: number): string {
  const tabs = Math.max(0, Math.floor(removedTabs));
  const groups = Math.max(0, Math.floor(removedGroups));

  if (tabs === 0 && groups === 0) {
    return '没有发现重复标签或空会话，无需清理';
  }

  const parts: string[] = [];
  if (tabs > 0) parts.push(`${tabs} 个重复标签页`);
  if (groups > 0) parts.push(`${groups} 个空会话`);
  return `清理完成：已清除 ${parts.join('、')}`;
}

/**
 * 清理**之前**的确认文案（2026-10-19 补）。
 *
 * ── 为什么要这一层 ────────────────────────────────────────────────────
 * 清理重复标签是五个破坏性动作里唯一一个「确认时不告诉你会删掉多少」的：
 * 确认框只写「将清理所有会话中 URL 相同的重复标签页……此操作无法撤销」，
 * 而 1.22.0 起删除即物理清除、无回收站 —— 用户在同意的那一刻看不到波及范围。
 *
 * 计数由 `planCleanDuplicates`（纯函数，锁定豁免与 SW 侧执行同一份判据）
 * 在确认前算出，所以这里报的就是**真实会发生的**数字，不是估算。
 *
 * 抽成纯函数而不是内联在 Header 里：文案的边界（无重复 / 只删标签 / 只删空组 /
 * 两者都有）要能被单测逐个钉住，且可与执行结果的 cleanDuplicatesResultMessage
 * 对照 —— 两处的数目字必须同一个来源、同一种说法。
 */
export function cleanDuplicatesConfirmMessage(removedTabs: number, removedGroups: number): string {
  const tabs = Math.max(0, Math.floor(removedTabs));
  const groups = Math.max(0, Math.floor(removedGroups));

  const what: string[] = [];
  if (tabs > 0) what.push(`${tabs} 个重复标签页`);
  if (groups > 0) what.push(`${groups} 个空会话`);

  // 一个都不删时，确认框不该摆出「即将执行破坏性操作」的架势 ——
  // 但也不能直接静默返回（用户点了按钮，必须得到一句「没东西可清」）。
  if (what.length === 0) {
    return '没有发现重复标签或空会话，无需清理。';
  }

  return (
    `将清理所有会话中 URL 相同的重复标签页（每个 URL 只保留最新的一个），` +
    `并删除没有任何标签页的空会话（锁定的会话除外）。\n\n` +
    `本次预计清除 ${what.join('、')}。此操作无法撤销。`
  );
}
