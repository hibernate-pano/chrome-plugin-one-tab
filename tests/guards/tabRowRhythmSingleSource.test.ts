// 标签行的垂直节奏**只有一处出处**（2026-10-24）。
//
// ── 这条防的具体事故 ───────────────────────────────────────────────────────
//
// 用户反馈：「标签组里的标签行距有点大，不够紧凑」。
// 真机实测（Chromium + 真实产物，6 套主题）给出的答案是：行盒 54px、
// 行距 56–58px，而一行里看得见的东西只有 20px（13px 标题）+ 12px 域名。
//
// 为什么会这样？因为**行高被三处各自写死的东西叠加出来了**，而且每一处
// 都以为自己说了算：
//
//   ① `src/styles/drag-drop.css` 的 `.tab-item { padding: 8px 12px; … }`
//      —— 它由 MainApp.tsx 单独 import ⇒ **在 global.css 之后加载**
//      ⇒ unlayered 且后加载 ⇒ 盖过 global.css（components 层）与主题。
//   ② `src/styles/themes/*.css` 的 `html[data-theme=x] .tab-item`
//      —— 特异性 (0,2,1) ⇒ 又盖过 drag-drop.css 的 (0,1,0)。
//   ③ `src/styles/global.css` 的 `.tab-item`（components 层）—— 谁都盖不过。
//
// 于是「行有多高」这件事有**三个事实源**，改一处另两处不动 ⇒
// 行高随主题漂移（54 / 58 / 62），锁定会话的行（没有删除键）还比
// 可删的行矮 10px。
//
// 2026-10-24 的修法：垂直节奏（padding / min-height / 分隔线 / 行间距）
// **只在 global.css 的 `.tab-item` 一处**给出，drag-drop.css 与 6 套主题
// 都不再声明。真实行盒 = 37px（内容 36 + 下边框 1），行距 37px。
//
// ── 为什么这条守卫是「扫描式」而不是「钉一处」 ────────────────────────────
//
// drag-drop.css 里 `.tab-item` 有**两套**规则（重复的两块）⇒ 只钉其中一处
// = 下一个人改回去，守卫照样绿。主题有 6 套 ⇒ 同理。
//
// ── 判据的边界 ───────────────────────────────────────────────────────────
//
// · **允许**主题声明**纯水平**的外边距（creamy 的 `margin: 0 8px`
//   —— 它的标签行是「内缩的圆角块」，这是那套主题的长相，不是松紧）。
//   垂直分量必须为 0，否则就是行距 ⇒ 越权。
// · **不允许**任何地方声明 `.tab-item` 的 padding / min-height / border
//   —— 分隔线与行高都归 global.css 那一条。
// · **不检查**死类（`.tab-item-url` 之类不是 `.tab-item`；类名带后缀的
//   也不算 —— 判定按**类名精确匹配**，与 dragDropCssFollowsTheme 一致）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_HIT_TARGET_PX } from '../../src/components/layout/hitTarget.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STYLES = resolve(ROOT, 'src/styles');
const GLOBAL_CSS = 'src/styles/global.css';

/** 读文件并剥掉注释（注释里的话不算声明）。 */
const read = (rel: string): string =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

interface Rule {
  selector: string;
  body: string;
  decls: Map<string, string>;
}

/** 解析 CSS（剥掉注释）成规则列表。 */
const parseRules = (css: string): Rule[] => {
  const rules: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = m[2];
    const decls = new Map<string, string>();
    for (const d of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      decls.set(d[1], d[2].trim());
    }
    rules.push({ selector: m[1].trim(), body, decls });
  }
  return rules;
};

/** 规则里涉及到的 class。 */
const classesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1]);

/** 这条规则命中的是 `.tab-item` 本身（不是 `.tab-item-title` 之类）。 */
const isTabItemRule = (rule: Rule): boolean =>
  classesOf(rule.selector).includes('tab-item');

/** 全部样式文件（相对仓库根）。 */
const styleFiles = (): string[] => {
  const files: string[] = [GLOBAL_CSS, 'src/styles/drag-drop.css'];
  for (const name of readdirSync(resolve(STYLES, 'themes')).sort()) {
    if (name.endsWith('.css')) files.push(`src/styles/themes/${name}`);
  }
  return files;
};

