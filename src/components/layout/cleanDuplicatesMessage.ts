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
