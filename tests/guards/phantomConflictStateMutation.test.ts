/**
 * 变异自证：「代码不许承诺冲突检测」这条守卫必须真的看得见破口。
 *
 * ── 为什么这道文件单独存在 ────────────────────────────────────────────────
 * 守卫文件里的断言**全绿**只能说明「现在的实现是对的」，
 * 说明不了「这条断言有能力发现坏实现」——
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * ⇒ 这里把实现**改坏**，在沙箱里重跑**守卫自己**，要求它变红；
 * 再把实现换成**等价的正确写法**，要求它**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/phantomConflictState.test.ts';

describe('变异自证：DS-43-18 的守卫必须看得见破口', () => {
  it('变异一：类型里把 conflict 放回去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'syncStatus 联合类型里又出现 conflict',
        testFile: GUARD,
        targets: [
          {
            path: 'src/types/tab.ts',
            mutate: source =>
              source.replace(
                "syncStatus?: 'synced' | 'local-only' | 'remote-only';",
                "syncStatus?: 'synced' | 'local-only' | 'remote-only' | 'conflict';",
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '又出现了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 conflict 放回类型联合里');
  });

  it('变异二：stats 里把恒为 0 的 conflicts 放回去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'stats 里又出现 conflicts',
        testFile: GUARD,
        targets: [
          {
            path: 'src/services/syncEngine.ts',
            mutate: source =>
              source.replace(
                '    mergedCount: number;',
                '    mergedCount: number;\n    conflicts: number;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '恒为 0 的统计量',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把恒为 0 的 conflicts 统计量放回去');
  });

  it('变异三：把文档里的「没有任何提示」删掉 ⇒ 守卫必须变红（文档是替代品）', () => {
    const [outcome] = runMutationCases([
      {
        name: 'README 不再说明「没有任何提示」',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            // 必须**全部**替换：只改第一处的话，第二处还在 ⇒ 守卫不会红 ⇒ 假绿。
            mutate: source => source.split('且没有任何提示').join('并有同步提示'),
          },
        ],
        expectRed: true,
        expectedFailure: '必须说明冲突没有任何提示',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 README 里的「没有任何提示」改掉');
  });

  it('变异四：等价改写（换个写法但语义不变）⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：syncStatus 写成带换行的联合类型',
        testFile: GUARD,
        targets: [
          {
            path: 'src/types/tab.ts',
            mutate: source =>
              source.replace(
                "syncStatus?: 'synced' | 'local-only' | 'remote-only';",
                "syncStatus?:\n    | 'synced'\n    | 'local-only'\n    | 'remote-only';",
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把 syncStatus 联合类型换成多行写法（等价）');
  });
});
