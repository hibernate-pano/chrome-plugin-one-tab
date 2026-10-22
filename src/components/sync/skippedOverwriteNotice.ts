/**
 * 「覆盖上传被跳过」这件事的**唯一一份用户可见说法**。
 *
 * ── 为什么需要它（2026-10-23 回归审计 R-1）────────────────────────────────
 *
 * 覆盖上传 = 「先删空当前账号的云端，再把本机的写上去」。它有两条会「什么也
 * 不写」却照样往下走删除的路径：
 *
 *   · `no-active-groups` —— 本地一个活跃组都没有（空本地保护，早已存在）；
 *   · `no-account-groups` —— 换过账号：本机的会话都属于上一个账号，账号闸门
 *     放行 0 个（2026-10-23 新增）。
 *
 * 第二条原来**没有保护也没有说法**：云端被删空、界面报「上传成功」。
 * 现在后端跳过了覆盖并把理由报上来，界面就**必须**照实说 —— 跳过不是成功，
 * 而「云端保持不变」是这轮**唯一**对用户有意义的结论。
 *
 * ── 为什么抽成纯函数（而不是在两个组件里各写一句）────────────────────────
 *
 * 同一个事实有两个消费点：顶栏同步按钮（`SyncButton`）与「删除所有会话」之后
 * 的补覆盖（`HeaderDropdown`）。两处各写一份文案 ⇒ 改一处忘一处 ⇒
 * 用户在 A 处看到「云端保持不变」、在 B 处看到「已同步到云端」。
 * 与 `deleteAllMessages.ts` 同一个纪律：**同一份声明只有一个版本**。
 */

/** 提示的级别：覆盖被跳过不是失败，但对「换账号」这种情况值得提醒一句。 */
export type SkippedOverwriteLevel = 'info' | 'warning';

export interface SkippedOverwriteNotice {
  text: string;
  level: SkippedOverwriteLevel;
}

/**
 * 由「跳过的理由」产出用户可见的那句话。
 *
 * @param reason 后端报上来的跳过理由（`OverwriteSkipReason`）。
 *               **传 undefined ⇒ 没有跳过 ⇒ 返回 null**（一个字都不多说）。
 * @returns null（没发生）或一句如实描述的话。
 */
export const skippedOverwriteNotice = (
  reason?: string
): SkippedOverwriteNotice | null => {
  // ⚠️ 「没有跳过」与「跳过但理由不认识」是**两件事**：
  //   · undefined ⇒ 覆盖照常发生了 ⇒ 一个字都不多说（弹一句「0 个会话」是纯噪音）；
  //   · 陌生字符串 ⇒ 覆盖**没**发生（后端没说清楚为什么）⇒ 仍然要说，
  //     且只说能保证的那部分（「覆盖没发生、云端保持不变」是所有理由的共同结论）。
  if (reason === undefined) return null;
  switch (reason) {
    case 'no-active-groups':
      return {
        text: '本地没有活跃会话，覆盖上传已跳过（云端数据保持不变）',
        level: 'info',
      };
    case 'no-account-groups':
      // 级别是 warning 而不是 info：这不是「本来就没东西可传」，
      // 而是「你换过账号，而这台机器上的会话属于上一个账号」。
      // 用户若没看见这一句，会以为自己的会话已经传上去了。
      return {
        text: '这台机器上的会话不属于当前账号，覆盖上传已跳过（云端数据保持不变）',
        level: 'warning',
      };
    default:
      // 未知理由（老后端 / 未来新增）：**仍然要说**，但只说能保证的那部分 ——
      // 「覆盖没发生、云端保持不变」是所有跳过理由的共同结论。
      return {
        text: '覆盖上传已跳过（云端数据保持不变）',
        level: 'info',
      };
  }
};
