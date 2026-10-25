// 引导聚光灯必须有**兜底链**（2026-10-22 审计 P0-1 的回归钉）。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// 引导第 4 步「恢复整个会话」的聚光灯指向
// `button[aria-label^="在新窗口恢复整个会话"], button[aria-label^="在新窗口恢复所有匹配标签"]`
// —— 这两个按钮只存在于**会话卡片**上，而全新安装时**一个会话都没有**
// ⇒ 卡片不存在 ⇒ 按钮不存在 ⇒ 选择器命中 0 个元素
// ⇒ 聚光灯整个消失，界面上**没有任何提示**（Spotlight 只在 console 里 warn 一句）。
//
// 真机复现（走完 6 步逐步记录聚光灯）：
//   STEP0 欢迎使用 TapStack      ring=false（首步本就不高亮）
//   STEP1 先保存一个会话          ring=true
//   STEP2 需要时快速找回          ring=true
//   STEP3 恢复时继续，而不是重来  ring=false   ← 无高亮
//   STEP4 换台设备也能找回        ring=true
//   STEP5 核心闭环已经齐了        ring=false
// 同时 `button[aria-label^="在新窗口恢复整个会话"]` 在 DOM 里命中数 = 0。
//
// 这个缺陷**只在新用户身上发生**（有会话的老用户反而正常），而新用户恰恰是
// 第一次见这个引导的人。第 4 步教「恢复」，新用户此刻还没有可恢复的东西。
//
// ── 为什么已有守卫守不到 ────────────────────────────────────────────────
//
// `tests/a11yLists.test.ts` 的交叉校验是**源码级**的：它比对 OnboardingGuide.tsx
// 里的选择器字符串与 Header/TabGroup/SearchResultList 源码里出现过的 aria-label
// **字面量**。只要 TabGroup.tsx 里那行字面量还在，选择器就算「命中」——
// 它从不检查**运行时 DOM**，所以「元素此刻不存在」这一类缺陷零检测力。
//
// ── 这份文件钉什么 ──────────────────────────────────────────────────────
//
// ① 候选链的拆分规则（纯函数）：顶层逗号分隔、引号/括号内的逗号不分隔。
// ② 聚光灯必须**按链的顺序**逐个试（不是一次性 querySelectorAll 拿全部）——
//    CSS 的 `querySelectorAll('A, B')` 返回**文档顺序**，「A 优先、B 兜底」
//    在 CSS 层面根本不存在。
// ③ 「恢复整个会话」这一步的链必须以一个**空态也存在**的元素兜底
//    （搜索框在空态下一直渲染）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitSelectorChain } from '@/components/onboarding/spotlightSelectorChain';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const GUIDE = read('src/components/onboarding/OnboardingGuide.tsx');
const SPOTLIGHT = read('src/components/onboarding/Spotlight.tsx');
const HEADER = read('src/components/layout/Header.tsx');

/**
 * Header 里那个搜索框的真实 aria-label —— **现场读**，不写死中文。
 *
 * 为什么要读而不是钉字面量：搜索框的文案改过一次（2026-10-23 审计 H-7 补上
 * 「URL」）。守卫若钉住旧文案，改对实现反而让它变红 ⇒ 后来的人会把文案
 * 改回去。这是本仓库反复踩过的坑（「守卫钉死字面量的陷阱」）。
 *
 * 判据钉的是**关系**：引导的兜底候选必须指向 Header 里真实存在的那个
 * 搜索框。改文案时两边一起改即可；而「引导指向了一个不存在的元素」
 * 这类真缺陷仍然会被抓住。
 */
function readSearchBoxAriaLabel(): string {
  const match = HEADER.match(/aria-label="([^"]*搜索[^"]*)"/);
  assert.ok(match, 'Header 里找不到搜索框的 aria-label（它应当含「搜索」）');
  return match[1];
}

const searchBoxAriaLabel = readSearchBoxAriaLabel();

/**
 * 取引导里配置的聚光灯目标。
 *
 * 单引号与模板串两种写法都要认 —— 只认一种的话，
 * 「另一种写法的目标」会被整条漏掉，于是守卫反而看不见它。
 * （同 tests/a11yLists.test.ts 的 spotlightTargetsIn。）
 */
