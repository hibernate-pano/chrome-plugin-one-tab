/**
 * 变异自证：U-10「两枚『打开』图标不许看起来一样」必须真的看得见破口。
 *
 * 本仓的硬要求：**每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现改成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**。
 *
 * 四条变异分别打四个不同的破口：
 *
 * · 变异一 —— 图标换回 2026-10-24 那对（同形）⇒ 形状差那条必须变红。
 *   （「path 不完全相同」那条**不会**红 ⇒ 正好说明为什么需要那把尺子。）
 * · 变异二 —— accent 墨色换回「新窗口」那颗 ⇒ 主次那条必须变红。
 * · 变异三 —— 两颗按钮的位置对调 ⇒ 位置那条必须变红。
 * · 变异四 —— 把框从 `<path>` 改成 `<rect>`（**同一形状**、另一种写法）
 *   ⇒ 守卫必须**仍然绿**（守的是形状，不是「用哪种元素画的」）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/sessionCardActions.test.ts';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';

/** 2026-10-24 那对画法里的「在当前窗口打开」那一枚（与新窗口那枚几乎同形）。 */
const LEGACY_IN_PLACE_PATH =
  'M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5M21 3v5.25M21 3h-5.25M21 3l-7.5 7.5';

/** 现在那枚「在当前窗口打开」的两条 path（闭合框 + 框内向右的箭头）。 */
const CURRENT_IN_PLACE_PATHS = [
  'M15.75 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V8.25A2.25 2.25 0 0015.75 6z',
  'M6.75 13.5h7m0 0l-3-3m3 3l-3 3',
];

/** 找到某个 path 的 d 所在那一整行（含缩进），用于整行替换。 */
function pathLineOf(source: string, d: string): string {
  const index = source.indexOf(`d="${d}"`);
  if (index < 0) throw new Error(`变异前提没成立：找不到 path ${d.slice(0, 24)}…`);
  const lineStart = source.lastIndexOf('\n', index) + 1;
  const lineEnd = source.indexOf('\n', index);
  return source.slice(lineStart, lineEnd);
}

describe('变异自证：两枚「打开」图标不许看起来一样，这条守卫必须看得见破口', () => {
  it('变异一：图标换回同形的那一对 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「在当前窗口打开」的图标换回 2026-10-24 的旧画法',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              // 两条 path（框 + 箭头）整体换成 2026-10-24 的那一条（框 + 右上角小箭头）
              const frameLine = pathLineOf(source, CURRENT_IN_PLACE_PATHS[0]);
              const arrowLine = pathLineOf(source, CURRENT_IN_PLACE_PATHS[1]);
              return source
                .replace(
                  frameLine,
                  frameLine.replace(`d="${CURRENT_IN_PLACE_PATHS[0]}"`, `d="${LEGACY_IN_PLACE_PATH}"`),
                )
                .replace(arrowLine + '\n', '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '两枚「打开」图标的形状差只有',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '图标换回同形的那一对');
  });

  it('变异二：accent 墨色换回「新窗口」那颗 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'accent 墨色挂到「在新窗口恢复」那颗上',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const accent = 'btn-icon theme-btn-hover tab-group-action-accent micro-interaction-button';
              const plain = 'btn-icon theme-btn-hover micro-interaction-button';
              if (!source.includes(accent)) throw new Error('变异前提没成立：找不到 accent 那颗按钮');
              // 两处 class 互换：主操作降级、次操作升级
              return source
                .replace(accent, '__ACCENT__')
                .replace(plain, accent)
                .replace('__ACCENT__', plain);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须用 accent 墨色',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, 'accent 墨色换回「新窗口」那颗');
  });

  it('变异三：两颗按钮的位置对调 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「在新窗口恢复」排到「在当前窗口打开」前面',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const inPlaceLabel = 'aria-label={`在当前窗口打开整个会话';
              const newWindowLabel = 'aria-label={`在新窗口恢复整个会话';
              const aStart = source.lastIndexOf('<Tooltip', source.indexOf(inPlaceLabel));
              const aEnd = source.indexOf('</Tooltip>', source.indexOf(inPlaceLabel)) + '</Tooltip>'.length;
              const bStart = source.lastIndexOf('<Tooltip', source.indexOf(newWindowLabel));
              const bEnd = source.indexOf('</Tooltip>', source.indexOf(newWindowLabel)) + '</Tooltip>'.length;
              if (aStart < 0 || bStart < 0 || aEnd <= aStart || bEnd <= bStart) {
                throw new Error('变异前提没成立：找不到那两块 JSX');
              }
              const blockA = source.slice(aStart, aEnd);
              const blockB = source.slice(bStart, bEnd);
              return (
                source.slice(0, aStart) +
                blockB +
                source.slice(aEnd, bStart) +
                blockA +
                source.slice(bEnd)
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须排在',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '两颗按钮的位置对调');
  });

  it('变异四：框从 <path> 改成 <rect>（同一形状）⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '「在当前窗口打开」的框改用 <rect> 画',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              // 同一个框（(3,6)-(18,21)、圆角 2.25），只是改用 <rect> 元素画。
              const frameLine = pathLineOf(source, CURRENT_IN_PLACE_PATHS[0]);
              return source.replace(
                frameLine,
                '    <rect x="3" y="6" width="15" height="15" rx="2.25" />',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '框改用 <rect> 画（同一形状）');
  });
});
