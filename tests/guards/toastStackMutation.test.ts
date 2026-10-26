/**
 * 变异自证：「提示不许互相遮挡」这条守卫必须真的看得见破口。
 *
 * 四条变异分别打四个不同的破口：
 *
 * · 变异一 —— 高度**一律**按兜底值算（= 旧算法的形状）⇒ 必须变红。
 * · 变异二 —— 累加方向反了（最新那条跑到最上面）⇒ 必须变红。
 * · 变异三 —— 间距被抹掉（两条贴在一起）⇒ 必须变红。
 * · 变异四 —— 高度算成**等价的内联写法** ⇒ 必须**仍然绿**
 *   （守的是「按实测高度堆叠」这件事，不是逐字长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/toastStackOffsets.test.ts';
const STACK = 'src/components/common/toastStack.ts';

const HEIGHT_BLOCK = `    const height =
      typeof entry.height === 'number' && entry.height > 0
        ? entry.height
        : DEFAULT_TOAST_HEIGHT;
`;

describe('变异自证：「提示不许互相遮挡」这条守卫必须看得见破口', () => {
  it('变异一：高度一律按兜底值算（= 旧算法）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '高度不再用实测值，一律用 76 的兜底值',
        testFile: GUARD,
        targets: [
          {
            path: STACK,
            mutate: source => {
              if (!source.includes(HEIGHT_BLOCK)) {
                throw new Error('变异前提没成立：找不到算高度的那一块');
              }
              return source.replace(HEIGHT_BLOCK, '    const height = DEFAULT_TOAST_HEIGHT;\n');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '有一条提示被下面那条盖住了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '高度一律按兜底值算');
  });

  it('变异二：累加方向反了（最新那条跑到最上面）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '从最旧的那条开始累加（最新的那条被顶到最上面）',
        testFile: GUARD,
        targets: [
          {
            path: STACK,
            mutate: source => {
              const original = `  for (let i = queue.length - 1; i >= 0; i -= 1) {`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到累加的那个循环');
              }
              return source.replace(original, `  for (let i = 0; i < queue.length; i += 1) {`);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须贴着底边',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '累加方向反了');
  });

  it('变异三：间距被抹掉（两条贴在一起）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '两条之间的间距被抹成 0',
        testFile: GUARD,
        targets: [
          {
            path: STACK,
            mutate: source => {
              const original = '  gap: number = TOAST_STACK_GAP';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 gap 的默认值');
              }
              return source.replace(original, '  gap: number = 0');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '上面那条要高出「高度 + 间距」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '间距被抹掉');
  });

  it('变异四：高度算成等价的内联写法 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '高度先归一再判断（等价）',
        testFile: GUARD,
        targets: [
          {
            path: STACK,
            mutate: source => {
              if (!source.includes(HEIGHT_BLOCK)) {
                throw new Error('变异前提没成立：找不到算高度的那一块');
              }
              return source.replace(
                HEIGHT_BLOCK,
                `    const raw = typeof entry.height === 'number' ? entry.height : 0;
    const height = raw > 0 ? raw : DEFAULT_TOAST_HEIGHT;
`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '高度算成等价的内联写法');
  });
});
