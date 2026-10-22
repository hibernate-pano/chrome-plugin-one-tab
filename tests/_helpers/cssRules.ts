/**
 * 一个**极小**的 CSS 规则读取器 —— 只够回答「这个网格是几列、行主序还是列主序」。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * R-11 的判据有一半是**视觉**的：「DOM 序 == 排序序」只保证键盘 Tab 序与
 * 读屏顺序；屏幕上看到的顺序还取决于网格怎么流。
 *
 *   · 卡片是网格的**直接子项** + 两列 + 行主序 ⇒ 视觉逐行序 == DOM 序；
 *   · 卡片被塞进两个「列容器」里 ⇒ 视觉序是「先走完左列再走右列」。
 *
 * 前一半能从渲染产物上看出来（见 `htmlTree.ts`），后一半只能从 CSS 上看。
 * 本仓没有浏览器环境（真机验证走 `scripts/lead-verify-*.mjs`），
 * 于是这里把 CSS 读成结构，让判据能在单测里成立。
 *
 * ── 解析范围 ──────────────────────────────────────────────────────────────
 * 支持：普通样式规则、`@media`（嵌套）、`@supports`、`@layer`（视为透明）。
 * 不支持：`@keyframes`（跳过）、CSS 变量求值（只读字面量）。
 * 足够覆盖本仓自己的样式文件。
 */

export interface CssRule {
  /** 选择器列表。 */
  selectors: string[];
  /** 声明表（属性名小写）。 */
  declarations: Record<string, string>;
  /** 所在 @media 的条件列表（空 = 无条件）。 */
  media: string[];
}

/** 去掉注释（注释里提到某个选择器不算规则）。 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 解析 CSS，返回扁平的规则列表。
 *
 * @param css CSS 文本
 */
export function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];

  const parseDeclarations = (body: string): Record<string, string> => {
    const declarations: Record<string, string> = {};
    for (const chunk of body.split(';')) {
      const colon = chunk.indexOf(':');
      if (colon < 0) continue;
      const name = chunk.slice(0, colon).trim().toLowerCase();
      if (!name) continue;
      declarations[name] = chunk.slice(colon + 1).trim();
    }
    return declarations;
  };

  const parseBlock = (text: string, media: string[]): void => {
    let cursor = 0;
    while (cursor < text.length) {
      const braceAt = text.indexOf('{', cursor);
      if (braceAt < 0) break;
      const prelude = text.slice(cursor, braceAt).trim();
      let depth = 1;
      let end = braceAt + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
        end++;
      }
      const body = text.slice(braceAt + 1, Math.max(braceAt + 1, end - 1));

      if (prelude.startsWith('@media')) {
        parseBlock(body, [...media, prelude]);
      } else if (prelude.startsWith('@supports') || prelude.startsWith('@layer')) {
        // 条件组与层叠层对「这条规则适不适用于这个类」没有影响 ⇒ 视为透明。
        parseBlock(body, media);
      } else if (!prelude.startsWith('@')) {
        rules.push({
          selectors: prelude
            .split(',')
            .map(selector => selector.trim())
            .filter(Boolean),
          declarations: parseDeclarations(body),
          media,
        });
      }
      cursor = end;
    }
  };

  parseBlock(stripCssComments(css), []);
  return rules;
}

/**
 * `grid-template-columns` 的值 ⇒ 轨道数。
 *
 * `repeat(2, minmax(0, 1fr))` → 2；`1fr 1fr` → 2；`1fr` → 1。
 */
export function countGridTracks(value: string): number {
  const trimmed = value.trim();
  const repeat = /^repeat\(\s*(\d+)\s*,/i.exec(trimmed);
  if (repeat) return Number(repeat[1]);
  let depth = 0;
  let tracks = 1;
  let hasContent = false;
  for (const char of trimmed) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && /\s/.test(char)) {
      if (hasContent) tracks++;
      hasContent = false;
    } else if (depth === 0) {
      hasContent = true;
    }
  }
  return hasContent ? tracks : 0;
}

/**
 * 找出作用于某个 class 的规则。
 *
 * 用「token 边界」匹配：`.session-grid` 命中 `.session-grid` 与
 * `.session-grid:hover`，但**不**命中 `.session-grid-column`
 * （那正是 R-11 修复前那个列容器的类名 —— 它必须不再被网格规则覆盖）。
 */
export function rulesForClass(rules: CssRule[], className: string): CssRule[] {
  const pattern = new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  return rules.filter(rule => rule.selectors.some(selector => pattern.test(selector)));
}
