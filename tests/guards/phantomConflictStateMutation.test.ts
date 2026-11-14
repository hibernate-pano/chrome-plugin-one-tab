/**
 * 变异自证：「冲突提示必须建在基线上、不许退回假统计量」这条守卫必须真的看得见破口。
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
  it('变异一：把 conflict 放回 syncStatus 联合类型 ⇒ 守卫必须变红', () => {
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

  it('变异二：把恒为 0 的 conflicts: number 假统计量放回去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'stats 里又出现 conflicts: number',
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
        expectedFailure: '假统计量',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把恒为 0 的 conflicts 统计量放回去');
  });

  it('变异三：把真实检测调用删掉（只留注释）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'syncEngine 不再调用 detectMergeConflicts',
        testFile: GUARD,
        targets: [
          {
            path: 'src/services/syncEngine.ts',
            mutate: source =>
              source.replace(
                'detectMergeConflicts(localGroups, cloudGroups, agreedStamps, winnerByGroupId)',
                '[] as MergeConflict[]',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须调用 detectMergeConflicts',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把基于基线的冲突检测删掉');
  });

  it('变异四：把文档里的「冲突提示」真话删掉 ⇒ 守卫必须变红（文档与代码同步）', () => {
    const [outcome] = runMutationCases([
      {
        name: 'README 不再说明会给出冲突提示',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            // 必须**全部**替换：只改第一处的话，别处还在 ⇒ 守卫不会红 ⇒ 假绿。
            mutate: source => source.split('冲突提示').join('同步结果说明'),
          },
        ],
        expectRed: true,
        expectedFailure: '必须说明现在会给出同步冲突提示',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 README 里的「冲突提示」改掉');
  });

  it('变异五：等价改写（换个写法但语义不变）⇒ 守卫必须仍然绿', () => {
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
