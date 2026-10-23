// 引导标题**不许**画焦点环（2026-10-23 真机实测，第 49 轮）。
//
// ── 这个缺陷的形状 ────────────────────────────────────────────────────────
// 全新用户看到的**第一屏**（引导第 1 步）的标题上，套着一个 **2px 的蓝色框**
// —— 看起来像一个输入框，或者一个坏掉的按钮。
//
// 【为什么】每换一步，代码都会把焦点移到该步标题上
// （`src/components/onboarding/OnboardingGuide.tsx` 的 `title?.focus()`），
// 那是给**读屏**用的（它会播报「欢迎使用 TapStack」「先保存一个会话」……）。
// 而全局那条 `:focus-visible { outline: 2px solid var(--color-focus-ring) }`
// 会把这个环一并画出来。
//
// ⚠️ 但那个标题是 `tabIndex={-1}` ⇒ **不在 Tab 序列里** ⇒
//   键盘用户永远不可能「Tab 到它」⇒ 焦点环对它**没有任何信息量**。
//   （这也是 USWDS / GOV.UK 那套「程序化聚焦标题」的标准做法：
//     `h2[tabindex="-1"]:focus { outline: none }` —— 环只会把标题画成一个输入框。）
//
// ⚠️ **为什么偏偏只出现在第一屏**：Chrome 的启发式是
//   「程序化聚焦时，若用户还没动过鼠标 ⇒ 匹配 `:focus-visible`；
//     一旦点过一次按钮，之后每一步的聚焦都不匹配」。
//   ⇒ 这个环**只出现在第 1 步** —— 也就是**第一印象**那一屏。
//   （真机实测：第 1 步 `outline: rgb(29,78,216) solid 2px`、
//     `matches(':focus-visible') === true`；第 2 步起 `outline-style: none`。）
//
// ── 这条判据为什么必须算**特异度**（真机撞过一次）──────────────────────
// 第一版守卫只钉「onboarding.css 里有 outline: none」⇒ **全绿**，
// 可真机画面上那圈蓝框**照样在**。原因是**级联**：
//   6 套主题各自有 `html[data-theme="xxx"] :focus-visible { outline: 2px solid … }`
//   —— 那是 **(0,2,1)**；而当时的 `.onboarding-title:focus-visible` 只有 **(0,2,0)**
//   ⇒ **规则写得再对，也被主题那条压过去**。
// ⇒ 「文件里有 outline: none」≠「画面上那圈环没了」。
//   这里判的是**特异度**：引导那条必须**严格压住**所有「能落到这个 h2 上」的
//   焦点环规则；压不住 ⇒ 红。
//   （真机那一半由 scripts/lead-verify-onboarding-focus-ring.mjs 兜底：
//     静态判据算得再准，也替不了浏览器算出来的**最终**层叠结果。）
//
// ── 为什么这条守卫是**结构**的，而不是「文件里有 outline: none 就绿」 ──────
// 单纯钉一句 `outline: none` 会把「为什么」丢掉：将来若有人把标题改成
// **可 Tab 到的**（那是有意的键盘可达性改进），那时焦点环**必须**回来。
// ⇒ 这里钉的是**一条双向契约**：
//   标题不可 Tab 到 ⇒ 焦点环必须关掉；
//   标题可 Tab 到   ⇒ 焦点环必须留着（那时环是**该有的**）。
//   两个方向都必须被这条守卫同时看着 —— 只钉一半，早晚被人从另一半钻进来。
//
// 【判据的检测力】见 tests/guards/onboardingTitleFocusRingMutation.test.ts
// （把标题改成可 Tab 到 ⇒ 必须红；把「去掉环」这条实现改掉 ⇒ 必须红；
//   把选择器**削弱**到压不过主题那条 ⇒ 必须红（这正是真机撞过的那次）；
//   把「把焦点移到标题」删掉 ⇒ 必须红；
//   等价改写（换个选择器写法）⇒ 必须仍然绿）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STYLES_DIR = resolve(ROOT, 'src/styles');
/** 读文件并**剥掉注释** —— 否则注释里的花括号会把规则切碎。 */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ');
const read = (rel: string): string => stripComments(readFileSync(resolve(ROOT, rel), 'utf8'));

