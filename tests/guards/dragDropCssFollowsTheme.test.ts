// 拖拽样式文件必须**跟主题走**（2026-10-20 真机巡检发现并像素级验证）。
//
// ── 这个文件要防的回归类别 ────────────────────────────────────────────────
//
// 标签行（`.tab-item`）的底色有**三处**可以决定：
//   ① `src/styles/drag-drop.css`（由 MainApp.tsx 单独 import ⇒ **后加载**）
//   ② `src/styles/themes/*.css` 的 `html[data-theme=x] .tab-item`
//   ③ `src/styles/global.css` 的 `.tab-item`
//
// 之前 ① 把底色写死成 `white`（深色态 `#1f2937`），
// 而 legacy / creamy / prism 三套主题的 `.tab-item` 规则**只覆盖了
// border / padding / hover，没覆盖底色** ⇒ 底色落回 ①
// ⇒ 那三套主题的标签行是**一整块写死色**，不是卡片底透出来的颜色。
//
// ── 真机像素证据（scripts/prod-theme-consistency.mjs）───────────────────
//
// 缺陷形态下（标签行像素 vs 卡片底像素，色差 ≤ 8 才算融在一起）：
//
//   浅色/creamy   12 ❌    深色/creamy   32 ❌    深色/prism   28 ❌
//
// 修复形态（`.tab-item` 底色改成 transparent）下：13/13 全绿。
//
// 肉眼最刺眼的是**深色态 creamy**：暖黑页面底（#1c1917）上，
// 每一条标签行都是一块**冷蓝灰**（#1f2937，gray-800）。
//
// ── 为什么这个文件是「扫描式」而不是「钉一处」 ───────────────────────────
//
// ① `drag-drop.css` 里同名规则**有两套**（「标签页样式」与「兼容旧样式」），
//    后一套生效。⇒ 只钉其中一处 = 下一个人改回去守卫照样绿。
// ② 守卫要防的是**这一类**缺陷，不是这一个文件的这四个值。
//    ⇒ 扫**文件里每一条 `background-color` / `background` 声明**。
//
// ── 判据的边界：什么算「底色」，什么不算 ───────────────────────────────
//
// **不算**：状态色（`:hover` / `.dragging` / `.drag-over`）——
//   主题的 `html[data-theme=x] .tab-item:hover` 特异性 (0,3,1)
//   **高于** `.tab-item:hover` (0,2,0) ⇒ 主题本来就盖得过状态色，
//   状态色写死不产生用户可见的脱节。
//
// **算**：**静止态**的基础底色 —— 它是标签行的「常驻外观」，
//   主题若不覆盖它，写死的值就会直接露出来。
//
// ── 事实来源 ────────────────────────────────────────────────────────────
//
// ① **主题的深色态写法**：`html[data-theme='creamy'].dark`（不是 `.dark .x`）——
//    ⇒ 「这条规则在深色态是否生效」的判定必须按**主题自己的写法**来。
// ② **哪些类在用**：扫 `src/**/*.{ts,tsx}` 里真实出现的 className。
//    死类（`.group-item` / `.drop-target` / `.drag-overlay` / `.group-header`
//    / `.tabs-container` —— 代码里用的是 `tab-group-header`）不参与判定：
//    它们的颜色不影响用户看到的任何东西。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(ROOT, 'src');

/** 读文件并剥掉注释（注释里的话不算声明）。 */
const read = (rel: string): string =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

const collect = (dir: string, ext: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
};

/** 代码里真正用到的 className 集合（从 className 字面量里取）。 */
const usedClassNames = (): Set<string> => {
  const used = new Set<string>();
  for (const file of collect(SRC, '.tsx')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const value = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      for (const cls of value.split(/\s+/)) {
        if (cls && /^[A-Za-z][\w-]*$/.test(cls)) used.add(cls);
      }
    }
  }
  return used;
};

const USED = usedClassNames();

interface Rule {
  selector: string;
  decls: Map<string, string>;
}

/** 解析 CSS（剥掉注释）成规则列表。 */
const parseRules = (css: string): Rule[] => {
  const rules: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      decls.set(d[1], d[2].trim());
    }
    if (decls.size) rules.push({ selector: m[1].trim(), decls });
  }
  return rules;
};

/** 规则里涉及到的 class。 */
const classesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]);

/**
 * 这条规则是**静止态**（没有 hover / active / focus / dragging 之类）吗？
 *
 * 状态色不参与判定 —— 主题的 `html[data-theme=x] .tab-item:hover` (0,3,1)
 * 压得过 `.tab-item:hover` (0,2,0)，写死不产生可见脱节。
 */
const isRestingState = (selector: string): boolean =>
  !/:(hover|active|focus|focus-visible|focus-within)\b/.test(selector) &&
  !/\.(dragging|drag-over|dragging-|drop-target|drag-indicator)\b/.test(selector);

/** 字面量底色（`transparent` / 令牌 / 渐变 / 具名色不算）。 */
const LITERAL_BG =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|white|black|silver|gray|grey)\b/i;

