/**
 * 新手引导与菜单的「文案不诚实 / 入口够不着」回归钉（2026-10-23 审计 H-1…H-14）。
 *
 * ── 这份文件守的是什么 ────────────────────────────────────────────────────
 *
 * 引导是**每个新用户的第一屏**。它说错一句话，用户就照着错的前提去找功能，
 * 找不到 ⇒ 得出「这产品没有这个功能 / 坏了」的结论。
 * 本轮审计出的 14 条里，多数是这一类：**界面承诺 > 界面兑现**。
 *
 * ── 守卫的写法：钉不变量，不钉字面量 ──────────────────────────────────────
 *
 * 本文件刻意**不**写死中文文案。每一处的判据都从**事实来源**现场读出来：
 *
 *   · 开关的默认状态  ← `utils/storage.ts` 的 `DEFAULT_SETTINGS`
 *   · 开关的名字与位置 ← `options/OptionsPage.tsx` 的 ToggleRow label
 *   · 空态那句话     ← `components/tabs/emptyStateActions.ts` 的常量
 *   · 排序的选项     ← `core/sessionSort.ts` 的 `SESSION_SORT_OPTIONS`
 *   · 恢复的两个入口 ← `components/tabs/TabGroup.tsx` 的两个 aria-label
 *   · 同步的两颗按钮 ← `components/sync/SyncButton.tsx` 的两个 aria-label
 *   · 导入的命名规则 ← `core/oneTabFormatParser.ts` 的 `deriveImportedGroupName`
 *   · 命中的口径     ← `components/layout/hitTarget.ts` 的常量
 *
 * 为什么这样写：本仓库反复踩过「守卫钉死字面量」的坑 ——
 * 守卫一旦钉住一句中文，**改对实现**反而让它变红，于是后来的人把文案改回去。
 * （2026-10-23 审计 H-7 就是活例子：搜索框的 aria-label 补上「URL」之后，
 * `tests/guards/onboardingSpotlightFallback.test.ts` 钉着的旧字面量变红。）
 * ⇒ 判据钉**关系**（「引导说的东西必须在事实来源里存在」），
 *   措辞可以自由改，而「承诺与兑现脱节」这类真缺陷仍然会被抓住。
 *
 * ── 变异自证（每条都实测过：改坏实现 ⇒ 对应用例变红）────────────────────
 *
 *   M1  把「去登录」按钮的 `py-1.5` 去掉              ⇒ 「命中区高度」变红
 *   M2  把 Header 的 aria-label 改回不含「URL」       ⇒ 「搜索教了 URL / 界面也得说」变红
 *   M3a 只改兜底链那一处聚光灯选择器（步骤 3 留着新的）⇒ 「聚光灯与 Header 同源」变红
 *   M3b 只改步骤 3 那一处（兜底链留着新的）            ⇒ 同上变红
 *   M4  把 `DEFAULT_SETTINGS.collectPinnedTabs` 改成 true ⇒ 「固定标签页默认状态」变红
 *   M5  把 `DEFAULT_SETTINGS.syncEnabled` 改成 true    ⇒ 「定时拉取默认关闭」变红
 *   M6  把引导里复用空态那句话的地方改回自己写一句      ⇒ 「拉回是合并」变红
 *   M8  把引导里的「在当前窗口」那句删掉                ⇒ 「恢复的两个入口」变红
 *   M9  把 TabGroup 的「在当前窗口打开整个会话」改名    ⇒ 「（事实来源）TabGroup 里确实有这个按钮」变红
 *   M10 把引导里的「排序」那张卡的标题改掉              ⇒ 「排序被教了」变红
 *   M12 把引导里的「上传」「下载」那句删掉              ⇒ 「同步入口都被教了」变红
 *   M14 把引导里的「OneTab … 不带会话名」那句删掉      ⇒ 「OneTab 不带会话名」变红
 *   M16 把 TabGroup 的徽章改回裸数字                   ⇒ 「徽章必须带视觉单位」变红
 *   M17 把 TabCounter 的「个标签页」改回「标签」         ⇒ 「同一个实体一个名字」变红
 *   M18 把 lockedDeleteCopy 的「个标签页」改回「个标签记录」⇒ 同上变红
 *   M19 把 TabGroup 的 LOCK_TOOLTIP 去掉「恢复后仍留在列表里」⇒ 「锁定保住会话」变红
 *   M20 把引导里的「固定标签页」标题改回「Pinned 可选」 ⇒ 「不用英文 Pinned」变红
 *   M21 把引导里「这些标签随之关闭」的例外那句删掉      ⇒ 「关闭的例外」变红
 *   M22 把 OptionsPage 里那个开关改名                   ⇒ 「开关名一致」变红
 *   M23 把卡片标题改回「自动同步」                      ⇒ 「自动同步不是标题」变红
 *   M24 把引导里锁定的「恢复后仍留在列表里」删掉        ⇒ 「引导教了锁定」变红
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EMPTY_STATE_ACTION_HINT } from '@/components/tabs/emptyStateActions';
import { SESSION_SORT_OPTIONS } from '@/core/sessionSort';
import { MIN_HIT_TARGET_PX } from '@/components/layout/hitTarget';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STEPS = read('src/components/onboarding/OnboardingSteps.tsx');
const GUIDE = read('src/components/onboarding/OnboardingGuide.tsx');
const HEADER = read('src/components/layout/Header.tsx');
const DROPDOWN = read('src/components/layout/HeaderDropdown.tsx');
const TAB_GROUP = read('src/components/tabs/TabGroup.tsx');
const TAB_COUNTER = read('src/components/layout/TabCounter.tsx');
const LOCKED_DELETE = read('src/components/tabs/lockedDeleteCopy.ts');
const SYNC_BUTTON = read('src/components/sync/SyncButton.tsx');
const STORAGE = read('src/utils/storage.ts');
const OPTIONS = read('src/options/OptionsPage.tsx');
const ONETAB_PARSER = read('src/core/oneTabFormatParser.ts');
const SEARCH_HINT = read('src/components/search/searchEmptyHint.ts');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const STEPS_CODE = stripComments(STEPS);
const TAB_GROUP_CODE = stripComments(TAB_GROUP);

/** 引导里某个字符串常量（`{CONST}` 形式）在**可见文案**里被用到。 */
function stepsUsesConstant(name: string): boolean {
  return new RegExp(`\\{${name}\\}`).test(STEPS_CODE);
}

