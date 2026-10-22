/**
 * 变异自证：「引导必须说清锁定挡不住什么 / 删最后一条会先确认」这条守卫
 * 必须真的看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 常量里删掉「仍可删除整个会话」⇒ 锁定边界那条真的会红
 *   M2 删除卡片不再引用那个常量 ⇒ 「两张卡同一出处」那条真的会红
 *   M3 把「会让整个会话消失就���确认」挪到**拖拽**那一句上
 *      ⇒ 「拖拽不确认」那条真的会红（两条路径行为相反，不能混）
 *   M4 等价改写（破折号换成逗号，语义不变）⇒ 守卫**仍然绿**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/onboardingDeleteBoundaryHonesty.test.ts';

describe('变异自证：WC-6 / WC-9 引导守卫必须看得见破口', () => {
  it('变异一：常量里删掉「仍可删除整个会话」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '锁定边界那句话又只说「已锁定」不说「仍可删除」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/onboarding/onboardingCopy.ts',
            mutate: source =>
              source.replace(
                '仍可删除整个会话，但会先明确提示「该会话已锁定」，而且这一步一定要确认；',
                '删除会话时会先明确提示「该会话已锁定」，而且这一步一定要确认；',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须说清锁定**不阻止**删除整个会话',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「仍可删除整个会话」从常量里删掉');
  });

  it('变异二：删除卡片不再引用那个常量 ⇒ 守卫必须变红（两张卡必须同一出处）', () => {
    const [outcome] = runMutationCases([
      {
        name: '删除卡片里没有那句锁定边界了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/onboarding/OnboardingSteps.tsx',
            mutate: source =>
              source.replace('；{LOCK_DELETE_BOUNDARY}；单条删除会立即生效', '；单条删除会立即生效'),
          },
        ],
        expectRed: true,
        expectedFailure: '引导里应当有两处引用 LOCK_DELETE_BOUNDARY',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让删除卡片不再引用那个共享常量');
  });

  it('变异三：把「会让整个会话消失就���确认」挪到拖拽那一句上 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '拖拽那句也承诺了确认',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/onboarding/OnboardingSteps.tsx',
            mutate: source =>
              source
                .replace(
                  '单条删除会立即生效——但如果这一删会让整个会话消失，就会先确认；',
                  '单条删除会立即生效；',
                )
                .replace(
                  '把最后一条标签拖到别的会话，也会立即生效（那个被搬空的会话随之消失）',
                  '把最后一条标签拖到别的会话，也会立即生效——但如果这一删会让整个会话消失，就会先确认',
                ),
          },
        ],
        expectRed: true,
        expectedFailure: '拖拽路径**不弹确认**（1.24.3 定案）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把单条删除的确认承诺挪到拖拽那一句上');
  });

  it('等价改写：破折号换成逗号（语义不变）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：破折号改成逗号',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/onboarding/OnboardingSteps.tsx',
            mutate: source =>
              source.replace(
                '单条删除会立即生效——但如果这一删会让整个会话消失，就会先确认；',
                '单条删除会立即生效，但如果这一删会让整个会话消失，就会先确认；',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把删除卡片里那个破折号换成逗号（语义不变）');
  });
});
