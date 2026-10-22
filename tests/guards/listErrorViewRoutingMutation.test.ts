/**
 * 变异自证：SC-2 的守卫（整页错误视图按 errorSource 分流）必须看得见破口。
 *
 * 三个方向：
 *   ① 动作失败也用「加载失败」那套（**旧行为**）⇒ 守卫必须变红；
 *   ② 读路径失败丢掉「重新加载」⇒ 守卫必须变红；
 *   ③ **等价的正确写法** ⇒ 守卫必须**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/listErrorViewRouting.test.ts';

describe('变异自证：SC-2 的守卫必须看得见破口', () => {
  it('变异一：动作失败也走「加载失败」那套（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'action 来源不再分流',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/listErrorCopy.ts',
            mutate: source => {
              const old = "    if (input.errorSource === 'action') {";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 action 分流');
              return source.replace(old, '    if (false) {');
            },
          },
        ],
        expectRed: true,
        // 目标断言：判据层那条「'action' ⇒ 不给「重新加载」」。
        expectedFailure: "'action' ⇒ 不给「重新加载」",
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让动作失败也走「加载失败」那套文案与按钮');
  });

  it('变异二：读路径失败不给「重新加载」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'load 来源丢掉重新加载',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/listErrorCopy.ts',
            mutate: source => {
              const old = '        reloadable: true,';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 reloadable');
              return source.replace(old, '        reloadable: false,');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '唯一能重试的动作',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让读路径失败不再给「重新加载」');
  });

  it('变异三：等价改写（三元换成模板串拼接）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '标题的三元改成模板串',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/listErrorCopy.ts',
            mutate: source => {
              const old = `            title: timedOut
                ? \`\${copy.operation}还在处理中\`
                : \`\${copy.operation}没能完成\`,`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到标题写法');
              return source.replace(
                old,
                '            title: `${copy.operation}${timedOut ? \'还在处理中\' : \'没能完成\'}`,'
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把标题的三元表达式换成等价的模板串拼接');
  });
});