/** 所有命中 `.tab-item` 的规则（带文件路径）。 */
const tabItemRules = (): { file: string; rule: Rule }[] => {
  const out: { file: string; rule: Rule }[] = [];
  for (const file of styleFiles()) {
    for (const rule of parseRules(read(file))) {
      if (isTabItemRule(rule)) out.push({ file, rule });
    }
  }
  return out;
};

/**
 * 解析 `margin` / `padding` 简写 ⇒ { top, right, bottom, left }。
 * 值按 CSS 简写规则补齐；`0` 与 `0px` 都当作 0。
 */
const expandBox = (value: string): { top: string; right: string; bottom: string; left: string } => {
  const parts = value.split(/\s+/).filter(Boolean);
  const [t, r = t, b = t, l = r] = parts;
  return { top: t, right: r, bottom: b, left: l };
};

const isZero = (v: string): boolean => /^(0|0px|0rem)$/.test(v.trim());

/** CSS 长度 ⇒ px（只认得懂的单位；认不出来的返回 null）。 */
const toPx = (value: string): number | null => {
  const v = value.trim();
  if (/^0$/.test(v)) return 0;
  const px = /^(-?[\d.]+)px$/.exec(v);
  if (px) return Number(px[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(v);
  if (rem) return Number(rem[1]) * 16; // Tailwind 根字号 16px
  return null;
};

interface PaddingSource {
  file: string;
  /** 声明了纵向 padding 的地方（人话）。 */
  how: string;
  /** 纵向 padding 的像素值（取同一规则里各声明的最大值）。 */
  px: number;
}

describe('标签行：垂直节奏只有一个出处', () => {
  it('（前提）global.css 的 .tab-item 规则存在，且真的声明了节奏', () => {
    const globalRules = tabItemRules().filter(r => r.file === GLOBAL_CSS);
    assert.ok(globalRules.length > 0, 'global.css 里找不到 .tab-item 的规则');
    const rhythm = globalRules.find(r => r.rule.decls.has('min-height'));
    assert.ok(rhythm, 'global.css 的 .tab-item 规则必须声明 min-height（行高的事实源）');
    assert.ok(
      rhythm.rule.decls.has('border-bottom'),
      'global.css 的 .tab-item 规则必须声明 border-bottom（分隔线的事实源）'
    );
  });

  it('除 global.css 外，任何地方都不得再声明 .tab-item 的 padding / min-height / border', () => {
    const offenses: string[] = [];
    for (const { file, rule } of tabItemRules()) {
      if (file === GLOBAL_CSS) continue;
      for (const prop of ['padding', 'padding-top', 'padding-bottom', 'min-height', 'border', 'border-top', 'border-bottom']) {
        const value = rule.decls.get(prop);
        if (!value) continue;
        offenses.push(`  · ${file} → ${rule.selector} { ${prop}: ${value} }`);
      }
      // `@apply` 里也可能藏着纵向 padding（py-2 / p-2 之类）
      const apply = rule.body.match(/@apply([^;]*);/);
      if (apply && /\bpy-|\bp-\d/.test(apply[1])) {
        offenses.push(`  · ${file} → ${rule.selector} { @apply${apply[1]} }`);
      }
    }
    assert.equal(
      offenses.length,
      0,
      '标签行的垂直节奏（padding / min-height / 分隔线）只能由 global.css 的\n' +
        '.tab-item 一处给出 —— drag-drop.css 在 global.css 之后加载（unlayered\n' +
        '且后加载 ⇒ 盖过主题），主题的特异性又是 (0,2,1) ⇒ 多处声明时\n' +
        '「谁说了算」取决于文件顺序，而不是取决于谁想清楚了。\n' +
        '2026-10-24 实测：行盒 54px / 行距 56–58px（13px 的标题占 58px），\n' +
        '且锁定会话的行比可删的行矮 10px。收紧后统一为 37px。\n' +
        offenses.join('\n')
    );
  });

  it('主题只许留纯水平的外边距（creamy 的内缩是长相，不是行距）', () => {
    const offenses: string[] = [];
    for (const { file, rule } of tabItemRules()) {
      if (file === GLOBAL_CSS) continue;
      for (const prop of ['margin', 'margin-top', 'margin-bottom']) {
        const value = rule.decls.get(prop);
        if (!value) continue;
        const box = expandBox(value);
        const verticalOk =
          prop === 'margin-top'
            ? isZero(box.top)
            : prop === 'margin-bottom'
              ? isZero(box.bottom)
              : isZero(box.top) && isZero(box.bottom);
        if (!verticalOk) {
          offenses.push(`  · ${file} → ${rule.selector} { ${prop}: ${value} }`);
        }
      }
    }
    assert.equal(
      offenses.length,
      0,
      '主题给 .tab-item 加的**纵向**外边距 = 行距 ⇒ 越权（行距归 global.css 一处）。\n' +
        '纯水平的外边距（creamy 的 `margin: 0 8px` 内缩圆角块）允许。\n' +
        offenses.join('\n')
    );
  });

  it('global.css 的 .tab-item 不用纵向 padding 把行撑高', () => {
    const rhythm = tabItemRules()
      .filter(r => r.file === GLOBAL_CSS)
      .find(r => r.rule.decls.has('min-height'));
    assert.ok(rhythm);
    const apply = rhythm.rule.body.match(/@apply([^;]*);/);
    assert.ok(apply, '.tab-item 应当用 @apply 声明布局工具类');
    assert.ok(
      !/\bpy-/.test(apply[1]),
      `.tab-item 的 @apply 里出现了纵向 padding（${apply[1].trim()}）—— ` +
        '那会把行撑高（行高应当由内容 + min-height 决定）'
    );
    const padding = rhythm.rule.decls.get('padding');
    if (padding) {
      const box = expandBox(padding);
      assert.ok(
        isZero(box.top) && isZero(box.bottom),
        `.tab-item 的 padding 有纵向分量（${padding}）—— 行高应当由内容决定`
      );
    }
  });

  it('global.css 的 .tab-item 行高不得低于命中区下限（删除键是 36×36）', () => {
    const rhythm = tabItemRules()
      .filter(r => r.file === GLOBAL_CSS)
      .find(r => r.rule.decls.has('min-height'));
    assert.ok(rhythm);
    const raw = rhythm.rule.decls.get('min-height')!;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
    assert.ok(px, `min-height 的取值不是 px 字面量（${raw}）—— 判据读不懂`);
    const value = Number(px[1]);
    assert.ok(
      value >= MIN_HIT_TARGET_PX,
      `行高 ${value}px 低于本仓的命中区下限 ${MIN_HIT_TARGET_PX}px —— ` +
        '删除键是全产品最贵的一颗按钮（物理清除、无回收站、无撤销）'
    );
  });

  it('卡片里的标签行与搜索结果行用同一套「撑满行高」的写法', () => {
    // 两处共用 `.tab-item` 这个类 ⇒ 它们的内部结构必须一样，
    // 否则「卡片里的行 37px、搜索结果里的行 58px」这种分裂会重新出现。
    for (const file of [
      'src/components/dnd/DraggableTab.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      const src = read(file);
      assert.match(src, /tab-item-body/, `${file} 里的标签行没有用 .tab-item-body`);
      assert.match(src, /items-stretch/, `${file} 里的标签行没有用 items-stretch`);
      assert.match(src, /self-stretch/, `${file} 里的标签行没有用 self-stretch`);
      assert.match(
        src,
        /tab-item-url[^"]*self-center/,
        `${file} 里的域名没有用 self-center —— 行被撑高后它会贴在框顶`
      );
    }
  });
});

/**
 * 卡头（标签组那一行）的垂直节奏同样只有一个出处。
 *
 * 2026-10-24：产品负责人看过截图后指出「标签组那一行的高度太大了」，
 * 随后定案：**卡头就是「一行」，只比一行高一点点**（高 4px 即可，
 * 区别靠底色/字号/边框，不靠厚度）。
 *
 * 实测：卡头盒高 = 内容 36px（那 5 颗按钮的命中区下限）+ 上下 padding
 * + 下边框 1 ⇒ 上下 padding 8–12px 时卡头是 53–61px，
 * 而标签行已经收到 37px ⇒ 卡头成了一条厚重的横带。
 * 收紧后：上下 2px ⇒ **41px**（6 套主题一致）。
 *
 * 同样的坑：**padding 有三个事实源**（global.css / legacy 主题的
 * `padding: 8px 12px` / 其余主题的断点值）⇒ 这里钉住「只有一处」。
 */
describe('卡头：垂直节奏同样只有一个出处', () => {
  /** 命中 `.tab-group-header` 本身（不是 `.tab-group-header-row` 之类）。 */
  const headerRules = (): { file: string; rule: Rule }[] => {
    const out: { file: string; rule: Rule }[] = [];
    for (const file of styleFiles()) {
      for (const rule of parseRules(read(file))) {
        if (classesOf(rule.selector).includes('tab-group-header')) out.push({ file, rule });
      }
    }
    return out;
  };

  /**
   * 全仓所有「声明了卡头**纵向** padding」的地方。
   *
   * 认两种写法：`padding` / `padding-top` / `padding-bottom` 声明式，
   * 以及 `@apply` 里的 `py-*`（Tailwind 间距刻度：n → n × 0.25rem = n × 4px）。
   */
  const headerVerticalPadding = (): PaddingSource[] => {
    const out: PaddingSource[] = [];
    for (const { file, rule } of headerRules()) {
      const pxs: number[] = [];
      const hows: string[] = [];
      for (const prop of ['padding', 'padding-top', 'padding-bottom']) {
        const v = rule.decls.get(prop);
        if (v === undefined) continue;
        const box = expandBox(v);
        const parts =
          prop === 'padding'
            ? [box.top, box.bottom]
            : prop === 'padding-top'
              ? [box.top]
              : [box.bottom];
        for (const part of parts) {
          const px = toPx(part);
          if (px === null) continue; // 认不出来的单位 ⇒ 不参与判定（另有守卫管）
          pxs.push(px);
        }
        hows.push(`${prop}: ${v}`);
      }
      const apply = rule.body.match(/@apply([^;]*);/);
      if (apply) {
        const m = apply[1].match(/\bpy-(\d+(?:\.\d+)?)/);
        if (m) {
          pxs.push(Number(m[1]) * 4);
          hows.push(`@apply ${apply[1].trim()}`);
        }
      }
      if (pxs.length) out.push({ file, how: hows.join(' / '), px: Math.max(...pxs) });
    }
    return out;
  };

  it('除 global.css 外，任何地方都不得再声明 .tab-group-header 的 padding', () => {
    const offenses: string[] = [];
    for (const { file, rule } of headerRules()) {
      if (file === GLOBAL_CSS) continue;
      for (const prop of ['padding', 'padding-top', 'padding-bottom']) {
        const value = rule.decls.get(prop);
        if (!value) continue;
        offenses.push(`  · ${file} → ${rule.selector} { ${prop}: ${value} }`);
      }
    }
    assert.equal(
      offenses.length,
      0,
      '卡头的 padding 只能由 global.css 的 `.tab-group-header` 一处给出 ——\n' +
        'legacy 主题当年就自己写死过 `padding: 8px 12px`（卡头 53px），\n' +
        '其余主题走断点值（12px ⇒ 61px）⇒ 同一个卡头三种厚度。\n' +
        offenses.join('\n')
    );
  });

  it('global.css 的卡头纵向 padding 不超过 2px（卡头只比一行标签高一点点）', () => {
    // ⚠️ 不能简单地「取 global.css 里第一条命中 .tab-group-header 的规则」——
    //    global.css 里还有一条 transition 规则也命中这个类（它不带 @apply）。
    //    这里按「**声明了纵向 padding**」来定位事实源。
    const sources = headerVerticalPadding();
    assert.equal(
      sources.length,
      1,
      '全仓应当只有一处声明卡头的纵向 padding —— ' +
        `实际有 ${sources.length} 处：${sources.map(s => `${s.file}（${s.how}）`).join('、')}`
    );
    const [only] = sources;
    assert.equal(only.file, GLOBAL_CSS, `卡头的纵向 padding 应当只由 ${GLOBAL_CSS} 给出`);
    assert.ok(
      only.px <= 2,
      `卡头的纵向 padding 是 ${only.px}px（${only.how}）—— ` +
        '产品定案是「卡头就是一行，只比一行高一点点（4px）」；\n' +
        '更高的卡头会让「一屏能列多少行」被分组头吃掉。'
    );
  });
});
