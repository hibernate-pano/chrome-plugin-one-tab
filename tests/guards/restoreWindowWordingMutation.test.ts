/**
 * 变异自证：「按钮上写的窗口」与「实际开的窗口」必须一致 —— 这条守卫必须真的看得见破口。
 *
 * ── 2026-10-26：判据的**对象**换了（不是结论换了）─────────────────────────
 *
 * 撤销机制下线 ⇒ 恢复整组 / 点开单标签这两条**高频**路径**完全静默**
 * ⇒ 那条「已在新窗口打开 N 个标签页」的成功提示**整个消失**了
 * ⇒ 「开在哪个窗口」现在**只由按钮自己说**
 *   （「在当前窗口打开整个会话」/「在新窗口恢复整个会话」），
 *   而**行为**由那条 `OPEN_TABS` 请求里的 `inCurrentWindow` 决定。
 *
 * ⇒ 旧的三条变异（改文案分流 / 改提示函数的第二个参数 / 包一层 `Boolean`）
 *   **全部失去了对象** —— 它们动的是已经不存在的代码
 *   ⇒ 那样的变异连「变异前提」都不成立，守卫自然看不见它们。
 * ⇒ 现在改成打**新判据**的破口：按钮的 onClick 接线、以及请求里的那个布尔值。
 *
 * ── 三条变异分别打三个不同的破口 ──────────────────────────────────────────
 *
 * · 变异一 —— 说「当前窗口」的那颗按钮**接错了处理函数**（接到「新窗口」那个）
 *   ⇒ 必须变红（按钮说的与做的对不上 = 用户以为标签在眼前，结果跑去了别处）。
 * · 变异二 —— `OPEN_TABS` 请求**不带** `inCurrentWindow` ⇒ 必须变红
 *   （SW 只会新开窗 ⇒ 按钮在骗人）。
 * · 变异三 —— 请求里换成**等价的正确写法**（`Boolean(inCurrentWindow)`）
 *   ⇒ 必须**仍然绿**（守的是「参数跟着那个变量走」，不是逐字长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/restoreWindowWording.test.ts';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';

describe('变异自证：按钮说的窗口必须与实际开的窗口一致，这条守卫必须看得见破口', () => {
  it('变异一：说「当前窗口」的按钮接错处理函数 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「当前窗口」按钮接到「新窗口」那个处理函数',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const original = 'onClick={handleOpenAllTabsInCurrentWindow}';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到「在当前窗口打开」那颗按钮的 onClick');
              }
              return source.replace(original, 'onClick={handleOpenAllTabs}');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '它不是「在当前窗口打开」那个处理函数',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '「当前窗口」按钮接错处理函数');
  });

  it('变异二：OPEN_TABS 请求不带 inCurrentWindow ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '列表页的请求丢掉了 inCurrentWindow',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const original = 'data: { tabs: tabsPayload, inCurrentWindow }';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到那条 OPEN_TABS 请求');
              }
              return source.replace(original, 'data: { tabs: tabsPayload }');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '列表页的 OPEN_TABS 请求里没有 inCurrentWindow',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '请求丢掉了 inCurrentWindow');
  });

  it('变异三：请求里换成等价的正确写法 ⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '列表页把 inCurrentWindow 包一层 Boolean（等价）',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const original = 'data: { tabs: tabsPayload, inCurrentWindow }';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到那条 OPEN_TABS 请求');
              }
              return source.replace(
                original,
                'data: { tabs: tabsPayload, inCurrentWindow: Boolean(inCurrentWindow) }',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '请求里换成等价的正确写法');
  });
});
