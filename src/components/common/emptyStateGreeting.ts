/**
 * 空态的问候语（2026-10-19 审计 I-1）。
 *
 * 【为什么抽成纯函数】原先这段逻辑住在 PersonalizedWelcome 组件里，而那个
 * 组件在 I-1 之后被整卡删掉了（它占了 43% 视口高度却零操作价值）。问候语
 * 本身是有用的（它把「这是一个新地方」说成一句话），所以留住它，只是搬家到
 * 标题里 —— 从「一张大卡」降级为「标题上的一行字」。
 *
 * 抽成纯函数是为了能被单测直接驱动（时区敏感的问候语最容易在重构中走样）。
 */

/** 按时段给一句问候。 */
export const getEmptyStateGreeting = (now: Date = new Date()): string => {
  const hour = now.getHours();
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
};