function spotlightTargets(): string[] {
  const targets: string[] = [];
  for (const m of GUIDE.matchAll(/spotlightTarget:\s*'([^']+)'/g)) {
    targets.push(m[1]);
  }
  for (const m of GUIDE.matchAll(/spotlightTarget:\s*`([^`]+)`/g)) {
    targets.push(m[1].replace(/\$\{[^}]*\}/g, 'N'));
  }
  return targets;
}

describe('候选链拆分（纯函数）', () => {
  it('顶层逗号分隔', () => {
    assert.deepEqual(splitSelectorChain('a, b, c'), ['a', 'b', 'c']);
  });

  it('引号里的逗号不分割', () => {
    assert.deepEqual(
      splitSelectorChain('[aria-label="a, b"], .x'),
      ['[aria-label="a, b"]', '.x']
    );
  });

  it('方括号与圆括号里的逗号不分割', () => {
    assert.deepEqual(
      splitSelectorChain(':is(.a, .b), .c'),
      [':is(.a, .b)', '.c']
    );
  });

  it('去掉空白项', () => {
    assert.deepEqual(splitSelectorChain(' a , , b '), ['a', 'b']);
  });

  it('单个选择器原样返回', () => {
    assert.deepEqual(splitSelectorChain('[aria-label="菜单"]'), ['[aria-label="菜单"]']);
  });
});

describe('聚光灯必须按链的顺序逐个试', () => {
  it('Spotlight 使用了链拆分（而不是一次性 querySelectorAll 整个串）', () => {
    assert.match(
      SPOTLIGHT,
      /splitSelectorChain/,
      'Spotlight 必须用有序候选链 —— CSS 的 querySelectorAll 返回文档顺序，兜底链会被打乱'
    );
    assert.match(
      SPOTLIGHT,
      /for\s*\(const selector of splitSelectorChain\(/,
      'firstVisibleMatch 必须**逐个候选**地试，而不是一次性把整串丢给 querySelectorAll'
    );
  });
});

describe('引导每一步的聚光灯都要有兜底', () => {
  const targets = spotlightTargets();

  it('引导仍然配置着 4 个聚光灯目标', () => {
    assert.equal(targets.length, 4, '聚光灯步骤数变了，本文件的判据需要重新评估');
  });

  it('「恢复整个会话」这一步必须以空态也存在的元素兜底', () => {
    const restoreStep = targets.find(t => t.includes('在新窗口恢复整个会话'));
    assert.ok(restoreStep, '找不到「恢复整个会话」那一步的聚光灯目标');

    const chain = splitSelectorChain(restoreStep);
    assert.ok(
      chain.length >= 2,
      '恢复按钮只在会话卡片上，全新安装时不存在 ⇒ 这一步必须有兜底候选'
    );

    // 兜底必须指向搜索框：它在空态下一直渲染（顶栏是常驻的）。
    //
    // ⚠️ 这里**不钉中文**（2026-10-23 审计 H-7 之后的教训）：
    // 搜索框的 aria-label 改过一次（补上「URL」），而本守卫原先钉的是
    // 「搜索会话或标签页」这个字面量 ⇒ 改文案就会让守卫变红，
    // 于是后来的人会把文案改回去 —— 「改对实现反而让测试变红」的陷阱。
    //
    // ⇒ 判据改成**现场读**：Header 里那个搜索框的 aria-label 是什么，
    //    引导的兜底候选就必须指向它。改文案时两边一起改即可，
    //    而「引导与 Header 对不上」这种真缺陷仍然会被抓住。
    const fallback = chain[chain.length - 1];
    assert.match(
      fallback,
      /搜索/,
      `兜底候选必须指向空态下也存在的东西（搜索框），实际是：${fallback}`
    );
    assert.ok(
      fallback.includes(searchBoxAriaLabel),
      `兜底候选必须指向 Header 里那个搜索框（aria-label="${searchBoxAriaLabel}"），实际是：${fallback}`
    );
  });

  it('兜底候选排在恢复按钮**之后**（顺序即优先级）', () => {
    const restoreStep = targets.find(t => t.includes('在新窗口恢复整个会话'))!;
    const chain = splitSelectorChain(restoreStep);
    const restoreIndex = chain.findIndex(c => c.includes('在新窗口恢复'));
    const fallbackIndex = chain.findIndex(c => c.includes(searchBoxAriaLabel));
    assert.ok(
      restoreIndex >= 0 && fallbackIndex > restoreIndex,
      '有会话时必须优先高亮恢复按钮；搜索框只是兜底'
    );
  });

  it('「恢复整个会话」这一步优先高亮**主操作**（在当前窗口打开整个会话）', () => {
    // ── 2026-10-25：主操作换人 ⇒ 聚光灯的第一候选也跟着换 ────────────────
    // 产品负责人 2026-10-25：「我主要使用『从当前窗口打开所有标签页』」
    // ⇒ 第 4 步教的就是「默认在当前窗口打开」⇒ 聚光灯第一个候选必须是那颗，
    // 否则引导高亮的是**次要**那颗按钮 —— 说的和指的是两件事。
    const restoreStep = targets.find(t => t.includes('在当前窗口打开整个会话'));
    assert.ok(restoreStep, '恢复那一步的聚光灯链里没有「在当前窗口打开整个会话」');
    const chain = splitSelectorChain(restoreStep);
    assert.ok(
      chain[0]?.includes('在当前窗口打开整个会话'),
      `聚光灯第一候选必须是主操作那颗，实际是：${chain[0]}`,
    );
  });

  it('每一步的候选链都非空', () => {
    for (const target of targets) {
      assert.ok(
        splitSelectorChain(target).length > 0,
        `聚光灯目标拆开后不能是空链：${target}`
      );
    }
  });
});
