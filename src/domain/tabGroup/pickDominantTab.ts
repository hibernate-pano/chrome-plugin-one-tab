import type { Tab } from '@/types/tab';
import { extractNamingHost } from './sessionName';

/**
 * 挑出「这个会话里最具代表性」的那个标签。
 *
 * ── 为什么需要它（2026-10-22 审计 U-15）─────────────────────────────────
 *
 * 会话卡头**没有 favicon**，而卡内的标签行**有** —— 层级倒挂：
 * 一屏 10 张卡，10 个一模一样的「标签组 10月22日 09:12」，
 * 用户扫不出哪个是哪个；而每张卡**里面**反倒有可辨识的站点图标。
 *
 * 最小改法：卡头放一个 `<SafeFavicon src={dominantTab?.favicon}>`。
 * 成本为零 —— favicon 已经在会话里存着了（来源是浏览器自己的
 * `chrome.tabs.Tab.favIconUrl`，不新增权限、不新增网络请求、不依赖第三方）。
 *
 * ── 挑哪个标签 ───────────────────────────────────────────────────────────
 *
 * **域名占多数的那个** —— 与会话命名同一把尺子（`extractNamingHost`）。
 * 理由：会话名取的是「出现最多的域名」，favicon 若取自**另一个**标签，
 * 就会出现「图标是 A 站的、名字是 B 站的」这种自相矛盾。
 * ⇒ 这里**复用** `extractNamingHost`，不复制一份正则。
 *
 * ── 契约（调用方按这个形状写代码）─────────────────────────────────────────
 *
 * ① 返回**域名占多数**的那个标签（域名按 `deriveDominantHost` 同一套口径归一）；
 * ② 域名并列时取**数组里靠前**的那个；
 * ③ 没有任何标签有可用域名时，返回**第一个带 favicon 的标签**；
 * ④ 都没有则返回 `null`。
 *
 * 【③ 的两个子情形，说明为什么这么判】
 * · 优先返回**第一个 favicon 非空**的标签 —— 它才有图标可显示；
 * · 若所有标签的 favicon 都是空串，则退回**第一个带 favicon 字段**的标签
 *   （`Tab.favicon` 是可选字段，没有这个字段的标签排在后面）；
 * · 两者都没有 ⇒ `null`（④）。
 */
export function pickDominantTab(tabs: Tab[]): Tab | null {
  const list = tabs ?? [];
  if (list.length === 0) return null;

  // ① 统计每个主机的出现次数（口径与会话命名完全一致）
  const counts = new Map<string, number>();
  for (const tab of list) {
    const host = extractNamingHost(tab.url);
    if (!host) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  // 主导主机：出现次数最多；并列时取**最先出现**的（Map 保持插入序）
  let bestHost = '';
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      bestHost = host;
      bestCount = count;
    }
  }

  if (bestHost) {
    // ② 并列时取数组里**靠前**的那个（find 返回首个命中）
    const match = list.find(tab => extractNamingHost(tab.url) === bestHost);
    if (match) return match;
  }

  // ③ 没有可用域名 ⇒ 退回第一个有 favicon 的标签
  const withIcon = list.find(
    tab => typeof tab.favicon === 'string' && tab.favicon.trim().length > 0
  );
  if (withIcon) return withIcon;

  const withField = list.find(tab => tab.favicon !== undefined && tab.favicon !== null);
  // ④ 都没有 ⇒ null
  return withField ?? null;
}
