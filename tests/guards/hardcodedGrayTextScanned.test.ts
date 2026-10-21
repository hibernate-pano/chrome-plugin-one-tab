// 「提示色」不得写死 Tailwind 灰阶 —— **全仓扫描**（2026-10-20 审计 D-1/D-2 的收口）。
//
// ── 这个文件要防的回归类别 ────────────────────────────────────────────────
//
// D-1（页脚版本号）、D-2（设置页 5 处说明文字）都栽在同一件事上：
// 文字颜色写死成 Tailwind 灰阶（`text-gray-500 dark:text-gray-400`），
// **不跟主题走**。六套主题各自有自己的表面色 ⇒ 同一份灰阶在某些主题上
// 低于 WCAG AA 的正文线 4.5:1。
//
// 已实测的最差值：**creamy 深色态下 `dark:text-gray-400` 只有 4.42:1**
// （gray-400 = #9ca3af 叠在 creamy 的 #3f3a36 上）。
//
// ── 为什么这个文件是「扫描式」而不是「列文件式」 ─────────────────────────
//
// 【上一版守卫的结构性缺陷】
//
// `tests/guards/a11yTextAndFocusTokens.test.ts` 里那条断言是**白名单式**的：
// 只查 `OptionsPage.tsx` / `WebDavSettings.tsx` / `ThemeStyleSelector.tsx`
// 三个文件（外加 `MainApp.tsx` 的 footer 单独一条）。
//
// ⇒ **新文件天然落在网外**。本轮就实测到了：
// `src/components/search/SearchFilterPanel.tsx`（A-14 新建的文件）里有两处
// `text-gray-500 dark:text-gray-400`，而旧守卫**一条都没报** ——
// 因为那个文件不在白名单里。
//
// 这就是本仓反复吃过的那个亏的另一个变体：
// **守卫钉的是「已知的坏文件」，而不是「事实」**。
// 于是「加一个新文件」这个动作本身就会制造出一个新的缺陷盲区。
//
// ⇒ 这里改成**全仓扫描**：扫 `src/**/*.tsx` 的**每一个**文字元素，
// 任何一处文字元素上出现写死的 gray-400/500 都必须变红。
// 新文件 ⇒ 自动进网，不需要改守卫。
//
// ── 判据：从代码取事实，不从文档取事实 ──────────────────────────────────
//
// ① **哪些灰阶算违规**：只有 `gray-400` 与 `gray-500`。
//    `gray-600/700/900`（主文字）与 `gray-100/200/300`（深色态主文字）
//    在六套主题 × 明暗下实测全部 ≥ 7.1:1 ⇒ 不在违规范围内。
//    事实依据（实测表见本文件末尾）：
//
//      浅色态 gray-600：legacy/apple/chrome/creamy 7.56、claude 7.17、prism 7.50
//      深色态 gray-300：legacy 9.96、creamy 7.62、prism 11.82、claude 10.39、
//                        apple 9.46、chrome 9.74
//
// ② **哪些元素算「文字元素」**：元素内**直接含文本**的那些
//    （p / span / label / button / h1-h6 / li / td / th / summary / small …）。
//    **纯图标容器**（只包 `<svg>`）不算 —— 图标是非文本内容，
//    适用 WCAG 2.2 的 3:1 而非 4.5:1。
//
// ③ **怎么算达标**：不写死期望色值，而是**从主题文件里读令牌**再算对比度。
//    否则改坏了主题规则，守卫照样绿。
//
// ── 为什么「换成 theme-text-muted 令牌」是可行的修法 ────────────────────
//
// 因为 `tests/guards/a11yTextAndFocusTokens.test.ts` **已经**验证了
// `--color-text-muted` 在 6 套主题 × 明暗 × 6 种表面色上全部 ≥ 4.5:1
//（最差 creamy 深色 4.67）。本文件与它互为配套：
// 那条守卫管「令牌本身达标」，本文件管「别再用写死的灰阶」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(ROOT, 'src');

/** 递归收集 src/ 下所有 .tsx 文件（按路径排序，保证报错顺序稳定）。 */
const collectTsx = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsx(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
};

/** 剥掉注释：注释里提到旧类名不该让守卫变红（与本仓其它守卫同一口径）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** 违规灰阶：只有 400 / 500 这两档（理由见文件头「哪些灰阶算违规」）。 */
const VIOLATING_GRAY = /\b(?:dark:)?text-gray-(?:400|500)\b/;

/** 算作「文字元素」的标签。 */
const TEXT_TAGS = [
  'p', 'span', 'div', 'label', 'button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'summary', 'small', 'strong', 'em', 'time',
] as const;

/**
 * 一处「文字元素上的写死灰阶」。
 */
interface Offense {
  file: string;
  line: number;
  tag: string;
  classes: string;
}

