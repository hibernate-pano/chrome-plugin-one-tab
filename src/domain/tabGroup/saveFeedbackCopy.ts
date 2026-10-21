/**
 * 「保存」成功后的用户可见文案 —— **单源**。
 *
 * ── 为什么要有这个模块（2026-10-20 审计 A-4）────────────────────────────
 *
 * 「保存整窗」这个动作会**关掉用户窗口里的标签**（这是产品定位：保存 = 剪切）。
 * 因此用户必须能看清「到底发生了什么」，尤其是**没发生什么**。
 *
 * 修复前的缺陷（主审在真机复现）：
 *   · 成功通知只写「已将 12 个标签页保存为新会话」
 *   · 而默认配置下 `collectPinnedTabs=false` ⇒ 用户 pin 在窗口里的标签
 *     **既没保存、也没关闭** —— 它们就留在原处，通知里一个字都没提。
 *   · 用户 pin 的通常正是最重要的工作台页面（「我 pin 了三个监控大盘」）。
 *   * 丢弃数只进了 `logWarn` —— 日志是给开发者看的，用户看不到。
 *
 * 对照：`saveCurrentTab`（单标签）**有**明确提示（"设置中未开启「保存固定标签页」"），
 * 整窗保存**没有**。同一个设置，两条路径两种诚实度。
 *
 * ── 为什么放在 domain 层 ───────────────────────────────────────────────
 * 这段文案要出现在**三个地方**：SW 的系统通知、popup 顶栏按钮的 inline 反馈、
 * 空态 CTA 的 inline 反馈。background / service-worker 不允许 import
 * `@/components/**`（分层约束），所以共享文案必须放在 `src/domain/` 下。
 *
 * 同理，**措辞只写一处** —— 三个入口若各写一遍，迟早漂移成三个说法
 * （本仓 2026-10-19 审计 I-1 / I-3 修的就是同一类问题）。
 */

/** 保存整窗的结果摘要。 */
export interface SaveAllSummary {
  /** 真正保存下来的标签数。 */
  savedCount: number;
  /**
   * 因为「固定标签页」开关关闭而**没有保存**的标签数。
   * 这些标签同时也**没有被关闭** —— 它们仍在原处。
   */
  droppedPinnedCount: number;
}

/**
 * 「保存整窗」成功的文案。
 *
 * 有丢弃时必须说出来，且要说清「它们还在原地」—— 否则用户会以为那三个
 * pin 住的标签被存进去了，回头找不到时反而困惑。
 */
export const saveAllSuccessMessage = ({
  savedCount,
  droppedPinnedCount,
}: SaveAllSummary): string => {
  const base = `已保存 ${savedCount} 个标签页`;
  if (droppedPinnedCount <= 0) return base;
  return (
    `${base}；另有 ${droppedPinnedCount} 个固定标签页未保存（仍留在浏览器里，` +
    `可在设置中开启「保存固定标签页」）`
  );
};

/**
 * 紧凑版 —— 用于按钮这类**宽度有限**的位置。
 *
 * 与 {@link saveAllSuccessMessage} 口径一致，只是把解释压短。
 * 不能在这里换一种说法（比如只说「部分未保存」而不说未保存的是什么）——
 * 短 ≠ 可以省略事实。
 */
export const saveAllSuccessShortMessage = ({
  savedCount,
  droppedPinnedCount,
}: SaveAllSummary): string => {
  const base = `已保存 ${savedCount}`;
  if (droppedPinnedCount <= 0) return base;
  return `${base}（${droppedPinnedCount} 个固定标签未存）`;
};
