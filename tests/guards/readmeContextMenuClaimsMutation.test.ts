/**
 * 变异自证：「README 描述的右键菜单必须与真正注册的菜单项一致」这条守卫
 * 必须真的看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 README 写回那个**不存在的**「保存整窗」⇒ 「引用的菜单项必须真的注册过」
 *      那条真的会红
 *   M2 README 去掉「不含当前那个标签」那半句 ⇒ 「必须说清不含当前那个标签」
 *      那条真的会红
 *   M3 **事实来源**变了（菜单标题改了）⇒ 「README 与实现对不上」那条真的会红
 *   M4 等价改写（「不含」→「不包含」）⇒ 守卫**仍然绿**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/readmeContextMenuClaims.test.ts';

describe('变异自证：WC-11 右键菜单口径守卫必须看得见破口', () => {
  it('变异一：README 写回那个不存在的「保存整窗」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'README 又说有「保存整窗」这个菜单项',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            mutate: source =>
              source.replace(
                '右键菜单的「保存其他标签并关闭」都走 SW',
                '右键菜单的「保存整窗」都走 SW',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'README 引用了不存在的菜单项「保存整窗」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 README 引用一个从未注册过的菜单项');
  });

  it('变异二：README 去掉「不含当前那个标签」那半句 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'README 不再说明「不含当前那个标签」',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            mutate: source =>
              source.replace(
                '**「保存其他标签并关闭」不含当前那个标签**（它存的是当前窗口里除活动标签以外的其它标签），',
                '',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'README 必须说清「保存其他标签并关闭」**不含当前那个标签**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「不含当前那个标签」那半句从 README 里删掉');
  });

  it('变异三：事实来源变了（菜单标题改了）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '菜单标题换了一个字',
        testFile: GUARD,
        targets: [
          {
            path: 'src/service-worker.ts',
            mutate: source =>
              source.replace("title: '保存其他标签并关闭',", "title: '保存其它标签并关闭',"),
          },
        ],
        expectRed: true,
        expectedFailure: 'README 引用了不存在的菜单项「保存其他标签并关闭」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把实现里那个菜单项的标题改掉');
  });

  it('等价改写：「不含」→「不包含」⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：换个说法表达同一件事',
        testFile: GUARD,
        targets: [
          {
            path: 'README.md',
            mutate: source =>
              source.replace(
                '**「保存其他标签并关闭」不含当前那个标签**',
                '**「保存其他标签并关闭」不包含当前那个标签**',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把「不含当前那个标签」说成「不包含当前那个标签」');
  });
});