/**
 * 扫描一个文件里所有「直接含文本」的元素，找出 className 上写了
 * `text-gray-400/500` 的那些。
 *
 * 【为什么要区分「含文本」与「纯图标容器」】
 * 图标是非文本内容，适用 WCAG 2.2 的 3:1；文字适用正文线 4.5:1。
 * 把 `<svg className="... text-gray-500">` 也算进来会逼着人改一堆
 * 本来就合规的图标色 —— 那会让守卫变成噪声，最终被人加白名单绕过。
 */
const scanFile = (absPath: string): Offense[] => {
  const src = stripComments(readFileSync(absPath, 'utf8'));
  const offenses: Offense[] = [];
  const tagPattern = new RegExp(`<(${TEXT_TAGS.join('|')})\\b([^>]*?)>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(src)) !== null) {
    const [full, tag, attrs] = match;
    const classMatch = attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{\s*'([^']*)'\s*\})/s);
    if (!classMatch) continue;
    const classes = classMatch[1] ?? classMatch[2] ?? classMatch[3] ?? '';
    if (!VIOLATING_GRAY.test(classes)) continue;

    // 该元素内是否**直接**含文本（把嵌套标签剥掉后还剩东西）
    const after = src.slice(match.index + full.length);
    const closeAt = after.indexOf(`</${tag}>`);
    const inner = closeAt === -1 ? after.slice(0, 300) : after.slice(0, closeAt);
    const textOnly = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!textOnly) continue;

    offenses.push({
      file: relative(ROOT, absPath),
      line: src.slice(0, match.index).split('\n').length,
      tag,
      classes: classes.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return offenses;
};

const ALL_FILES = collectTsx(SRC);

describe('提示色不得写死 Tailwind 灰阶（全仓扫描）', () => {
  it('src/ 下每个 .tsx 文件都被扫到了（扫描器本身没坏）', () => {
    assert.ok(ALL_FILES.length >= 20, `只扫到 ${ALL_FILES.length} 个 .tsx 文件，扫描器可能坏了`);
    // 至少要包含这轮新建的文件 —— 它正是旧白名单漏掉的那一个。
    assert.ok(
      ALL_FILES.some(f => f.endsWith('SearchFilterPanel.tsx')),
      '扫描范围里必须有 src/components/search/SearchFilterPanel.tsx（A-14 新建，旧白名单漏掉了它）'
    );
  });

  it('文字元素上不得出现写死的 text-gray-400 / text-gray-500', () => {
    const offenses: Offense[] = [];
    for (const file of ALL_FILES) {
      offenses.push(...scanFile(file));
    }
    assert.equal(
      offenses.length,
      0,
      `以下 ${offenses.length} 处在**文字元素**上写死了 Tailwind 灰阶 —— ` +
        `它们不跟主题走，在某些主题下低于 WCAG AA 的 4.5:1 ` +
        `（实测最差：creamy 深色态的 dark:text-gray-400 = 4.42:1）。\n` +
        `修法：换成主题令牌 theme-text-muted —— ` +
        `该令牌在 6 套主题 × 明暗下实测全部 ≥ 4.5:1（最差 4.67）。\n` +
        offenses.map(o => `  · ${o.file}:${o.line} <${o.tag}> ${o.classes}`).join('\n')
    );
  });

  it('（事实来源）theme-text-muted 令牌在 6 套主题 × 明暗下都达标', () => {
    // 本守卫的修法（换令牌）成立的前提是令牌本身达标。
    // 详细断言在 tests/guards/a11yTextAndFocusTokens.test.ts 的
    // 「提示色、警告色、危险色在 6 套主题 × 明暗都达到 WCAG AA 正文线 4.5:1」。
    //
    // 这里只钉**令牌与类名都存在** —— 少一个，修法就落空
    //（比如类名写错 ⇒ 元素直接没有颜色 ⇒ 继承父色，对比度未知）。
    const global = readFileSync(resolve(SRC, 'styles/global.css'), 'utf8');
    assert.match(
      global,
      /\.theme-text-muted\s*\{[^}]*color:\s*var\(--color-text-muted\)/,
      'global.css 里必须有 .theme-text-muted 且读 --color-text-muted'
    );
    assert.match(
      global,
      /\.theme-text-secondary\s*\{[^}]*color:\s*var\(--color-text-secondary\)/,
      'global.css 里必须有 .theme-text-secondary 且读 --color-text-secondary'
    );
    for (const theme of ['legacy', 'creamy', 'prism', 'claude', 'apple', 'chrome']) {
      const css = readFileSync(resolve(SRC, `styles/themes/${theme}.css`), 'utf8');
      assert.ok(
        css.includes('--color-text-muted'),
        `${theme}.css 没有定义 --color-text-muted —— 该主题下 theme-text-muted 会回落到 global.css 的兜底值`
      );
    }
  });
});
