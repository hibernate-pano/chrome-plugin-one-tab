/**
 * 变异自证：搜索页这四条守卫必须真的看得见破口。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 * 每个方向都要证明两件事：
 *   · 把实现改回**旧行为** ⇒ 守卫必须变红（且红在**目标断言**上）；
 *   · 换成**等价的正确写法** ⇒ 守卫必须**仍然绿**（否则它钉的是长相）。
 *
 * 变异的沙箱见 `tests/_helpers/mutationSandbox.ts`（拷一份 src/tests 再变异，
 * 不动共享工作区 —— 别的 agent 正在同时改这些文件）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/searchViewHonesty.test.ts';

describe('变异自证 · SC-4（零结果页的出口）', () => {
  it('变异一：零结果页把出口藏起来（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '零结果页不渲染任何出口',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            // 旧行为：零结果页只有一句「请尝试其他关键词」，一个出口都没有。
            mutate: source =>
              source.replace(
                '{emptyStateActions.length > 0 && (',
                '{false && ('
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '零结果页渲染出来的出口必须与判据层一致',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让零结果页不再渲染空态出口');
  });

  it('变异二：出口「点了没反应也没提示」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '出口静默无反应',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchEmptyStateExits.ts',
            // 旧行为：做不到时什么都不说 ⇒ 用户以为按钮坏了。
            mutate: source =>
              source.replace(
                'notifyUnavailable: io.notifyUnavailable,',
                'notifyUnavailable: () => undefined,'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须出声一次',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让出口在做不到时静默无反应');
  });

  it('等价改写：判据的写法换一种（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'openAuth 的判空写法换一种',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchEmptyStateExits.ts',
            mutate: source =>
              source.replace(
                '...(io.openAuth ? { openAuth: io.openAuth } : {}),',
                '...(io.openAuth === undefined ? {} : { openAuth: io.openAuth }),'
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把 openAuth 的判空写法换一种（行为一模一样）');
  });
});

describe('变异自证 · WC-7（恢复按钮的后果说明）', () => {
  it('变异三：后果说明不看锁定态（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '后果说明恒定按未锁定说',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            // 旧行为：锁定会话的按钮也写着「会被移除」。
            mutate: source =>
              source.replace(
                'restoreOutcomeSentence(session.group.isLocked)',
                'restoreOutcomeSentence(false)'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '锁定会话的按钮必须说清「恢复后仍保留在列表中」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让恢复按钮的后果说明不看锁定态');
  });

  it('等价改写：提示的语序换一种 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '后果说明挪到句首',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source =>
              source.replace(
                '`在新窗口恢复整个会话，共 ${session.group.tabs.length} 个标签页（${restoreOutcome}）`',
                '`（${restoreOutcome}）在新窗口恢复整个会话，共 ${session.group.tabs.length} 个标签页`'
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把恢复按钮提示的语序换一种（行为一模一样）');
  });
});

describe('变异自证 · WC-12（同一个东西只许一个名字）', () => {
  it('变异四：把「标签页」改回「标签记录」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '删除确认框的正文改回「标签记录」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchBulkDelete.ts',
            mutate: source =>
              source.replace('个标签页（锁定会话除外）', '个标签记录（锁定会话除外）'),
          },
        ],
        expectRed: true,
        expectedFailure: '删除确认框里不许再出现「标签记录」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把删除确认框里的「标签页」改回「标签记录」');
  });

  it('变异五：单条删除的确认框改回「标签记录」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '单条删除的确认框改回「标签记录」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source =>
              source.replace('这是该会话的最后一条标签页', '这是该会话的最后一条标签记录'),
          },
        ],
        expectRed: true,
        expectedFailure: '搜索页的用户可见文案里不许再出现「标签记录」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把单条删除的确认框改回「标签记录」');
  });
});

describe('变异自证 · DS-43-13（计数必须等于真正会删的条数）', () => {
  it('变异六：计数回到「匹配总数」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '计数含锁定组',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchBulkDelete.ts',
            // 旧行为：确认框里的数字是匹配总数（含锁定组），执行时却跳过锁定组。
            mutate: source =>
              source.replace(
                'const count = planBulkDelete(matches).deletable.length;',
                'const count = matches.length;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '确认框里的数字必须等于真正会删的条数',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让确认框的计数回到含锁定组的总数');
  });

  it('变异七：删除集不再排除锁定组（两处一起错）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '锁定会话里的标签页也会被删',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchBulkDelete.ts',
            mutate: source =>
              source.replace(
                'const deletable = matches.filter(match => !match.group.isLocked);',
                'const deletable = matches;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '锁定会话里的标签页绝不能被删',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让批量删除不再跳过锁定会话里的标签页');
  });

  it('等价改写：删除集的算法换一种（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'filter 换成 for 循环',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/searchBulkDelete.ts',
            mutate: source =>
              source.replace(
                'const deletable = matches.filter(match => !match.group.isLocked);',
                'const deletable: T[] = [];\n' +
                  '  for (const match of matches) {\n' +
                  '    if (!match.group.isLocked) deletable.push(match);\n' +
                  '  }'
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把删除集的算法从 filter 换成 for（行为一模一样）');
  });
});
