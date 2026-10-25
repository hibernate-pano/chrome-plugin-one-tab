/**
 * 变异自证：「恢复提示必须说清开在哪个窗口」这条守卫必须真的看得见破口。
 *
 * 三条变异分别打三个不同的破口：
 *
 * · 变异一 —— 文案**不看** `inCurrentWindow`（又写死成「新窗口」）⇒ 必须变红。
 * · 变异二 —— 接线处把第三个参数**写死**成 false ⇒ 必须变红
 *   （证明「接线」那半真的有检测力，而不是只看文案函数本身）。
 * · 变异三 —— 接线处换成**等价的正确写法**（`Boolean(inCurrentWindow)`）
 *   ⇒ 必须**仍然绿**（守的是「参数跟着那个变量走」，不是逐字长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/restoreWindowWording.test.ts';
const COPY = 'src/components/tabs/restoreFeedbackCopy.ts';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';

describe('变异自证：恢复提示必须说清「开在哪个窗口」，这条守卫必须看得见破口', () => {
  it('变异一：文案又写死成「新窗口」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '文案不再区分当前窗口 / 新窗口',
        testFile: GUARD,
        targets: [
          {
            path: COPY,
            mutate: source => {
              const original = `  const opened = inCurrentWindow
    ? \`已在当前窗口打开 \${tabCount} 个标签页\`
    : \`已在新窗口打开 \${tabCount} 个标签页\`;`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到那行「开在哪个窗口」的分流');
              }
              return source.replace(
                original,
                '  const opened = `已在新窗口打开 ${tabCount} 个标签页`;',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '开在当前窗口就必须这么说',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '文案又写死成「新窗口」');
  });

  it('变异二：接线处把第二个参数写死成 false ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '列表页把 inCurrentWindow 写死成 false',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const original =
                'restoreGroupSuccessMessage(tabsPayload.length, inCurrentWindow)';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到那个调用');
              }
              return source.replace(
                original,
                'restoreGroupSuccessMessage(tabsPayload.length, false)',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '那个「当前窗口」的提示',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '接线处把第二个参数写死成 false');
  });

  it('变异三：接线处换成等价的正确写法 ⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '列表页把 inCurrentWindow 包一层 Boolean（等价）',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            mutate: source => {
              const original =
                'restoreGroupSuccessMessage(tabsPayload.length, inCurrentWindow)';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到那个调用');
              }
              return source.replace(
                original,
                'restoreGroupSuccessMessage(tabsPayload.length, Boolean(inCurrentWindow))',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '接线处换成等价的正确写法');
  });
});