const STEPS_TSX = read('src/components/onboarding/OnboardingSteps.tsx');
const GUIDE_TSX = read('src/components/onboarding/OnboardingGuide.tsx');

// ─────────────────────────────────────────────────────────────────────
// ① 标题本身
// ─────────────────────────────────────────────────────────────────────

/** 所有带 `onboarding-title` 的标题元素的开标签。 */
function titleTags(): string[] {
  const tags = [...STEPS_TSX.matchAll(/<h2\b[^>]*className="onboarding-title"[^>]*>/g)].map(m => m[0]);
  assert.ok(tags.length > 0, '找不到带 className="onboarding-title" 的 h2 —— 判据锚点丢了');
  return tags;
}

/** 标题元素现在是不是**不在** Tab 序列里（`tabIndex={-1}`）。 */
function titleIsNotTabbable(): boolean {
  return titleTags().every(tag => /tabIndex=\{\s*-1\s*\}/.test(tag));
}

/** 标题元素里有没有出现**可 Tab 到**的写法（tabIndex 0 / 无 tabIndex）。 */
function titleHasTabbableVariant(): boolean {
  return titleTags().some(tag => !/tabIndex=\{\s*-1\s*\}/.test(tag));
}

// ─────────────────────────────────────────────────────────────────────
// ② CSS 规则与特异度
// ─────────────────────────────────────────────────────────────────────

/** 一条 CSS 规则。 */
interface CssRule {
  /** 仓库相对路径（报错用）。 */
  file: string;
  /** 选择器（可能是一组，用逗号分隔）。 */
  selector: string;
  /** 声明部分。 */
  body: string;
}

/** 特异度三元组：(id, 类/属性/伪类, 元素/伪元素)。 */
interface Spec {
  id: number;
  cls: number;
  type: number;
}

/** 递归列出 src/styles 下所有 .css。 */
function cssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.css')) out.push(path);
    }
  };
  walk(STYLES_DIR);
  return out.sort();
}

/** 把所有样式表里的规则抠出来（嵌套块的内层规则也能抠出来）。 */
function cssRules(): CssRule[] {
  const out: CssRule[] = [];
  for (const file of cssFiles()) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({
        file: file.slice(ROOT.length + 1),
        selector: m[1].trim(),
        body: m[2],
      });
    }
  }
  return out;
}

/**
 * 算一条选择器的特异度。
 *
 * ⚠️ 近似说明：`:where()` 的参数按 0 算（正确）；`:is()/:not()/:has()`
 * 的参数按里面的内容整体计入（精确做法是取参数里**最具体**的那条，这里偏严，
 * 只会让守卫**更早**变红，不会放过破口）。
 */
