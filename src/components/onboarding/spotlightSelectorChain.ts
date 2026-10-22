/**
 * 聚光灯选择器的**有序候选链**拆分（纯函数，2026-10-22 审计 P0-1）。
 *
 * ── 为什么要自己拆，而不是交给 CSS ──────────────────────────────────────
 *
 * CSS 的 `querySelectorAll('A, B')` 返回的是**文档顺序**，不是选择器顺序 ——
 * 所以「A 优先、B 兜底」这种写法在 CSS 层面根本不成立：只要 A、B 都存在，
 * 返回的第一个是**文档里靠前的那个**，与你想优先谁无关。
 *
 * 真实踩到的坑：引导第 4 步「恢复整个会话」原本只指向恢复按钮，而全新安装时
 * 一个会话都没有 ⇒ 那张卡片不存在 ⇒ 按钮不存在 ⇒ 聚光灯整个消失，
 * 界面上没有任何提示（只有 console 里一句 warn）。修法是给它加一条兜底链，
 * 而兜底**必须按顺序试**才有意义。
 *
 * 引号与方括号/圆括号内的逗号不算分隔符（`[aria-label="a, b"]` 是一个选择器）。
 */
export function splitSelectorChain(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const ch of selector) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return parts.map(part => part.trim()).filter(Boolean);
}