describe('drag-drop.css：静止态的底色不得写死（必须跟主题走）', () => {
  const CSS_FILE = 'src/styles/drag-drop.css';
  const rules = parseRules(read(CSS_FILE));

  it('（前提）drag-drop.css 在 global.css **之后**加载 ⇒ 它的规则会盖过主题', () => {
    // 这条是这个守卫存在的前提：若哪天把它挪进 global.css 的 @import 链里，
    // 加载顺序就变了 ⇒ 这里的判定依据（后加载者赢）就不再成立。
    const mainApp = read('src/components/app/MainApp.tsx');
    const globalCss = read('src/styles/global.css');
    assert.match(
      mainApp,
      /import ['"]@\/styles\/drag-drop\.css['"]/,
      'drag-drop.css 应当由 MainApp.tsx 单独 import（后加载 ⇒ 盖过主题）'
    );
    assert.doesNotMatch(
      globalCss,
      /@import ['"].*drag-drop\.css['"]/,
      '若 drag-drop.css 改进了 global.css 的 @import 链，本守卫的前提要重新评估'
    );
  });

  it('（前提）代码里确实在用 .tab-item', () => {
    assert.ok(USED.has('tab-item'), '代码里应当有 tab-item —— 否则本守卫的前提失效');
  });

  it('在用类的静止态底色不得是字面量', () => {
    const offenses: string[] = [];
    for (const rule of rules) {
      if (!isRestingState(rule.selector)) continue;
      const raw = rule.decls.get('background-color') ?? rule.decls.get('background');
      if (!raw) continue;
      if (!LITERAL_BG.test(raw)) continue; // transparent / 令牌 / 渐变
      const classes = classesOf(rule.selector);
      if (!classes.some(c => USED.has(c))) continue; // 死类不参与判定
      offenses.push(`  · ${rule.selector} → ${raw}`);
    }
    assert.equal(
      offenses.length,
      0,
      `drag-drop.css 里在用类的静止态底色写死了字面量 —— \n` +
        `这个文件在 global.css 之后加载，它的底色会盖过主题；\n` +
        `而 6 套主题里有 3 套（legacy/creamy/prism）没覆盖 .tab-item 的底色，\n` +
        `于是那些主题下的标签行是「一整块写死色」而不是卡片底透出来的颜色。\n` +
        `真机像素实测：深色/creamy 色差 32、深色/prism 28、浅色/creamy 12。\n` +
        `修法：底色改成 transparent（由主题与卡片底决定）。\n` +
        offenses.join('\n')
    );
  });

  it('.tab-item 的静止态底色必须是 transparent 或主题令牌（明确钉住这次的修法）', () => {
    const tabItemRules = rules.filter(
      r => classesOf(r.selector).includes('tab-item') && isRestingState(r.selector)
    );
    assert.ok(tabItemRules.length >= 4, `只找到 ${tabItemRules.length} 条静止态 .tab-item 规则`);
    for (const rule of tabItemRules) {
      const raw = rule.decls.get('background-color') ?? rule.decls.get('background');
      if (!raw) continue;
      assert.ok(
        /transparent|var\(--color-/i.test(raw),
        `${rule.selector} 的底色是「${raw}」—— 必须写成 transparent 或主题令牌，` +
          `否则主题说了不算（这个文件后加载，会盖过主题）`
      );
    }
  });

  it('三套缺底色的主题必须在自己的规则里把底色说清楚（根因，不只是症状）', () => {
    // 根因是这三套主题的 `.tab-item` 规则**不完整** ——
    // claude/apple/chrome 三套都写了 `background: transparent`，
    // 说明「标签行底色由主题决定」本来就是这个产品的意图。
    //
    // 这里钉的是「意图」而不是「具体写法」：
    // 三套主题的 `.tab-item` 规则里必须**提到 background**（不论什么值），
    // 这样「谁决定底色」这件事只发生在**一个**地方（主题层），
    // 而不是「主题层决定一部分、后加载的 drag-drop.css 决定另一部分」。
    //
    // 【选择器的引号形式不统一】legacy/prism 用 `data-theme="legacy"`，
    // creamy 用 `data-theme='creamy'` ⇒ 用**包含**判断，不写死正则。
    const THEME_FILES = [
      'src/styles/themes/legacy.css',
      'src/styles/themes/creamy.css',
      'src/styles/themes/prism.css',
    ];
    for (const file of THEME_FILES) {
      const themeRules = parseRules(read(file)).filter(
        r =>
          r.selector.includes('data-theme') &&
          r.selector.includes('.tab-item') &&
          // 只看**静止态**的那条（不含 :hover / 其它修饰类）
          !r.selector.includes(':hover') &&
          !/\.tab-item-/.test(r.selector) &&
          !r.selector.includes('single-column-layout')
      );
      assert.ok(themeRules.length > 0, `${file} 里找不到 .tab-item 的主题规则`);
      const declaresBackground = themeRules.some(
        r => r.decls.has('background') || r.decls.has('background-color')
      );
      assert.ok(
        declaresBackground,
        `${file} 的 .tab-item 规则没有声明底色 —— ` +
          `主题层不表态，底色就落回后加载的 drag-drop.css（那里是写死的），` +
          `于是该主题下的标签行与卡片底脱节。`
      );
    }
  });
});