function specOf(selector: string): Spec {
  let sel = selector.trim().replace(/"[^"]*"|'[^']*'/g, '');
  sel = sel.replace(/:where\([^()]*\)/g, ':where');
  const inner: string[] = [];
  sel = sel.replace(/:(?:is|not|has)\(([^()]*)\)/g, (_all, args: string) => {
    inner.push(args);
    return ':fn';
  });
  const id = (sel.match(/#[\w-]+/g) ?? []).length;
  const cls =
    (sel.match(/\.[\w-]+/g) ?? []).length +
    (sel.match(/\[[^\]]*\]/g) ?? []).length +
    (sel.match(/(^|[^:]):[\w-]+/g) ?? []).length +
    inner.reduce((sum, args) => {
      const s = specOf(args);
      return sum + s.id + s.cls + s.type;
    }, 0);
  const type = (sel.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length;
  return { id, cls, type };
}

/** 比较两个特异度：>0 表示 a 更强，0 表示一样强。 */
function compareSpec(a: Spec, b: Spec): number {
  if (a.id !== b.id) return a.id - b.id;
  if (a.cls !== b.cls) return a.cls - b.cls;
  return a.type - b.type;
}

const fmtSpec = (s: Spec): string => `(${s.id},${s.cls},${s.type})`;

/** 声明块里某条声明的值（`outline: none` 与 `outline-style: none` 都算）。 */
function declaration(blockCss: string, prop: string): string {
  for (const decl of blockCss.split(';')) {
    const at = decl.indexOf(':');
    if (at === -1) continue;
    if (decl.slice(0, at).trim() !== prop) continue;
    return decl.slice(at + 1).trim();
  }
  return '';
}

/** 这条规则声明的 outline 值（`outline` 优先，没有则看 `outline-style`）。 */
function outlineValue(body: string): string {
  return declaration(body, 'outline') || declaration(body, 'outline-style');
}

/**
 * 这条选择器**能不能**落到引导标题（`h2.onboarding-title`）上。
 *
 * 判据：看**最右一段**复合选择器 —— 若它要求某个类 / ID / 属性（我们的标题没有），
 * 或者要求别的元素类型（我们的标题是 h2）⇒ 落不到，不参与竞争。
 */
function mayMatchTitle(selector: string): boolean {
  const last = (selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '').trim();
  if (!last) return false;
  if (/[.#[]/.test(last)) return false;
  const type = last.match(/^([a-zA-Z][\w-]*)/);
  if (type && type[1].toLowerCase() !== 'h2') return false;
  return true;
}

/** 我们自己那些「去掉环」的规则（onboarding.css 里，提到引导标题或引导遮罩层）。 */
function ringOffRules(): CssRule[] {
  return cssRules().filter(
    rule =>
      rule.file === 'src/styles/onboarding.css' &&
      /:focus/.test(rule.selector) &&
      outlineValue(rule.body) === 'none' &&
      (rule.selector.includes('.onboarding-title') || rule.selector.includes('.onboarding-overlay'))
  );
}

/** 「标题去环」那条规则（找不到 ⇒ undefined）。 */
function titleRingOffRule(): CssRule | undefined {
  return ringOffRules().find(rule => rule.selector.includes('.onboarding-title'));
}

/** 一条规则里**最强**的那条选择器的特异度（选择器一组 ⇒ 取最强的那个）。 */
function ruleSpec(rule: CssRule): Spec {
  let best: Spec = { id: 0, cls: 0, type: 0 };
  for (const sel of rule.selector.split(',')) {
    const s = specOf(sel);
    if (compareSpec(s, best) > 0) best = s;
  }
  return best;
}

/**
 * 所有「会给引导标题画焦点环」的竞争规则 —— 也就是**别的**样式表里
 * 声明了非 none 的 outline、且选择器**能落到这个 h2 上**的那些规则。
 */
function ringCompetitors(): Array<{ rule: CssRule; selector: string; spec: Spec; important: boolean }> {
  const out: Array<{ rule: CssRule; selector: string; spec: Spec; important: boolean }> = [];
  for (const rule of cssRules()) {
    if (!/:focus/.test(rule.selector)) continue;
    const value = outlineValue(rule.body);
    // 只关心**真的会画环**的规则（outline: none 是「关环」，不是竞争者）。
    if (!value || value === 'none') continue;
    for (const sel of rule.selector.split(',')) {
      if (!mayMatchTitle(sel)) continue;
      out.push({
        rule,
        selector: sel.trim(),
        spec: specOf(sel),
        important: /!important/i.test(value),
      });
    }
  }
  return out;
}

describe('引导标题不许画焦点环（第一屏那圈蓝框）', () => {
  it('标题是 tabIndex={-1}（不在 Tab 序列里）—— 焦点环对它没有信息量', () => {
    assert.ok(
      titleIsNotTabbable(),
      '引导标题应当是 `tabIndex={-1}`（只给读屏播报用，不进 Tab 序列）。' +
        '若它变成可 Tab 到的元素，焦点环就是**该有的**，那时请把下面那条契约一起改。'
    );
  });

  it('焦点环必须与「标题是否在 Tab 序列里」同进同退（双向契约）', () => {
    const tabbable = titleHasTabbableVariant();
    const rule = titleRingOffRule();

    if (tabbable) {
      // 方向一：标题可 Tab 到 ⇒ 环是**该有的**（键盘用户要看得出焦点在哪）。
      assert.ok(
        !rule,
        '引导标题已经是**可 Tab 到**的了 ⇒ 焦点环是**该有的**（键盘用户要看得出焦点在哪），' +
          '不能继续把它关掉。请把这条守卫连同实现一起改。'
      );
      return;
    }

    // 方向二：标题不可 Tab 到 ⇒ 环必须关掉。
    assert.ok(
      rule,
      'onboarding.css 里找不到「.onboarding-title + :focus ⇒ outline: none」的规则 —— ' +
        '全局那条 `:focus-visible { outline: 2px solid ... }` 会把环画到**第一屏**的标题上，' +
        '看起来像一个输入框。'
    );
  });

  it('代码里那处「把焦点移到标题」的写法还在（读屏播报不能被顺手删掉）', () => {
    assert.match(
      GUIDE_TSX,
      /querySelector[^;\n]*['"]\.onboarding-title['"][\s\S]{0,200}?\.focus\(\)/,
      'OnboardingGuide 必须在换步时把焦点移到标题上（读屏播报新步骤）—— ' +
        '去掉焦点 = 读屏用户听不到「现在到第几步了」。'
    );
  });

  it('【级联】我们那些「去环」规则必须**压得住**所有会落到这些元素上的焦点环规则', () => {
    const ours = ringOffRules();
    assert.ok(
      ours.length > 0,
      'onboarding.css 里找不到「:focus ⇒ outline: none」的规则 —— ' +
        '第一屏那圈蓝框会回来。'
    );
    const competitors = ringCompetitors();
    assert.ok(
      competitors.length > 0,
      '一条竞争规则都找不到 ⇒ 判据可能已经失声（特异度计算器坏了？）—— ' +
        '请顺手检查下面那条自检断言。'
    );
    for (const rule of ours) {
      const mine = ruleSpec(rule);
      for (const c of competitors) {
        assert.ok(
          compareSpec(mine, c.spec) > 0,
          `我们那条规则 \`${rule.selector}\`（特异度 ${fmtSpec(mine)}）**压不住** ` +
            `${c.rule.file} 的 \`${c.selector}\`（特异度 ${fmtSpec(c.spec)}）—— ` +
            '级联里赢的那个才是真的：文件里写着 outline: none，**画面上的环照样在**。' +
            '把我们的选择器写得比它更具体（例如加上 `.onboarding-overlay` 这一层类）。'
        );
        assert.ok(
          !c.important,
          `${c.rule.file} 的 \`${c.selector}\` 用了 !important —— ` +
            '它会**无视**特异度直接赢，我们的 outline: none 压不住它。'
        );
      }
    }
  });

  it('自检：特异度计算器本身没坏（否则上面那条判据是恒真的）', () => {
    assert.deepEqual(specOf('html[data-theme="chrome"] :focus-visible'), { id: 0, cls: 2, type: 1 });
    assert.deepEqual(specOf(':focus-visible'), { id: 0, cls: 1, type: 0 });
    assert.deepEqual(specOf('.onboarding-overlay .onboarding-title:focus-visible'), {
      id: 0,
      cls: 3,
      type: 0,
    });
    assert.deepEqual(specOf('h2.onboarding-title'), { id: 0, cls: 1, type: 1 });
    assert.deepEqual(specOf('html body .onboarding-overlay:focus-visible'), {
      id: 0,
      cls: 2,
      type: 2,
    });
    assert.deepEqual(specOf('#a .b'), { id: 1, cls: 1, type: 0 });
  });
});
