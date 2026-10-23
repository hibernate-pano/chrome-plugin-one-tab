/**
 * 变异自证：引导标题焦点环这条守卫必须真的看得见破口。
 *
 * 五个方向：
 *   ① 把标题改成**可 Tab 到**（去掉 `tabIndex={-1}`）⇒ 必须红
 *      （那时焦点环是**该有的**，守卫必须拦住「继续把它关着」这件事）；
 *   ② 把「去掉环」那条 CSS 规则删掉 ⇒ 必须红
 *      （回到缺陷本体：全局 `:focus-visible` 会把环画在**第一屏**的标题上）；
 *   ③ 把选择器**削弱**成 `.onboarding-title:focus-visible` ⇒ 必须红
 *      —— 这一条是**真机撞过的那个坑**：文件里明明写着 outline: none，
 *      可 6 套主题的 `html[data-theme="xxx"] :focus-visible`（0,2,1）
 *      特异度更高 ⇒ 画面上那圈蓝框**照样在**。
 *      没有这条变异，守卫就只是在钉字面量。
 *   ④ 把遮罩层那条规则的选择器削弱 ⇒ 必须红（同上，遮罩层那圈环是**沿着窗口边缘**画的）。
 *   ⑤ 把「把焦点移到标题」那行删掉 ⇒ 必须红
 *      （读屏播报没了 —— 那是这条实现存在的**另一半**理由，不能被顺手删）；
 *   ⑥ 等价的正确改写（只写 `:focus`，它包含 `:focus-visible`）⇒ 必须**仍然绿**
 *      （证明它判的是**行为**（标题在不在 Tab 序列里、环压不压得住），
 *        不是**写法**）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/onboardingTitleFocusRing.test.ts';

const CSS_PATH = 'src/styles/onboarding.css';
const STEPS_PATH = 'src/components/onboarding/OnboardingSteps.tsx';
const GUIDE_PATH = 'src/components/onboarding/OnboardingGuide.tsx';

/** 现在那条「去掉环」的规则（原文）。 */
const RING_RULE = `.onboarding-overlay .onboarding-title:focus,
.onboarding-overlay .onboarding-title:focus-visible {
    outline: none;
}`;

/** 遮罩层那条「去掉环」的规则（原文）。 */
const OVERLAY_RING_RULE = `html body .onboarding-overlay:focus,
html body .onboarding-overlay:focus-visible {
    outline: none;
}`;

describe('变异自证：引导标题焦点环这条守卫必须看得见破口', () => {
  it('变异一：标题改成可 Tab 到（焦点环是**该有的**）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '标题去掉 tabIndex={-1}，变成可 Tab 到',
        testFile: GUARD,
        targets: [
          {
            path: STEPS_PATH,
            mutate: source =>
              source
                .split('<h2 tabIndex={-1} className="onboarding-title">')
                .join('<h2 className="onboarding-title">'),
          },
        ],
        expectRed: true,
        expectedFailure: '不能继续把它关掉',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把引导标题改成可 Tab 到（却仍然把焦点环关着）');
  });

  it('变异二：把「去掉环」那条 CSS 规则删掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '删掉 .onboarding-title 的 outline: none 规则',
        testFile: GUARD,
        targets: [
          {
            path: CSS_PATH,
            mutate: source => source.replace(RING_RULE, ''),
          },
        ],
        expectRed: true,
        expectedFailure: 'onboarding.css 里找不到',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '删掉「去掉焦点环」那条 CSS 规则');
  });

  it('变异三：把选择器削弱到压不过主题那条 ⇒ 守卫必须变红（真机撞过的那个坑）', () => {
    const [outcome] = runMutationCases([
      {
        name: '选择器削弱成 .onboarding-title:focus-visible（特异度 0,2,0）',
        testFile: GUARD,
        targets: [
          {
            path: CSS_PATH,
            mutate: source =>
              source.replace(
                RING_RULE,
                `.onboarding-title:focus,
.onboarding-title:focus-visible {
    outline: none;
}`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '压不住',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把焦点环规则的选择器削弱成压不过主题那条 `html[data-theme=…] :focus-visible`'
    );
  });

  it('变异四：把遮罩层那条规则的选择器削弱 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '遮罩层规则削弱成 .onboarding-overlay:focus（特异度 0,2,0）',
        testFile: GUARD,
        targets: [
          {
            path: CSS_PATH,
            mutate: source =>
              source.replace(
                OVERLAY_RING_RULE,
                `.onboarding-overlay:focus,
.onboarding-overlay:focus-visible {
    outline: none;
}`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '压不住',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把遮罩层的焦点环规则削弱成压不过主题那条（少了 html body 那两级）'
    );
  });

  it('变异五：把「把焦点移到标题」那行删掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '删掉 title?.focus()',
        testFile: GUARD,
        targets: [
          {
            path: GUIDE_PATH,
            mutate: source => source.replace(/\n\s*title\?\.focus\(\);/, ''),
          },
        ],
        expectRed: true,
        expectedFailure: '读屏播报新步骤',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '删掉「把焦点移到标题」（读屏播报没了）');
  });

  it('变异六：等价的正确改写（只写 :focus）⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '换成只写 :focus（:focus ⊇ :focus-visible，行为等价）',
        testFile: GUARD,
        targets: [
          {
            path: CSS_PATH,
            mutate: source =>
              source.replace(
                RING_RULE,
                `.onboarding-overlay .onboarding-title:focus {
    outline: none;
}`
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把焦点环规则换成等价写法（只写 :focus，不写 :focus-visible）'
    );
  });
});
