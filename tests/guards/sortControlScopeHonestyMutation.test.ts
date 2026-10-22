/**
 * 变异自证：R-6 的守卫（排序控件不许骗人）必须真的看得见破口。
 *
 * ── 为什么这道文件单独存在 ────────────────────────────────────────────────
 * 守卫文件里的断言**全绿**只能说明「现在的实现是对的」，
 * 说明不了「这条断言有能力发现坏实现」——
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * ⇒ 这里把实现**改坏**，在沙箱里重跑**守卫自己**，要求它变红；
 * 再把实现换成**等价的正确写法**，要求它**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`（为什么不能就地改仓库里的文件）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/sortControlScopeHonesty.test.ts';

describe('变异自证：排序控件的「作用域」这条守卫必须看得见破口', () => {
  it('变异一：结果视图又摆上了排序控件（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '结果视图又摆上了排序控件',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            // 旧行为：两个渲染点都摆这个下拉 ⇒ 在结果视图里选了没反应。
            mutate: source => source.replace('showSortControl={false}', 'showSortControl={true}'),
          },
        ],
        expectRed: true,
        expectedFailure: '搜索结果：控件在不在',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把结果视图里的排序控件放回去（旧行为）');
  });

  it('变异二：列表不再按 sessionSort 排（控件还在）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '列表不按 sessionSort 排了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            // 「判据层算对了 ≠ 列表用了它」—— L-10 栽的就是这一脚。
            mutate: source =>
              source.replace('sortSessions(groups, sessionSort)', "sortSessions(groups, 'saved')"),
          },
        ],
        expectRed: true,
        expectedFailure: '主列表：控件在不在',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让列表不再按 sessionSort 排（控件还在）');
  });

  it('等价改写：换个 prop 名字（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '把 showSortControl 改名成 sortable',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/search/SearchFilterPanel.tsx',
            mutate: source => source.split('showSortControl').join('sortable'),
          },
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => source.split('showSortControl').join('sortable'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把「摆不摆排序控件」这个 prop 改名（渲染结果一模一样）'
    );
  });
});
