/**
 * 变异自证：搜索结果「组内行窗口化」的守卫必须真的看得见破口（2026-11-03）。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这些变异分别证明什么 ──────────────────────────────────────────────────
 *
 *   M1 窗口化组件不看可见性（永远渲染真行） ⇒ 「远端卡只留占位」变红
 *   M2 条数上限不再截断（整条结果都保留）     ⇒ 「结果卡数受上限约束」变红
 *   M3 占位高度改成一个与行距无关的数         ⇒ 「行数 × 行距」变红
 *   M4 卡上重新加回固定值的 contain-intrinsic-size ⇒ 「不许猜高度」变红
 *   M5 等价改写（两个分支换个顺序）           ⇒ 守卫**仍然绿**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/searchRowsWindowing.test.ts';
const ROWS_COMPONENT = 'src/components/search/SearchMatchRows.tsx';
const RESULT_LIST = 'src/components/search/SearchResultList.tsx';

describe('变异自证：搜索结果组内行窗口化', () => {
  it('M1：窗口化组件永远渲染真行 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'SearchMatchRows 忽略 renderRows',
        testFile: GUARD,
        targets: [
          {
            path: ROWS_COMPONENT,
            mutate: source => {
              const next = source.replace('{renderRows ? (', '{true ? (');
              if (next === source) throw new Error('变异前提没成立：找不到 renderRows 分支');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '远端结果卡不许挂载标签行',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让窗口化组件忽略可见性');
  });

  it('M2：条数上限不再截断 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'visibleSessionResults 去掉上限短路',
        testFile: GUARD,
        targets: [
          {
            path: RESULT_LIST,
            mutate: source => {
              const next = source.replace(
                '      if (used >= resultWindow.visible) break;\n',
                ''
              );
              if (next === source) throw new Error('变异前提没成立：找不到上限短路那一行');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '结果卡数量必须被上限截断',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让条数上限不再截断');
  });

  it('M3：占位高度与行距脱钩 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '占位高度改用命中行数（1 行 = 1px）',
        testFile: GUARD,
        targets: [
          {
            path: ROWS_COMPONENT,
            mutate: source => {
              const next = source.replace(
                'style={{ height: placeholderHeight }}',
                'style={{ height: count }}'
              );
              if (next === source) throw new Error('变异前提没成立：找不到占位高度');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '占位高度必须是「命中行数 × 行距」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让占位高度与行距脱钩');
  });

  it('M4：卡上重新加回固定值的高度估计 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '搜索结果卡恢复 contain-intrinsic-size: 240px',
        testFile: GUARD,
        targets: [
          {
            path: RESULT_LIST,
            mutate: source => {
              const next = source.replace(
                '            className="theme-radius-card theme-border-default theme-bg-elevated border p-3"\n',
                '            className="theme-radius-card theme-border-default theme-bg-elevated border p-3"\n' +
                  "            style={{ contentVisibility: 'auto', containIntrinsicSize: '240px' }}\n"
              );
              if (next === source) throw new Error('变异前提没成立：找不到搜索结果卡的 className');
              return next;
            },
          },
        ],
        expectRed: true,
        expectedFailure: '搜索结果卡不得用固定值的 contain-intrinsic-size',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把固定值的高度估计加回搜索卡');
  });

  it('等价改写：两个分支换个顺序 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'renderRows 分支改写成 !renderRows ? 占位 : 真行',
        testFile: GUARD,
        targets: [
          {
            path: ROWS_COMPONENT,
            mutate: source => {
              const original = `      {renderRows ? (
        renderMatches()
      ) : (
        /* 与主列表同一个占位约定（TabGroup 的行占位）：显式高度、非列表项角色。 */
        <div
          role="presentation"
          data-lazy-placeholder="true"
          style={{ height: placeholderHeight }}
        />
      )}`;
              const rewritten = `      {!renderRows ? (
        <div
          role="presentation"
          data-lazy-placeholder="true"
          style={{ height: placeholderHeight }}
        />
      ) : (
        renderMatches()
      )}`;
              const next = source.replace(original, rewritten);
              if (next === source) throw new Error('变异前提没成立：找不到完整的分支块');
              return next;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把两个分支换个顺序（语义不变）');
  });
});
