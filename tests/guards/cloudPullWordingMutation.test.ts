/**
 * 变异自证：WC-13 的守卫（云端拉取这个动作不许用「恢复」）必须看得见破口。
 *
 * 三个方向：
 *   ① 把「恢复」放回出口标签（**旧行为**）⇒ 守卫必须变红；
 *   ② 另写一份字面量（脱离单源）⇒ 守卫必须变红；
 *   ③ **等价的正确写法**（常量改成模板串）⇒ 守卫必须**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/cloudPullWording.test.ts';

describe('变异自证：WC-13 的守卫必须看得见破口', () => {
  it('变异一：出口标签改回「从云端恢复会话」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '出口标签用回「恢复」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/domain/tabGroup/cloudPullCopy.ts',
            mutate: source => {
              const old = "export const CLOUD_PULL_ACTION_LABEL = '从云端拉回会话';";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到出口标签');
              return source.replace(
                old,
                "export const CLOUD_PULL_ACTION_LABEL = '从云端恢复会话';"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '不许用它',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把出口标签改回「从云端恢复会话」');
  });

  it('变异二：另写一份字面量（脱离单源）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '出口标签脱离 domain 层',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/emptyStateActions.ts',
            mutate: source => {
              const old = '  download: CLOUD_PULL_ACTION_LABEL,';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到出口标签赋值');
              return source.replace(old, "  download: '从云端拉回会话',");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '措辞会漂',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让空态出口脱离 domain 层那一份措辞');
  });

  it('变异三：等价改写（常量改成模板串）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '出口标签写成模板串',
        testFile: GUARD,
        targets: [
          {
            path: 'src/domain/tabGroup/cloudPullCopy.ts',
            mutate: source => {
              const old = "export const CLOUD_PULL_ACTION_LABEL = '从云端拉回会话';";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到出口标签');
              return source.replace(
                old,
                'export const CLOUD_PULL_ACTION_LABEL = `从云端${CLOUD_PULL_VERB}会话`;'
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把出口标签常量改成等价的模板串写法');
  });
});