// ══════════════════════════════════════════════════════════════════════════
// H-1 · 「去登录」的命中区
// ══════════════════════════════════════════════════════════════════════════

describe('H-1 · 菜单里那个「去登录」的命中区', () => {
  /**
   * 状态卡里那个内联入口的 className。
   *
   * 定位方式：**按它渲染出来的文字**找，而不是按 `role="menuitem"` ——
   * 菜单里带 menuitem 角色的按钮有十来个（刷新图标也是），
   * 按角色找会抓错对象。
   */
  function loginEntryClassName(): string {
    const button = DROPDOWN.match(
      /<button\s+role="menuitem"[\s\S]{0,400}?className="([^"]*)"\s*>\s*\{MENU_LOGIN_LABEL\}/
    );
    assert.ok(button, '菜单里找不到渲染 {MENU_LOGIN_LABEL} 的那个内联按钮');
    return button[1];
  }

  it('它仍然在状态卡里、保住 menuitem 角色、引用 MENU_LOGIN_LABEL（有意的设计，不能挪走）', () => {
    const button = DROPDOWN.match(
      /<button\s+role="menuitem"[\s\S]{0,400}?>\s*\{MENU_LOGIN_LABEL\}/
    );
    assert.ok(button, '找不到那个内联按钮');
    assert.match(button[0], /role="menuitem"/, '读屏的菜单键盘模型要求它带 menuitem 角色');
    assert.ok(
      stepsUsesConstant('MENU_LOGIN_LABEL'),
      '引导必须引用 MENU_LOGIN_LABEL（字面量只有一个出处）'
    );
  });

  it('它的命中区高度撑得开（不是 16px 的文字行）', () => {
    const className = loginEntryClassName();

    // 本仓的命中区口径只认 min-w/min-h（那是**图标按钮**的形状）。
    // 这个入口是**内联文字** ⇒ 盒子由 padding + 行高决定 ⇒ 按
    // 「行高 + 上下 padding」算高度，而不是 min-h-*。
    const lineHeight = /text-sm/.test(className) ? 20 : /text-xs/.test(className) ? 16 : 24;
    const pyMatch = className.match(/\bpy-(\d+(?:\.\d+)?)/);
    assert.ok(pyMatch, '内联文字入口必须有纵向 padding（否则命中区就是一行文字的高度）');
    // Tailwind 间距刻度：n → n × 0.25rem = n × 4px
    const paddingY = parseFloat(pyMatch[1]) * 4;
    const height = lineHeight + paddingY * 2;

    // WCAG 2.2 SC 2.5.8 (AA) 的下限是 24px；本仓自己取 36（见 hitTarget.ts）。
    // 但 36px 是**图标按钮**的尺寸口径 —— 内联文字入口放进状态卡抬头行，
    // 撑到 36px 会把那一行变成两行高（实测过，见守卫头部的说明）。
    // ⇒ 判据取 **AA 的下限 24px**：够用、不越界、且真的比 16px 好。
    assert.ok(
      height >= 24,
      `命中区高度只有 ${height}px（行高 ${lineHeight} + py ${paddingY * 2}px）—— ` +
        '低于 WCAG 2.2 SC 2.5.8 (AA) 的 24px 下限'
    );
    // 参照：本仓自己的口径是 36（MIN_HIT_TARGET_PX），此处不得低于它的 2/3。
    assert.ok(
      height >= MIN_HIT_TARGET_PX * (2 / 3),
      `命中区高度 ${height}px 相对本仓口径 ${MIN_HIT_TARGET_PX}px 太小`
    );
  });

  it('它的字号与菜单行一致（不是 12px 的小字）', () => {
    const className = loginEntryClassName();
    assert.match(className, /text-sm/, '入口的字号必须与菜单行一致（text-sm）');
  });

  it('它不用 MENU_ROW（那是菜单行的类名，复用会把计数守卫带偏）', () => {
    const className = loginEntryClassName();
    assert.doesNotMatch(className, /MENU_ROW/, '内联文字入口不得复用菜单行的类名');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-2 / H-3 · 默认关闭的开关不许被说成「随你 / 自动」
// ══════════════════════════════════════════════════════════════════════════

describe('H-2 · 固定标签页的开关默认关着', () => {
  it('（事实来源）默认确实是不收集固定标签页', () => {
    assert.match(
      STORAGE,
      /collectPinnedTabs:\s*false/,
      '事实来源变了：本守卫钉的是「默认关闭」这个事实（storage.ts 的 DEFAULT_SETTINGS）'
    );
  });

  it('引导必须说清「默认不保存」，而不是「可保留，也可一并保存」', () => {
    assert.doesNotMatch(
      STEPS_CODE,
      /固定标签页可保留/,
      '「可保留，也可一并保存」把一个默认关闭、藏在设置页的开关说成随你'
    );
    assert.match(
      STEPS_CODE,
      /默认不保存/,
      '引导必须说清默认状态（默认不保存）'
    );
  });

  it('引导必须告诉用户开关在设置页，并把开关的**真实名字**说出来', () => {
    // 开关名从 OptionsPage 的 ToggleRow label 现场读 ——
    // 名字变了，引导里的指引就该跟着变（否则用户按名字去找会找不到）。
    const label = OPTIONS.match(/label="([^"]*固定标签页[^"]*)"/);
    assert.ok(label, '设置页里找不到「固定标签页」那个开关的 label');
    assert.match(
      STEPS_CODE,
      /设置/,
      '引导必须说清「在设置里」—— 原文案从头到尾没提「设置」两个字'
    );
    assert.ok(
      STEPS_CODE.includes(label[1]),
      `引导必须引用设置页里开关的**真实名字**「${label[1]}」，否则用户按名字找不到`
    );
  });
});

describe('H-3 · 「自动同步」是默认关着的定时拉取', () => {
  it('（事实来源）定时拉取默认关闭', () => {
    assert.match(
      STORAGE,
      /syncEnabled:\s*false/,
      '事实来源变了：本守卫钉的是「默认关闭」这个事实'
    );
  });

  it('引导里没有把「自动同步」当成卡片标题（标题是最先被眼睛捕获的）', () => {
    assert.doesNotMatch(
      STEPS_CODE,
      /onboarding-feature-title">自动同步</,
      '「自动同步」正是设置页那个**默认关着**的开关的名字，不能当标题用'
    );
    assert.match(
      STEPS_CODE,
      /定时拉取默认关闭/,
      '引导必须披露定时拉取的默认状态'
    );
  });

  it('卡片描述把「上传（自动、真的）」与「定时拉取（默认关）」分开说', () => {
    assert.match(
      STEPS_CODE,
      /都会自动上传到云端/,
      '上传确实每次保存都发生 —— 这半句为真，不能为了加免责声明把它删掉'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-4 · 「拉回」= 合并，不覆盖
// ══════════════════════════════════════════════════════════════════════════

describe('H-4 · 拉回云端是**合并**，不是覆盖', () => {
  it('（事实来源）空态那侧的话已经说了「并合并，不会清掉本地内容」', () => {
    assert.match(
      EMPTY_STATE_ACTION_HINT.download,
      /合并/,
      '事实来源变了：空态的下载提示必须说明是合并模式'
    );
  });

  it('引导直接复用空态那句话（同一个语义不许两处实现）', () => {
    assert.ok(
      stepsUsesConstant('EMPTY_STATE_ACTION_HINT.download'),
      '引导必须复用 EMPTY_STATE_ACTION_HINT.download —— ' +
        '同一个动作两处各写一句中文，迟早会漂'
    );
    assert.doesNotMatch(
      STEPS_CODE,
      /新设备登录后会自动拉回云端的会话/,
      '「自动拉回」读起来像持续拉取，而且少了「并合并，不会清掉本地内容」那半句'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-5 · 恢复有两个入口
// ══════════════════════════════════════════════════════════════════════════

describe('H-5 · 「在当前窗口打开整个会话」是真实存在的第二个入口', () => {
  /** TabGroup 里那个「当前窗口」按钮的 aria-label 模板。 */
  function currentWindowAriaLabelPrefix(): string {
    const match = TAB_GROUP.match(/aria-label=\{`([^`]*当前窗口[^`]*)`\}/);
    assert.ok(match, 'TabGroup 里找不到「在当前窗口打开」那个按钮');
    return match[1];
  }

  it('（事实来源）TabGroup 里确实有这个按钮', () => {
    const prefix = currentWindowAriaLabelPrefix();
    assert.ok(prefix, '找不到 aria-label');
    assert.match(prefix, /在当前窗口打开整个会话/, '事实来源变了：按钮文案变了');
  });

  it('引导提到了这个入口（且用的是它的真实文案）', () => {
    const prefix = currentWindowAriaLabelPrefix();
    const phrase = prefix.replace(/，共.*$/, '').replace(/\$\{[^}]*\}/g, '');
    assert.ok(
      STEPS_CODE.includes(phrase),
      `引导必须提到真实存在的入口「${phrase}」—— 用户按引导找不到它`
    );
  });

  it('默认仍然是新窗口（主按钮是 accent 实底的那个）', () => {
    // 默认是哪一个 ⇒ 由**视觉层级**决定：主按钮（theme-cta）= 新窗口。
    assert.match(
      TAB_GROUP_CODE,
      /theme-cta[^"]*"[\s\S]{0,200}?aria-label=\{`在新窗口恢复整个会话/,
      '新窗口恢复必须是主按钮（accent 实底）⇒ 默认就是它'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-7 · 教了能搜 URL，输入框也得说
// ══════════════════════════════════════════════════════════════════════════

describe('H-7 · 搜索框的 placeholder / aria-label 必须提「URL」', () => {
  it('（事实来源）搜索真的匹配 URL', () => {
    const search = read('src/utils/search.ts');
    assert.match(search, /searchUrls\s*[:=]\s*true/, '搜索默认必须匹配 URL');
    assert.match(search, /normalizedUrl/, 'URL 匹配必须真的存在');
  });

  it('引导教了 URL，搜索框也得说 URL', () => {
    assert.match(STEPS_CODE, /URL/, '引导教了能搜 URL');
    const aria = HEADER.match(/aria-label="([^"]*搜索[^"]*)"/);
    assert.ok(aria, 'Header 里找不到搜索框的 aria-label');
    assert.match(
      aria[1],
      /URL/,
      `搜索框的 aria-label 必须提 URL（现在是「${aria[1]}」）—— 用户没有任何界面线索知道网址也能搜`
    );
    const placeholder = HEADER.match(/placeholder="([^"]*搜索[^"]*)"/);
    assert.ok(placeholder, 'Header 里找不到搜索框的 placeholder');
    assert.match(
      placeholder[1],
      /URL/,
      `placeholder 必须提 URL（现在是「${placeholder[1]}」）—— 它是输入前唯一的可见说明`
    );
  });

  it('引导的聚光灯选择器与 Header 的 aria-label 同源（改一边必须改另一边）', () => {
    const aria = HEADER.match(/aria-label="([^"]*搜索[^"]*)"/);
    assert.ok(aria);
    // 引导里**每一个**提到搜索的选择器都必须逐字等于 Header 里的那个 ——
    // 只检查「至少有一处对」是不够的：漏改一处（步骤 3 改了、兜底链没改，
    // 或反过来）就会让那一步的聚光灯静默失去高亮（42 轮 P0-1 的同款缺陷，
    // 界面上零提示）。
    const searchSelectors = [
      ...GUIDE.matchAll(/\[aria-label="([^"]*搜索[^"]*)"\]/g),
    ].map(m => m[1]);
    assert.ok(
      searchSelectors.length >= 2,
      `引导里至少有两处指向搜索框（步骤 3 一个 + 恢复步骤的兜底链一个），实际 ${searchSelectors.length} 处`
    );
    for (const value of searchSelectors) {
      assert.equal(
        value,
        aria[1],
        `引导里的搜索选择器「${value}」与 Header 里的「${aria[1]}」对不上 —— ` +
          '聚光灯会静默失去高亮'
      );
    }
  });

  it('聚光灯链里没有会被顶层逗号劈开的候选', () => {
    // Spotlight 的 splitSelectorChain 按**顶层逗号**拆候选链。
    // 候选里有逗号（中文顿号不算）就会被劈成两个不存在的选择器。
    const targets = [...GUIDE.matchAll(/spotlightTarget:\s*'([^']+)'/g)].map(m => m[1]);
    for (const target of targets) {
      const parts = target.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        assert.ok(
          trimmed.startsWith('[') || trimmed.startsWith('button[') || trimmed.startsWith(':'),
          `候选「${trimmed}」像是被顶层逗号劈开的 —— splitSelectorChain 会把它当独立候选`
        );
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-8 · 锁定是唯一让会话恢复后不被消费的开关
// ══════════════════════════════════════════════════════════════════════════

describe('H-8 · 锁定保住的是「恢复后还在」', () => {
  it('（事实来源）锁定后的反馈里说了「恢复后仍会留在列表里」', () => {
    const copy = read('src/components/tabs/lockFeedbackCopy.ts');
    assert.match(copy, /恢复后它仍会留在列表里/, '事实来源变了：锁定后的提示文案变了');
  });

  it('锁定按钮的 tooltip 也要说这一半（点之前就该知道）', () => {
    // 取**去掉注释后**的 LOCK_TOOLTIP.unlocked —— 注释里也会出现这些字。
    const tooltip = TAB_GROUP_CODE.match(/unlocked:\s*\n?\s*'([^']*)'/);
    assert.ok(tooltip, '找不到 LOCK_TOOLTIP.unlocked');
    assert.match(
      tooltip[1],
      /恢复后/,
      'tooltip 必须说清锁定改变的是「恢复后还在不在」'
    );
    assert.match(tooltip[1], /列表/, 'tooltip 必须说清锁定后会留在列表里');
  });

  it('引导教了锁定这件事', () => {
    assert.match(STEPS_CODE, /锁定/, '引导必须提到锁定');
    assert.match(
      STEPS_CODE,
      /恢复后仍留在列表里/,
      '引导必须说清锁定最要紧的后果（恢复后仍在列表里、可反复使用）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-9 · 顶栏的「上传 / 下载」是常驻的同步入口
// ══════════════════════════════════════════════════════════════════════════

describe('H-9 · 同步的两个入口都要被教', () => {
  /** SyncButton 里那两颗按钮的 aria-label。 */
  function syncButtonAriaLabels(): string[] {
    return [...SYNC_BUTTON.matchAll(/aria-label="([^"]*(?:上传|下载)[^"]*)"/g)].map(m => m[1]);
  }

  it('（事实来源）顶栏确实有两颗常驻的同步按钮', () => {
    const labels = syncButtonAriaLabels();
    assert.ok(
      labels.some(l => l.includes('上传')),
      'SyncButton 里找不到「上传」按钮的 aria-label'
    );
    assert.ok(
      labels.some(l => l.includes('下载')),
      'SyncButton 里找不到「下载」按钮的 aria-label'
    );
  });

  it('引导提到了手动上传与下载（不是只教「⋯ 菜单 → 去登录」）', () => {
    assert.match(STEPS_CODE, /上传/, '引导必须提到顶栏的「上传」');
    assert.match(STEPS_CODE, /下载/, '引导必须提到顶栏的「下载」');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-10 · 同一个实体不许三种叫法；徽章不许是裸数字
// ══════════════════════════════════════════════════════════════════════════

describe('H-10 · 「标签页」是唯一叫法；卡头徽章必须有视觉单位', () => {
  it('顶栏计数、卡头徽章、删除确认三处都用「标签页」', () => {
    // 顶栏：「N 个标签页」（与「N 会话」并列）
    const counter = stripComments(TAB_COUNTER);
    assert.match(
      counter,
      /<strong>\{tabCount\}<\/strong>\s*个标签页/,
      '顶栏的标签计数必须写成「N 个标签页」'
    );
    assert.doesNotMatch(
      counter,
      /<strong>\{tabCount\}<\/strong>\s*标签(?!页)/,
      '顶栏的「N 标签」要统一成「N 个标签页」'
    );
    assert.doesNotMatch(
      stripComments(LOCKED_DELETE),
      /个标签记录/,
      '删除确认的「N 个标签记录」要统一成「N 个标签页」'
    );
    assert.doesNotMatch(
      TAB_GROUP_CODE,
      /条标签记录/,
      'TabGroup 的删除确认也要统一成「标签页」'
    );
  });

  it('卡头徽章不是裸数字（用户分不清它是标签数还是会话数）', () => {
    const badge = TAB_GROUP_CODE.match(
      /<span\s+className="tab-group-count flex-shrink-0"[\s\S]{0,600}?<\/span>/
    );
    assert.ok(badge, '找不到会话卡的数量徽章');
    // 去掉 aria-label 之后剩下的才是**看得见**的内容。
    const visible = badge[0].replace(/aria-label=\{[^}]*\}/, '');
    assert.doesNotMatch(
      visible,
      /^\s*\{group\.tabs\.length\}\s*$/,
      '徽章不能只渲染一个裸数字（顶栏同时有两个数字 ⇒ 用户会读错）'
    );
    assert.match(
      visible,
      /\{group\.tabs\.length\}/,
      '徽章显示的必须仍然是标签数本身'
    );
    assert.match(
      visible,
      /标签页/,
      '徽章必须带**视觉单位**（与顶栏 / 保存提示同一口径）'
    );
  });

  it('徽章的 aria-label 与可见单位说的是同一件事', () => {
    const badge = TAB_GROUP_CODE.match(
      /<span\s+className="tab-group-count flex-shrink-0"[\s\S]{0,600}?<\/span>/
    );
    assert.ok(badge);
    assert.match(badge[0], /aria-label=\{`包含 \$\{group\.tabs\.length\} 个标签页`\}/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-11 · 不用英文 Pinned
// ══════════════════════════════════════════════════════════════════════════

describe('H-11 · 引导里不出现英文 Pinned', () => {
  it('可见文案里没有 Pinned / pinned', () => {
    assert.doesNotMatch(
      STEPS_CODE,
      /Pinned|pinned/,
      '产品其它地方一律叫「固定标签页」—— 引导是新用户的第一眼，不能叫别的'
    );
  });

  it('（事实来源）设置页确实叫「固定标签页」', () => {
    assert.match(OPTIONS, /label="[^"]*固定标签页[^"]*"/, '设置页的开关名变了');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-12 · 「这些标签随之关闭」的例外
// ══════════════════════════════════════════════════════════════════════════

describe('H-12 · 说清哪些标签**不会**被关闭', () => {
  it('（事实来源）固定标签页默认既不保存也不关闭', () => {
    // 关闭用的是同一份过滤结果（TabManager.saveAllTabs 的 filterValidTabs
    // 与 createTabGroupFromChromeTabs 用的是同一个 includePinned）。
    assert.match(
      TAB_GROUP === '' ? '' : read('src/background/TabManager.ts'),
      /includePinned:\s*collectPinnedTabs/,
      '事实来源变了：保存/关闭的过滤参数不是同一个了'
    );
    assert.match(STORAGE, /collectPinnedTabs:\s*false/, '固定标签页默认不收集');
  });

  it('（事实来源）内部页面与危险 schema 被丢弃（既不保存也不关闭）', () => {
    const filters = read('src/domain/tabGroup/filters.ts');
    assert.match(filters, /INTERNAL_URL_PREFIXES/, '内部页面的协议表没了');
    assert.match(filters, /chrome:\/\//, '内部页面表里必须含 chrome://');
  });

  it('引导点名了「固定标签页会留在原处」这条例外', () => {
    assert.match(
      STEPS_CODE,
      /固定标签页除外/,
      '引导必须点名固定标签页这条例外（pin 一个工作台是日常，用户一定会遇到）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-13 · 会话排序
// ══════════════════════════════════════════════════════════════════════════

describe('H-13 · 引导要教会话排序', () => {
  it('（事实来源）排序选项是这四个', () => {
    assert.ok(SESSION_SORT_OPTIONS.length >= 4, '排序选项数量变了，本守卫要重新评估');
  });

  it('引导有一张「排序」卡片，并把四个选项的**真实标签**说出来', () => {
    assert.match(STEPS_CODE, /onboarding-feature-title">排序</, '引导缺少「排序」这张卡');
    for (const option of SESSION_SORT_OPTIONS) {
      assert.ok(
        STEPS_CODE.includes(option.label),
        `引导必须提到排序选项「${option.label}」—— 用户在筛选区看到的是这个标签`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// H-14 · OneTab 文本格式不带会话名
// ══════════════════════════════════════════════════════════════════════════

describe('H-14 · OneTab 文本格式本身不带会话名', () => {
  it('（事实来源）OneTab 导入按域名命名，取不到才回落序号', () => {
    assert.match(
      ONETAB_PARSER,
      /deriveDominantHost/,
      '事实来源变了：OneTab 导入不再按域名命名'
    );
    assert.match(
      ONETAB_PARSER,
      /导入的会话/,
      '事实来源变了：取不到域名时的回落文案变了'
    );
  });

  it('（事实来源）JSON 备份导入保留文件里的会话名', () => {
    const normalize = read('src/core/normalizeTabsData.ts');
    assert.match(
      normalize,
      /name:\s*typeof g\.name === 'string'[^;]*g\.name/,
      '事实来源变了：JSON 导入不再保留文件里的会话名'
    );
  });

  it('引导说清了两档导入的**不同**命名规则', () => {
    assert.match(STEPS_CODE, /JSON/, '引导要提到 JSON 备份');
    assert.match(
      STEPS_CODE,
      /OneTab[^<]*不带会话名|不带会话名/,
      '引导必须说清 OneTab 文本格式本身不带会话名（导回来会丢名字）'
    );
    assert.match(
      STEPS_CODE,
      /按域名命名/,
      '引导必须说清 OneTab 导入按域名命名'
    );
    assert.doesNotMatch(
      STEPS_CODE,
      /按内容命名/,
      '「按内容命名」是假话 —— OneTab 按域名命名，JSON 保留原名'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 死指针 · 注释里引用的守卫文件必须真的存在
// ══════════════════════════════════════════════════════════════════════════

describe('注释里引用的测试文件必须真的存在', () => {
  /**
   * 已知待办：这三处指向的守卫文件**从来不存在**，照着注释去找守卫的人会扑空。
   *
   * 但这三个文件（`src/core/remoteAdjudication.ts` / `src/utils/secureStorage.ts`
   * / `src/store/slices/tabSlice.ts`）**不在本轮分工内** ⇒ 本轮无权改它们
   * （并行 agent 正在改那些文件，碰了会互相覆盖）。
   * ⇒ 记在这里当**待办清单**：等负责那几个文件的 agent 顺手把注释指到
   *    真实存在的守卫（或者把守卫补出来），就把对应条目从这里删掉。
   *
   * 守卫的作用是**不让清单变长**：新增一个死指针 ⇒ 下面那条用例变红。
   */
  const KNOWN_PENDING: ReadonlyArray<string> = [
    'src/core/remoteAdjudication.ts → tests/backendParityAdjudication.test.ts',
    'src/utils/secureStorage.ts → tests/guards/storageKvConvergence.test.ts',
    'src/store/slices/tabSlice.ts → tests/importIdempotency.test.ts',
  ];

  it('HeaderDropdown 的注释不再指向那个不存在的文件', () => {
    assert.doesNotMatch(
      DROPDOWN,
      /tests\/menuLoginEntry\.test\.ts/,
      '那个文件从来不存在 —— 照着注释去找守卫的人会扑空'
    );
    // 真的那个守卫必须在场，且必须还守着 needsLogin 的行为面。
    assert.ok(
      read('tests/syncStatusHonesty.test.ts').includes('needsLogin'),
      '真正的守卫（syncStatusHonesty）必须还守着 needsLogin 的四组合行为'
    );
  });

  it('本仓 src/ 下不得**新增**指向不存在测试文件的注释', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/tests\/([\w./-]+\.test\.ts)/g)) {
          const target = resolve(ROOT, 'tests', m[1]);
          if (!statSync(target, { throwIfNoEntry: false })) {
            offenders.push(`${full.replace(ROOT + '/', '')} → tests/${m[1]}`);
          }
        }
      }
    };
    walk(resolve(ROOT, 'src'));
    assert.deepEqual(
      [...offenders].sort(),
      [...KNOWN_PENDING].sort(),
      `注释里引用了不存在的测试文件：\n${offenders.join('\n')}\n` +
        '—— 照着注释去找守卫的人会扑空。\n' +
        `（已知的 ${KNOWN_PENDING.length} 条待办在文件头部的常量里；` +
        '修好一处就把对应条目从那个常量里删掉。）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 引导的其它诚实性底线
// ══════════════════════════════════════════════════════════════════════════

describe('引导的其它底线', () => {
  it('空态那句「支持搜索…或 URL」与引导教的一致', () => {
    assert.match(
      SEARCH_HINT,
      /URL/,
      '事实来源变了：空态搜索提示不再提 URL'
    );
    assert.match(STEPS_CODE, /URL/, '引导必须教 URL 搜索');
  });

  it('引导没有把云同步称作「备份」（云端是镜像，删了找不回）', () => {
    assert.doesNotMatch(STEPS_CODE, /备份到云端/, '「备份」让用户以为删了能找回');
  });
});
