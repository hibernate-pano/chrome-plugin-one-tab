/**
 * 变异自证：提示条宽度这条守卫必须真的看得见破口。
 *
 * 三条变异分别打**样式类**、**判据层**、**等价改写**：
 * · 变异一：去掉 `w-max` ⇒ 提示条又缩回触发元素那个 36px 的宽度 ⇒ 红；
 * · 变异二：判据层改成「永远不夹」⇒ 靠左的按钮会把提示条顶出视口 ⇒ 红；
 * · 变异三：把同一段判据换个写法 ⇒ 行为一模一样 ⇒ 必须**仍然绿**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/tooltipWidthHonesty.test.ts';
const TOOLTIP_FILE = 'src/components/common/Tooltip.tsx';
const PLACEMENT_FILE = 'src/components/common/tooltipPlacement.ts';

describe('变异自证：提示条宽度这条守卫必须看得见破口', () => {
  it('变异一：去掉 w-max ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '去掉 w-max',
        testFile: GUARD,
        targets: [
          {
            path: TOOLTIP_FILE,
            mutate: source => {
              if (!source.includes(' w-max ')) {
                throw new Error('变异前提没成立：找不到 w-max');
              }
              return source.replace(' w-max ', ' ');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须有 w-max',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '去掉 w-max');
  });

  it('变异二：判据层改成「永远不夹」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '夹回视口这一步被短路',
        testFile: GUARD,
        targets: [
          {
            path: PLACEMENT_FILE,
            mutate: source => {
              const before = source;
              const mutated = source
                .replace('if (left < margin) {', 'if (false) {')
                .replace('if (right > viewport - margin) {', 'if (false) {');
              if (mutated === before) {
                throw new Error('变异前提没成立：找不到夹回视口的两个分支');
              }
              return mutated;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须正好挪到左缘留白处',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '夹回视口这一步被短路');
  });

  it('等价改写：判据调用换个写法（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '把矩形抽成变量再传',
        testFile: GUARD,
        targets: [
          {
            path: TOOLTIP_FILE,
            mutate: source => {
              const before = `const clamp = resolveTooltipClamp({
      tooltip: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      viewportWidth: window.innerWidth,
    });`;
              if (!source.includes(before)) {
                throw new Error('变异前提没成立：找不到夹回视口的调用');
              }
              return source.replace(
                before,
                `const box = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
    const clamp = resolveTooltipClamp({ tooltip: box, viewportWidth: window.innerWidth });`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把矩形抽成变量再传（行为一模一样）');
  });
});
